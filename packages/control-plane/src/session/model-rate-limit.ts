import type { SqlStorage } from "./sql-storage";

/**
 * Model rate-limit retry (Workers AI code 3021 / HTTP 429).
 *
 * The harness already retries a throttled model call a few times (~1 min),
 * then fails the turn. With many sessions sharing one per-account model
 * limit (Workers AI frontier models: 20 requests/min) that budget runs out,
 * so the control plane takes over: the turn's message goes back to pending
 * and is re-dispatched to the same sandbox after a jittered exponential
 * backoff, instead of failing the session (and the automation run).
 */

export const MODEL_RATE_LIMIT_MAX_RETRIES = 8;
export const MODEL_RATE_LIMIT_BASE_DELAY_MS = 15_000;
/**
 * Kept below the sandbox inactivity timeout (90 s on oi-test) so a waiting
 * sandbox is not stopped as idle between attempts.
 */
export const MODEL_RATE_LIMIT_MAX_DELAY_MS = 60_000;
export const MODEL_RATE_LIMIT_JITTER = 0.25;

const RATE_LIMIT_PATTERNS: readonly RegExp[] = [
  /"code"\s*:\s*3021\b/,
  /\btoo many requests\b/i,
  /\brate[ _-]?limit(?:ed|ing)?\b/i,
  /inference request per min/i,
  /\b(?:status|http|code)[ :=]*429\b/i,
  /^429\b/,
];

/** True when a failed turn's error text says the model provider throttled it. */
export function isModelRateLimitError(error: string | null | undefined): boolean {
  if (!error) return false;
  return RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(error));
}

/** A Retry-After hint in the error text, in ms (seconds or `retry-after-ms`). */
export function parseRetryAfterMs(error: string | null | undefined): number | null {
  if (!error) return null;
  const ms = /retry[-_ ]after[-_ ]ms["']?\s*[:=]\s*["']?(\d+(?:\.\d+)?)/i.exec(error);
  if (ms) return Math.ceil(Number(ms[1]));
  const seconds = /retry[-_ ]after["']?\s*[:=]?\s*["']?(\d+(?:\.\d+)?)/i.exec(error);
  if (seconds) return Math.ceil(Number(seconds[1]) * 1000);
  return null;
}

/**
 * Delay before retry `attempt` (1-based): Retry-After when the provider gave
 * one, else base * 2^(attempt-1) with +/- jitter; always capped.
 */
export function modelRateLimitDelayMs(
  attempt: number,
  error?: string | null,
  random: () => number = Math.random
): number {
  const retryAfter = parseRetryAfterMs(error);
  if (retryAfter !== null)
    return Math.min(Math.max(retryAfter, 1_000), MODEL_RATE_LIMIT_MAX_DELAY_MS);
  const base = MODEL_RATE_LIMIT_BASE_DELAY_MS * 2 ** Math.max(0, attempt - 1);
  const jitter = 1 + MODEL_RATE_LIMIT_JITTER * (2 * random() - 1);
  return Math.min(Math.round(base * jitter), MODEL_RATE_LIMIT_MAX_DELAY_MS);
}

/** Prepended to a re-dispatched prompt so the agent continues rather than restarts. */
export const MODEL_RATE_LIMIT_RETRY_NOTE =
  "[System note: your previous attempt at this request was interrupted because the model " +
  "provider rate-limited it. Continue from where you left off; do not redo steps that are " +
  "already done.]\n\n";

export interface ModelRateLimitRetryState {
  attempts: number;
  retryAt: number;
}

/**
 * Per-message retry bookkeeping in the session's SQLite. The table is created
 * on first use (no migration id), so rolling back the worker leaves only an
 * unused table behind.
 */
export class ModelRateLimitRetryStore {
  private ready = false;

  constructor(private readonly sql: SqlStorage) {}

  private ensure(): void {
    if (this.ready) return;
    this.sql.exec(
      `CREATE TABLE IF NOT EXISTS model_rate_limit_retries (
         message_id TEXT PRIMARY KEY,
         attempts INTEGER NOT NULL,
         retry_at INTEGER NOT NULL
       )`
    );
    this.ready = true;
  }

  get(messageId: string): ModelRateLimitRetryState | null {
    this.ensure();
    const rows = this.sql
      .exec(
        `SELECT attempts, retry_at FROM model_rate_limit_retries WHERE message_id = ?`,
        messageId
      )
      .toArray() as Array<{ attempts: number; retry_at: number }>;
    const row = rows[0];
    return row ? { attempts: Number(row.attempts), retryAt: Number(row.retry_at) } : null;
  }

  record(messageId: string, attempts: number, retryAt: number): void {
    this.ensure();
    this.sql.exec(
      `INSERT INTO model_rate_limit_retries (message_id, attempts, retry_at) VALUES (?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET attempts = excluded.attempts, retry_at = excluded.retry_at`,
      messageId,
      attempts,
      retryAt
    );
  }
}

/**
 * Decide whether a failed turn should be retried. Returns the next attempt
 * number and when it is due, or null when the failure is not a rate limit or
 * the retry budget is spent (the turn then fails as before).
 */
export function planModelRateLimitRetry(
  error: string | null | undefined,
  previousAttempts: number,
  now: number,
  random: () => number = Math.random
): ModelRateLimitRetryState | null {
  if (!isModelRateLimitError(error)) return null;
  if (previousAttempts >= MODEL_RATE_LIMIT_MAX_RETRIES) return null;
  const attempts = previousAttempts + 1;
  return { attempts, retryAt: now + modelRateLimitDelayMs(attempts, error, random) };
}

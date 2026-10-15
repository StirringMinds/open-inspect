import { describe, expect, it, vi } from "vitest";
import type { SandboxEvent } from "@open-inspect/shared/types/sandbox-events";
import {
  isModelRateLimitError,
  modelRateLimitDelayMs,
  parseRetryAfterMs,
  planModelRateLimitRetry,
  MODEL_RATE_LIMIT_MAX_DELAY_MS,
  MODEL_RATE_LIMIT_MAX_RETRIES,
} from "./model-rate-limit";
import { SandboxExecutionEventHandler } from "./sandbox-events/execution.handler";
import type { MessageRepository } from "./message-repository";
import type { CallbackNotificationService } from "./callback-notification-service";
import type { SessionStatusService } from "./session-status-service";
import type { Logger } from "../logger";
import type { BackgroundTasks } from "../platform-ports";

// The exact failure text oi-test recorded on 2026-10-14 (automation_runs.failure_reason).
const WORKERS_AI_3021 =
  'Too Many Requests: {"errors":[{"message":"AiError: AiError: rate limiting: inference request per min rate reached (45c541bf-3369-4a17-818a-9e814fc3ddc7)","code":3021}],"success":false,"result":{},"messages":[]}';

describe("isModelRateLimitError", () => {
  it("recognises the Workers AI 3021 failure and generic 429s", () => {
    expect(isModelRateLimitError(WORKERS_AI_3021)).toBe(true);
    expect(isModelRateLimitError("Too Many Requests")).toBe(true);
    expect(isModelRateLimitError("429 Too Many Requests")).toBe(true);
    expect(isModelRateLimitError("Rate limit exceeded, please slow down")).toBe(true);
  });

  it("leaves other failures alone", () => {
    for (const error of [
      undefined,
      "",
      "Sandbox failed to connect within the allowed time after repeated attempts.",
      "Context window exceeded",
      "Execution timed out",
      "fatal: could not read Username for 'https://github.com'",
      "Error at line 4290 of build.log",
    ]) {
      expect(isModelRateLimitError(error)).toBe(false);
    }
  });
});

describe("modelRateLimitDelayMs", () => {
  it("backs off exponentially with jitter and a cap", () => {
    expect(modelRateLimitDelayMs(1, null, () => 0.5)).toBe(15_000);
    expect(modelRateLimitDelayMs(2, null, () => 0.5)).toBe(30_000);
    expect(modelRateLimitDelayMs(3, null, () => 0.5)).toBe(MODEL_RATE_LIMIT_MAX_DELAY_MS);
    expect(modelRateLimitDelayMs(1, null, () => 0)).toBe(11_250);
    expect(modelRateLimitDelayMs(1, null, () => 1)).toBe(18_750);
    expect(modelRateLimitDelayMs(8, null, () => 1)).toBe(MODEL_RATE_LIMIT_MAX_DELAY_MS);
  });

  it("honours Retry-After when the provider sends one", () => {
    expect(parseRetryAfterMs('{"retry-after":"7"}')).toBe(7_000);
    expect(parseRetryAfterMs("retry-after-ms: 2500")).toBe(2_500);
    expect(parseRetryAfterMs(WORKERS_AI_3021)).toBeNull();
    expect(modelRateLimitDelayMs(5, "429 Too Many Requests retry-after: 7", () => 0.5)).toBe(7_000);
    expect(modelRateLimitDelayMs(1, "Too Many Requests retry-after: 600", () => 0.5)).toBe(
      MODEL_RATE_LIMIT_MAX_DELAY_MS
    );
  });
});

describe("planModelRateLimitRetry", () => {
  it("plans retries until the budget is spent", () => {
    expect(planModelRateLimitRetry(WORKERS_AI_3021, 0, 1_000, () => 0.5)).toEqual({
      attempts: 1,
      retryAt: 16_000,
    });
    expect(
      planModelRateLimitRetry(WORKERS_AI_3021, MODEL_RATE_LIMIT_MAX_RETRIES - 1, 0)
    ).not.toBeNull();
    expect(planModelRateLimitRetry(WORKERS_AI_3021, MODEL_RATE_LIMIT_MAX_RETRIES, 0)).toBeNull();
    expect(planModelRateLimitRetry("Execution timed out", 0, 0)).toBeNull();
  });
});

type ExecutionComplete = Extract<SandboxEvent, { type: "execution_complete" }>;

function harness() {
  const retries = new Map<string, { attempts: number; retryAt: number }>();
  const repository = {
    recordMessageCompletion: vi.fn(() => ({
      messageId: "msg-1",
      messageCreatedAt: 0,
      completedAt: 1,
      messageStartedAt: 0,
      status: "failed",
    })),
    clearMessageAwaitingStopConfirmation: vi.fn(),
    updateMessageToPending: vi.fn(),
    getMessageContent: vi.fn(() => null),
    getProcessingMessage: vi.fn(() => null),
  };
  const callbackService = { notifyComplete: vi.fn(async () => {}) };
  const sessionStatus = { reconcileAfterExecution: vi.fn(async () => {}) };
  const broadcast = vi.fn();
  const scheduleAlarm = vi.fn(async () => {});
  const processQueue = vi.fn(async () => {});
  const budget = {
    observeExecutionCost: vi.fn(() => null),
    deliverTransition: vi.fn(async () => {}),
  };
  const backgroundTasks = { submit: (fn: () => Promise<void>) => void fn() };
  const log = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() };
  const handler = new SandboxExecutionEventHandler(
    backgroundTasks as unknown as BackgroundTasks,
    log as unknown as Logger,
    repository as unknown as MessageRepository,
    callbackService as unknown as CallbackNotificationService,
    { broadcast, sendToSandbox: async () => {} },
    async () => {},
    sessionStatus as unknown as SessionStatusService,
    async () => {},
    () => {},
    async () => {},
    processQueue,
    () => {},
    budget as never,
    (closure) => closure(),
    () => {},
    {
      get: (id: string) => retries.get(id) ?? null,
      record: (id: string, attempts: number, retryAt: number) => {
        retries.set(id, { attempts, retryAt });
      },
    },
    scheduleAlarm,
    () => 0.5
  );
  return {
    handler,
    retries,
    repository,
    callbackService,
    sessionStatus,
    broadcast,
    scheduleAlarm,
    budget,
  };
}

function failed(error: string): ExecutionComplete {
  return {
    type: "execution_complete",
    messageId: "msg-1",
    success: false,
    error,
    sandboxId: "sb",
    timestamp: 1,
  } as ExecutionComplete;
}

const context = { now: 100_000, messageId: "msg-1", processingMessage: { id: "msg-1" } };

describe("SandboxExecutionEventHandler model rate-limit retry", () => {
  it("defers a rate-limited turn: back to pending, alarm armed, no failure callback", async () => {
    const h = harness();
    await h.handler.handleExecutionComplete(failed(WORKERS_AI_3021), context);

    expect(h.repository.updateMessageToPending).toHaveBeenCalledWith("msg-1");
    expect(h.retries.get("msg-1")).toEqual({ attempts: 1, retryAt: 115_000 });
    expect(h.scheduleAlarm).toHaveBeenCalledWith(115_000);
    expect(h.budget.observeExecutionCost).toHaveBeenCalledTimes(1);
    expect(h.repository.recordMessageCompletion).not.toHaveBeenCalled();
    expect(h.callbackService.notifyComplete).not.toHaveBeenCalled();
    expect(h.sessionStatus.reconcileAfterExecution).not.toHaveBeenCalled();
    expect(h.broadcast).toHaveBeenCalledWith(expect.objectContaining({ type: "sandbox_warning" }));
  });

  it("fails the turn as before once the retry budget is spent", async () => {
    const h = harness();
    h.retries.set("msg-1", { attempts: MODEL_RATE_LIMIT_MAX_RETRIES, retryAt: 0 });
    await h.handler.handleExecutionComplete(failed(WORKERS_AI_3021), context);

    expect(h.repository.updateMessageToPending).not.toHaveBeenCalled();
    expect(h.repository.recordMessageCompletion).toHaveBeenCalledTimes(1);
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith("msg-1", false, WORKERS_AI_3021);
  });

  it("does not retry ordinary failures", async () => {
    const h = harness();
    await h.handler.handleExecutionComplete(failed("Execution timed out"), context);

    expect(h.repository.updateMessageToPending).not.toHaveBeenCalled();
    expect(h.scheduleAlarm).not.toHaveBeenCalled();
    expect(h.callbackService.notifyComplete).toHaveBeenCalledWith(
      "msg-1",
      false,
      "Execution timed out"
    );
  });

  it("does not retry a turn that is no longer the processing message (stopped)", async () => {
    const h = harness();
    await h.handler.handleExecutionComplete(failed(WORKERS_AI_3021), {
      ...context,
      processingMessage: null,
    });
    expect(h.repository.updateMessageToPending).not.toHaveBeenCalled();
  });
});

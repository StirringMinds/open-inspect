/**
 * Operator admin API key: `Authorization: Bearer <ADMIN_API_KEY>`.
 *
 * A match authenticates as the configured canonical user
 * (ADMIN_API_KEY_USER_ID), so every downstream role/permission check applies
 * to that user. A non-matching or absent bearer returns null so other schemes
 * (e.g. sandbox tokens) still get their chance.
 */
import { timingSafeEqual } from "@open-inspect/shared/auth";
import type { AuthResult } from "./result";
import type { Env } from "../types";

const MIN_KEY_LENGTH = 32;

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

export async function authenticateAdminApiKey(
  request: Request,
  env: Pick<Env, "ADMIN_API_KEY" | "ADMIN_API_KEY_USER_ID">
): Promise<AuthResult | null> {
  const key = env.ADMIN_API_KEY;
  const userId = env.ADMIN_API_KEY_USER_ID;
  if (!key || key.length < MIN_KEY_LENGTH || !userId) return null;
  const header = request.headers.get("Authorization");
  if (!header || !header.startsWith("Bearer ")) return null;
  const presented = header.slice("Bearer ".length).trim();
  if (!presented) return null;
  // Compare fixed-length digests so neither content nor length leaks via timing.
  const [a, b] = await Promise.all([sha256Hex(presented), sha256Hex(key)]);
  if (!timingSafeEqual(a, b)) return null;
  return { principal: { kind: "user", userId }, request };
}

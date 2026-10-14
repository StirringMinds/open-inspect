import { describe, expect, it } from "vitest";
import { authenticateAdminApiKey } from "./admin-api-key";

const KEY = "k".repeat(48);
const env = { ADMIN_API_KEY: KEY, ADMIN_API_KEY_USER_ID: "user-1" };
const req = (auth?: string) =>
  new Request("https://cp.test/automations", { headers: auth ? { Authorization: auth } : {} });

describe("authenticateAdminApiKey", () => {
  it("accepts the configured key as the admin user", async () => {
    const r = await authenticateAdminApiKey(req(`Bearer ${KEY}`), env);
    expect(r && "principal" in r ? r.principal : null).toEqual({ kind: "user", userId: "user-1" });
  });
  it("ignores wrong, missing, or non-bearer credentials", async () => {
    expect(await authenticateAdminApiKey(req(`Bearer ${KEY}x`), env)).toBeNull();
    expect(await authenticateAdminApiKey(req(), env)).toBeNull();
    expect(await authenticateAdminApiKey(req(`Basic ${KEY}`), env)).toBeNull();
  });
  it("is disabled when unconfigured or the key is too short", async () => {
    expect(await authenticateAdminApiKey(req(`Bearer ${KEY}`), { ADMIN_API_KEY: KEY })).toBeNull();
    expect(
      await authenticateAdminApiKey(req("Bearer short"), {
        ADMIN_API_KEY: "short",
        ADMIN_API_KEY_USER_ID: "u",
      })
    ).toBeNull();
  });
});

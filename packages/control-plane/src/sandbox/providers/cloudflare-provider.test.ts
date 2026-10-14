import { describe, it, expect, vi } from "vitest";
import { CloudflareSandboxProvider, isCloudflareCapacityError } from "./cloudflare-provider";
import { SandboxCapacityError } from "../provider";

const AT_CAP =
  "Maximum number of running container instances exceeded. Try again later, or try configuring a higher value for max_instances";
const NO_PLACEMENT =
  "There is no container instance that can be provided to this Durable Object, try again later";

function fakeContainer(overrides: Record<string, unknown> = {}) {
  return {
    start: vi.fn(async () => undefined),
    setInactivityTimeout: vi.fn(async () => undefined),
    destroy: vi.fn(async () => undefined),
    ...overrides,
  };
}

function providerFor(container: ReturnType<typeof fakeContainer>) {
  const env = { Sandbox: { idFromName: (name: string) => name, get: () => container } };
  return new CloudflareSandboxProvider(env as never, { scmProvider: "github" } as never);
}

const config = {
  sandboxId: "sandbox-1",
  sessionId: "session-1",
  repoOwner: "owner",
  repoName: "repo",
  controlPlaneUrl: "https://cp.example",
  sandboxAuthToken: "token",
  provider: "workers-ai",
  model: "m",
  timeoutSeconds: 600,
} as never;

describe("CloudflareSandboxProvider capacity", () => {
  it("recognises Cloudflare's at-capacity answers", () => {
    expect(isCloudflareCapacityError(new Error(AT_CAP))).toBe(true);
    expect(isCloudflareCapacityError(new Error(NO_PLACEMENT))).toBe(true);
    expect(isCloudflareCapacityError(new Error("network reset"))).toBe(false);
  });

  it("throws SandboxCapacityError (not success) when the cap surfaces after start()", async () => {
    const container = fakeContainer({
      setInactivityTimeout: vi.fn(async () => {
        throw new Error(AT_CAP);
      }),
    });
    await expect(providerFor(container).createSandbox(config)).rejects.toBeInstanceOf(
      SandboxCapacityError
    );
    expect(container.destroy).toHaveBeenCalledOnce();
  });

  it("throws SandboxCapacityError when start() itself is refused at capacity", async () => {
    const container = fakeContainer({
      start: vi.fn(async () => {
        throw new Error(NO_PLACEMENT);
      }),
    });
    await expect(providerFor(container).createSandbox(config)).rejects.toBeInstanceOf(
      SandboxCapacityError
    );
  });

  it("still succeeds when setInactivityTimeout fails for another reason", async () => {
    const container = fakeContainer({
      setInactivityTimeout: vi.fn(async () => {
        throw new Error("rpc hiccup");
      }),
    });
    await expect(providerFor(container).createSandbox(config)).resolves.toMatchObject({
      sandboxId: "sandbox-1",
    });
    expect(container.destroy).not.toHaveBeenCalled();
  });
});

/**
 * Cloudflare sandbox provider.
 *
 * Uses Cloudflare's container-backed Durable Objects to host a sandbox
 * runtime. Each sandbox is a distinct container instance; the control plane
 * starts the container with the supervisor entrypoint and lets the runtime
 * bridge phone home over WebSocket.
 *
 * This is a first-cut wiring: snapshots, restore, persistent resume, and
 * image builds are not implemented.
 */

import { supportsConfigurableSandboxTimeout } from "@open-inspect/shared/types/integrations";
import type { Container } from "@cloudflare/workers-types";
import type { CloudflareSandboxNamespace } from "../../cloudflare/sandbox-namespace";
import type { SourceControlProviderName } from "../../source-control";
import { buildSandboxEnvVars, scmCloneIdentity } from "../sandbox-env";
import {
  DEFAULT_SANDBOX_TIMEOUT_SECONDS,
  SandboxProviderError,
  SandboxCapacityError,
  type CreateSandboxConfig,
  type CreateSandboxResult,
  type SandboxLifetime,
  type SandboxProvider,
  type SandboxProviderCapabilities,
  type StopConfig,
  type StopResult,
} from "../provider";
import type { Env } from "../../types";
import { createLogger } from "../../logger";

const log = createLogger("cloudflare-provider");

const CAPACITY_ERROR_PATTERN =
  /maximum number of running container instances exceeded|no container instance that can be provided/i;

/** Cloudflare's at-capacity answers (max_instances reached, or no instance free to place). */
export function isCloudflareCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return CAPACITY_ERROR_PATTERN.test(message);
}

export interface CloudflareProviderConfig {
  scmProvider: SourceControlProviderName;
  /**
   * Optional runtime container instance inactivity timeout. Cloudflare keeps the
   * container alive while requests are active; a short timeout lets idle
   * containers hibernate without provider-side resume.
   */
  inactivityTimeoutMs?: number;
}

type CloudflareSandboxBinding = CloudflareSandboxNamespace;

/** Treat the namespace stub as a Cloudflare Container instance. */
function getContainer(binding: CloudflareSandboxBinding, sandboxId: string): Container {
  const id = binding.idFromName(sandboxId);
  const stub = binding.get(id);
  return stub as unknown as Container;
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly name = "cloudflare";

  readonly capabilities: SandboxProviderCapabilities = {
    supportsSandboxTimeout: supportsConfigurableSandboxTimeout(this.name),
    supportsSnapshots: false,
    supportsRestore: false,
    supportsPersistentResume: false,
    supportsExplicitStop: true,
  };

  constructor(
    private readonly env: Env,
    private readonly providerConfig: CloudflareProviderConfig
  ) {}

  private getSandboxBinding(): CloudflareSandboxBinding {
    const binding = this.env.Sandbox;
    if (!binding) {
      throw new SandboxProviderError(
        "Sandbox binding not configured. Add 'Sandbox' to the control plane Durable Object bindings and deploy with enable_durable_object_bindings=true.",
        "permanent"
      );
    }
    return binding;
  }

  async createSandbox(config: CreateSandboxConfig): Promise<CreateSandboxResult> {
    try {
      const binding = this.getSandboxBinding();
      const container = getContainer(binding, config.sandboxId);

      const identity = scmCloneIdentity(this.providerConfig.scmProvider);
      const envVars = buildSandboxEnvVars(config, { scmIdentity: identity });

      // Pass the Cloudflare account id and the control plane's Cloudflare token
      // into the sandbox so the OpenCode harness can use Cloudflare Workers AI.
      if (this.env.CF_ACCOUNT_ID) {
        envVars.CLOUDFLARE_ACCOUNT_ID = this.env.CF_ACCOUNT_ID;
      }
      if (this.env.CLOUDFLARE_API_KEY) {
        envVars.CLOUDFLARE_API_KEY = this.env.CLOUDFLARE_API_KEY;
      }
      // Workers AI models need a Cloudflare account id scoped to the request.
      if (this.env.CLOUDFLARE_ACCOUNT_ID) {
        envVars.CLOUDFLARE_ACCOUNT_ID = this.env.CLOUDFLARE_ACCOUNT_ID;
      }

      // Container startup receives the sandbox-runtime entrypoint. The runtime
      // boots the repo/harness and opens the bridge back to the control plane.
      // Cloudflare container labels reject keys or values longer than Docker's
      // legacy limit; omit them until we know the exact constraint.
      await container.start({
        entrypoint: ["/opt/openinspect/python/bin/python", "-m", "sandbox_runtime.entrypoint"],
        enableInternet: true,
        env: envVars,
      });

      // Give the container a bounded idle timeout matching the requested session
      // lifetime so it hibernates instead of leaking.
      const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
      try {
        await container.setInactivityTimeout(timeoutSeconds * 1000);
      } catch (error) {
        // Cloudflare does not reject start() at capacity; the refusal surfaces on
        // the next container call. Without this check the spawn "succeeded", the
        // bridge never connected, and the session failed ~12 min later.
        if (isCloudflareCapacityError(error)) {
          await container.destroy().catch(() => undefined);
          throw new SandboxCapacityError(
            "All sandboxes are busy (container max_instances reached); queued until one frees up",
            error instanceof Error ? error : undefined
          );
        }
        log.warn("cloudflare.set_inactivity_timeout_failed", {
          sandbox_id: config.sandboxId,
          error: error instanceof Error ? error.message : String(error),
        });
      }

      return {
        sandboxId: config.sandboxId,
        providerObjectId: config.sandboxId,
        createdAt: Date.now(),
        lifetime: this.lifetimeFromTimeout(timeoutSeconds),
      };
    } catch (error) {
      this.logSpawnError(error);
      throw this.classifyError("Failed to create Cloudflare sandbox", error);
    }
  }

  private logSpawnError(error: unknown): void {
    if (error instanceof Error) {
      log.warn("cloudflare.create_sandbox_failed", {
        error: error.message,
        stack: error.stack,
        cause:
          error.cause instanceof Error
            ? error.cause.message
            : String((error as Error & { cause?: unknown }).cause),
      });
    } else {
      log.warn("cloudflare.create_sandbox_failed", { error: String(error) });
    }
  }

  async stopSandbox(config: StopConfig): Promise<StopResult> {
    try {
      const binding = this.getSandboxBinding();
      const container = getContainer(binding, config.providerObjectId);
      await container.destroy();
      return { success: true };
    } catch (error) {
      log.warn("cloudflare.stop_failed", {
        provider_object_id: config.providerObjectId,
        intent: config.intent,
        error: error instanceof Error ? error.message : String(error),
      });
      // A missing container is already gone; treat as success for destroy intent.
      if (config.intent === "destroy") return { success: true };
      return { success: false, error: "Failed to stop Cloudflare sandbox" };
    }
  }

  private lifetimeFromTimeout(timeoutSeconds: number): SandboxLifetime {
    const observedAtMs = Date.now();
    return {
      kind: "finite",
      expiresAtMs: observedAtMs + timeoutSeconds * 1000,
      observedAtMs,
      source: "conservative_start_bound",
    };
  }

  private classifyError(
    message: string,
    error: unknown
  ): SandboxProviderError | SandboxCapacityError {
    if (error instanceof SandboxProviderError || error instanceof SandboxCapacityError)
      return error;
    if (isCloudflareCapacityError(error)) {
      return new SandboxCapacityError(
        "All sandboxes are busy (container max_instances reached); queued until one frees up",
        error instanceof Error ? error : undefined
      );
    }
    if (error instanceof Error && error.message.toLowerCase().includes("binding")) {
      return new SandboxProviderError(`${message}: ${error.message}`, "permanent", error);
    }
    return SandboxProviderError.fromFetchError(message, error);
  }
}

export function createCloudflareProvider(
  env: Env,
  providerConfig: CloudflareProviderConfig
): CloudflareSandboxProvider {
  return new CloudflareSandboxProvider(env, providerConfig);
}

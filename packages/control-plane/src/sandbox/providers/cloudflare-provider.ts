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

      // Container startup receives the supervisor entrypoint. The supervisor
      // clones the repo, starts OpenCode, and starts the bridge.
      container.start({
        entrypoint: ["node", "/app/supervisor.js"],
        enableInternet: true,
        env: envVars,
        labels: {
          openinspect_framework: "open-inspect",
          openinspect_session_id: config.sessionId,
          openinspect_sandbox_id: config.sandboxId,
        },
      });

      // Give the container a bounded idle timeout matching the requested session
      // lifetime so it hibernates instead of leaking.
      const timeoutSeconds = config.timeoutSeconds ?? DEFAULT_SANDBOX_TIMEOUT_SECONDS;
      try {
        await container.setInactivityTimeout(timeoutSeconds * 1000);
      } catch (error) {
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
      throw this.classifyError("Failed to create Cloudflare sandbox", error);
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

  private classifyError(message: string, error: unknown): SandboxProviderError {
    if (error instanceof SandboxProviderError) return error;
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

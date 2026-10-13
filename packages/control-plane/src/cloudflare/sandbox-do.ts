import { DurableObject } from "cloudflare:workers";
import type {
  Container,
  ContainerStartupOptions,
  DurableObjectState,
} from "@cloudflare/workers-types";

/**
 * Cloudflare container sandbox Durable Object.
 *
 * Cloudflare's container platform exposes the real container lifecycle on
 * `this.ctx.container` inside the DO. The control plane driver treats the DO
 * stub as a remote {@link Container} and calls start / setInactivityTimeout /
 * destroy over RPC, so this class mirrors the parts of the Container API that
 * the provider needs.
 */
export class Sandbox extends DurableObject<unknown> {
  private readonly container: Container;

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env);
    const container = ctx.container;
    if (!container) {
      throw new Error("Sandbox DO requires the container binding");
    }
    this.container = container;
  }

  // RPC-exposed wrappers around the container lifecycle. Public async class
  // methods are automatically available on the DO stub; callers may `await`
  // them over RPC even when the underlying Container API is synchronous.
  async start(options?: ContainerStartupOptions): Promise<void> {
    return this.container.start(options);
  }

  async setInactivityTimeout(durationMs: number | bigint): Promise<void> {
    return this.container.setInactivityTimeout(durationMs);
  }

  async destroy(error?: unknown): Promise<void> {
    return this.container.destroy(error);
  }

  async monitor(): Promise<void> {
    return this.container.monitor();
  }

  get running(): boolean {
    return this.container.running;
  }
}

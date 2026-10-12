import { DurableObject } from "cloudflare:workers";

/**
 * Cloudflare container sandbox Durable Object placeholder.
 *
 * Cloudflare's container platform uses a Durable Object class named in the
 * worker's configuration as the lifecycle anchor for container instances.
 * The actual process/container behavior is provided by the platform; this
 * class satisfies the deployment contract so the worker can expose the
 * binding. The control plane does not run application logic here.
 */
export class Sandbox extends DurableObject<unknown> {}

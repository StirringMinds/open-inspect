import type { DurableObjectNamespace } from "@cloudflare/workers-types";

/**
 * Platform type alias for the Cloudflare container sandbox binding.
 *
 * Centralizing the `DurableObjectNamespace` import here lets non-cloudflare
 * modules depend on a named port type without directly referencing binding
 * types outside the allowed file set.
 */
export type CloudflareSandboxNamespace = DurableObjectNamespace;

# Step 4 Report — Open Inspect on Cloudflare (oi-test, 350k account)

Finished 2026-10-13 ~23:15 IST by Grok Bot (the Hermes run was stopped because it had made no edits
since 18:54).

## Smoke test: PASS

Session `cee657cfe817f7f02de583d3e6003b3c` on StirringMinds/agent-command-center, prompt
`Run: echo hello && uname -a`, model `cloudflare-workers-ai/@cf/moonshotai/kimi-k2.7-code`:

    tool bash: echo hello && uname -a
    hello
    Linux cloudchamber 6.18.54-cloudflare-microvm-2026.9.16 #1 SMP PREEMPT_DYNAMIC Mon Sep 27 00:00:00 UTC 2010 x86_64 GNU/Linux
    execution_complete success=true cost=$0.0091

Boot took about 20 s once the image was warm: repo sync/clone 5.6 s, harness 7.9 s.

## Fixes

- Sandbox DO wraps `ctx.container` (start, setInactivityTimeout, destroy, monitor) over RPC.
- New container image built from the Python sandbox-runtime (packages/sandbox-images, modal layout),
  not the old Node supervisor. Digest sha256:6217d2ab…; build with
  `packages/control-plane/scripts/build-oi-test-sandbox-image.sh`.
- Entrypoint: `/opt/openinspect/python/bin/python -m sandbox_runtime.entrypoint`.
- **Root cause of connect failure:** `WORKER_URL` was missing, so the sandbox got CONTROL_PLANE_URL
  = open-inspect-control-plane.<acct>.workers.dev. It is now set.
- Kimi K2.7 Code (Workers AI) is the catalog default. The sandbox gets CLOUDFLARE_ACCOUNT_ID and
  CLOUDFLARE_API_KEY. No Anthropic key is used.
- Worker secrets uploaded: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PKCS#8),
  GITHUB_APP_INSTALLATION_ID, GITHUB_CLIENT_SECRET, CLOUDFLARE_API_KEY. BROWSER_AUTH_SECRET was
  regenerated (the old one was <32 chars) and SERVICE_AUTH_SECRET_WEB was re-synced.
  GITHUB_CLIENT_ID is a var.
- Login is restricted: ALLOWED_GITHUB_ORGS=StirringMinds, UNSAFE_ALLOW_ALL_USERS=false.
- oi-test-web is deployed (OpenNext) at https://oi-test-web.jayasuriya-brunthan.workers.dev with a
  service binding to the control plane. GitHub sign-in redirects correctly to github.com with the
  callback /api/auth/callback/github.

## Known issues

- `setInactivityTimeout` over RPC returns a Cloudflare "internal error". This is non-fatal and only
  logged as a warning; idle timeout falls back to SANDBOX_SLEEP_AFTER.
- First boot after an image change is slow: the 4.3 GB image provisioned for ~30 min and the first
  session hit the 240 s connecting timeout. Slimming the image would help.
- Snapshots, restore and resume are not implemented for Cloudflare.
- The typecheck/test suite was not re-run this step because `tsc` hung on the box. Wrangler bundling
  succeeded and lint-staged ran eslint and prettier.
- Slack app not created (by design).

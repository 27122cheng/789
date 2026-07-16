import { createHash } from "node:crypto";

/**
 * Deterministic webhook secret token, derived from the bot token itself.
 *
 * Why not a random stored secret: setWebhook (registration) and the webhook
 * handler (validation) run as separate serverless invocations. If they read
 * the stored secret at moments where a KV write hasn't propagated, the token
 * Telegram sends won't match what the handler expects and every delivery
 * fails with 401. Deriving the secret from the (stable) bot token means both
 * sides always compute the identical value with no shared state to desync -
 * eliminating the 401 stale-secret failure entirely.
 *
 * Telegram allows secret_token of 1-256 chars in [A-Za-z0-9_-]; a hex sha256
 * digest satisfies that.
 */
export function deriveWebhookSecret(botToken: string): string {
  return createHash("sha256")
    .update("tpx-webhook-v1:" + botToken)
    .digest("hex");
}

/**
 * Public origin to register the webhook on.
 *
 * Deployment-specific URLs (789-abc123-user.vercel.app) are protected by
 * Vercel Deployment Protection: unauthenticated requests - i.e. Telegram's
 * deliveries - get a Vercel-level 401 before our code ever runs. The stable
 * production domain is always public, so prefer it via the
 * VERCEL_PROJECT_PRODUCTION_URL env var Vercel injects at runtime.
 */
export function publicOrigin(forwardedHost: string | null, reqUrl: string): string {
  const prod = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (prod) return `https://${prod}`;
  if (forwardedHost) return `https://${forwardedHost}`;
  return new URL(reqUrl).origin;
}

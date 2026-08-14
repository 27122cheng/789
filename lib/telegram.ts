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

/**
 * Is this chat one the user asked to trade from?
 *
 * Shared by BOTH delivery paths, because they used to disagree: the bot webhook
 * filtered and the listener's /api/ingest did not. That gap is wider than it
 * sounds - a bot only ever receives updates from chats it was added to, but the
 * listener signs in as the USER, so it can see every group they belong to, and
 * anything resembling a signal in any of them was being traded.
 *
 * An empty list still means "accept all": the listener has its own WATCH_CHATS,
 * and turning an unconfigured list into a total block would silently stop a
 * working setup from trading.
 */
export function chatAllowed(
  chat: { id: string | number; username?: string | null; title?: string | null },
  allowed: string[]
): boolean {
  if (!allowed.length) return true;
  const id = String(chat.id);
  const username = (chat.username ?? "").toLowerCase();
  const title = (chat.title ?? "").toLowerCase();
  return allowed.some((entry) => {
    const e = entry.trim().replace(/^@/, "").toLowerCase();
    return e !== "" && (e === id.toLowerCase() || e === username || e === title);
  });
}

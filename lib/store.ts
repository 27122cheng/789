/**
 * Persistence layer. On Vercel, connect a KV store (Upstash Redis via the
 * Vercel Marketplace) so KV_REST_API_URL / KV_REST_API_TOKEN (or
 * UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) are set. Without those,
 * an in-memory Map is used - fine for local dev, but on serverless it resets
 * between invocations, so settings/positions would not survive.
 */
import { Redis } from "@upstash/redis";
import {
  DEFAULT_SETTINGS,
  OrderRecord,
  Position,
  Settings,
  SignalRecord,
  WebhookEvent,
} from "./types";

const KEY_PREFIX = "tpx:";
const K_SETTINGS = KEY_PREFIX + "settings";
const K_POSITIONS = KEY_PREFIX + "positions";
const K_SIGNALS = KEY_PREFIX + "signals";
const K_ORDERS = KEY_PREFIX + "orders";
const K_COOLDOWN = KEY_PREFIX + "cooldown";
const K_DEDUP = KEY_PREFIX + "dedup";
const K_ADMIN_HASH = KEY_PREFIX + "adminPasswordHash";
const K_CRON_SECRET = KEY_PREFIX + "cronSecret";
const K_WEBHOOK_EVENTS = KEY_PREFIX + "webhookEvents";

// 10 pages x 10 rows in the UI; oldest entries beyond this are dropped
const MAX_LOG = 100;
const MAX_WEBHOOK_EVENTS = 100;

// Built-in fallback credentials (owner's Upstash database) so the app works
// without any Vercel environment configuration. Env vars take precedence.
const FALLBACK_REDIS_URL = "https://probable-platypus-39069.upstash.io";
const FALLBACK_REDIS_TOKEN =
  "AZidAAIgcDE3MzQ4Mjg0OTNhYWI0MzI1YjJkYjFmNzVlMzI1ODI3Yg";

function redisFromEnv(): Redis | null {
  if (process.env.TPX_DISABLE_KV === "1") return null; // tests / local dev
  const url =
    process.env.KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    FALLBACK_REDIS_URL;
  const token =
    process.env.KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    FALLBACK_REDIS_TOKEN;
  if (url && token) return new Redis({ url, token });
  return null;
}

const memory = new Map<string, unknown>();

async function kvGet<T>(key: string): Promise<T | null> {
  const redis = redisFromEnv();
  if (redis) return (await redis.get<T>(key)) ?? null;
  const value = memory.get(key);
  // clone so callers get value semantics, same as the Redis JSON round-trip
  return value === undefined ? null : structuredClone(value as T);
}

async function kvSet(key: string, value: unknown): Promise<void> {
  const redis = redisFromEnv();
  if (redis) {
    await redis.set(key, value);
    return;
  }
  memory.set(key, structuredClone(value));
}

export function hasDurableStore(): boolean {
  return redisFromEnv() !== null;
}

// ---------------------------------------------------------------- settings
export async function getSettings(): Promise<Settings> {
  const stored = await kvGet<Partial<Settings>>(K_SETTINGS);
  if (!stored) return structuredClone(DEFAULT_SETTINGS);
  // deep-merge over defaults so newly added fields get sane values
  const merged = deepMerge(structuredClone(DEFAULT_SETTINGS), stored) as Settings;
  // migrate the old perp symbol format: Pionex's trade endpoint rejects the
  // _PERP suffix (it wants base_quote + type=PERP), so drop a trailing _PERP.
  if (/_PERP$/i.test(merged.pionex.symbolFormat)) {
    merged.pionex.symbolFormat = merged.pionex.symbolFormat.replace(/_PERP$/i, "");
  }
  return merged;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await kvSet(K_SETTINGS, settings);
}

function deepMerge(base: any, patch: any): any {
  if (patch === null || patch === undefined) return base;
  if (Array.isArray(patch) || typeof patch !== "object") return patch;
  const out: any = { ...base };
  for (const key of Object.keys(patch)) {
    out[key] =
      base && typeof base[key] === "object" && !Array.isArray(base[key])
        ? deepMerge(base[key], patch[key])
        : patch[key];
  }
  return out;
}

// --------------------------------------------------------------- positions
export async function getPositions(): Promise<Record<string, Position>> {
  return (await kvGet<Record<string, Position>>(K_POSITIONS)) ?? {};
}

export async function savePositions(
  positions: Record<string, Position>
): Promise<void> {
  await kvSet(K_POSITIONS, positions);
}

// -------------------------------------------------------------------- logs
export async function appendSignal(record: SignalRecord): Promise<void> {
  const list = (await kvGet<SignalRecord[]>(K_SIGNALS)) ?? [];
  list.unshift(record);
  await kvSet(K_SIGNALS, list.slice(0, MAX_LOG));
}

export async function getSignals(): Promise<SignalRecord[]> {
  return (await kvGet<SignalRecord[]>(K_SIGNALS)) ?? [];
}

export async function appendOrder(record: OrderRecord): Promise<void> {
  const list = (await kvGet<OrderRecord[]>(K_ORDERS)) ?? [];
  list.unshift(record);
  await kvSet(K_ORDERS, list.slice(0, MAX_LOG));
}

export async function getOrders(): Promise<OrderRecord[]> {
  return (await kvGet<OrderRecord[]>(K_ORDERS)) ?? [];
}

/** Removes every signal and order record for a symbol - used when a trade
 *  idea is cancelled so its history disappears from the logs entirely. */
export async function purgeSymbolRecords(symbol: string): Promise<void> {
  const signals = (await kvGet<SignalRecord[]>(K_SIGNALS)) ?? [];
  await kvSet(K_SIGNALS, signals.filter((s) => s.symbol !== symbol));
  const orders = (await kvGet<OrderRecord[]>(K_ORDERS)) ?? [];
  await kvSet(K_ORDERS, orders.filter((o) => o.symbol !== symbol));
}

// --------------------------------------------- raw webhook diagnostic log
/** Records EVERY update that reaches the webhook - even ones we drop - so the
 *  dashboard can show whether Telegram is delivering anything at all, what
 *  chat ids are arriving, and why a message was ignored. */
export async function appendWebhookEvent(event: WebhookEvent): Promise<void> {
  const list = (await kvGet<WebhookEvent[]>(K_WEBHOOK_EVENTS)) ?? [];
  list.unshift(event);
  await kvSet(K_WEBHOOK_EVENTS, list.slice(0, MAX_WEBHOOK_EVENTS));
}

export async function getWebhookEvents(): Promise<WebhookEvent[]> {
  return (await kvGet<WebhookEvent[]>(K_WEBHOOK_EVENTS)) ?? [];
}

// -------------------------------------------------- cooldown & dedup state
export async function getCooldowns(): Promise<Record<string, number>> {
  return (await kvGet<Record<string, number>>(K_COOLDOWN)) ?? {};
}

export async function setCooldown(symbol: string, at: number): Promise<void> {
  const map = await getCooldowns();
  map[symbol] = at;
  await kvSet(K_COOLDOWN, map);
}

// ---------------------------------------------------- auth & cron secrets
export async function getAdminPasswordHash(): Promise<string | null> {
  return await kvGet<string>(K_ADMIN_HASH);
}

export async function setAdminPasswordHash(hash: string): Promise<void> {
  await kvSet(K_ADMIN_HASH, hash);
}

/** Auto-generated secret for the monitor endpoint; created on first use so
 *  the user never has to configure a CRON_SECRET env var by hand. */
export async function getOrCreateCronSecret(): Promise<string> {
  const existing = await kvGet<string>(K_CRON_SECRET);
  if (existing) return existing;
  const secret = Array.from(
    { length: 32 },
    () => "abcdefghijklmnopqrstuvwxyz0123456789"[Math.floor(Math.random() * 36)]
  ).join("");
  await kvSet(K_CRON_SECRET, secret);
  return secret;
}

/** Returns true if this exact message (chat:msg:digest) was already handled. */
export async function checkAndMarkSeen(dedupKey: string): Promise<boolean> {
  const seen = (await kvGet<string[]>(K_DEDUP)) ?? [];
  if (seen.includes(dedupKey)) return true;
  seen.unshift(dedupKey);
  await kvSet(K_DEDUP, seen.slice(0, 500));
  return false;
}

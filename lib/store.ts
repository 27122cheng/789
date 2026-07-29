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
  TradeRecord,
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
const K_LISTENER = KEY_PREFIX + "listenerSession";
const K_MONITOR = KEY_PREFIX + "monitorRun";
const K_TRADES = KEY_PREFIX + "trades";
const K_STOPSNAP = KEY_PREFIX + "stopSnapshot";
const K_UNTRACKED = KEY_PREFIX + "untrackedPositions";

// 10 pages x 10 rows in the UI; oldest entries beyond this are dropped
const MAX_LOG = 100;
const MAX_WEBHOOK_EVENTS = 100;
// trade history drives the win-rate stats, so it is kept well beyond the logs
const MAX_TRADES = 500;

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
  // migrate to the futures trade symbol: the /uapi/v1 perp endpoints want the
  // _PERP suffix (BTC_USDT_PERP), so append it if an older bare format is stored.
  if (!/_PERP$/i.test(merged.pionex.symbolFormat)) {
    merged.pionex.symbolFormat = merged.pionex.symbolFormat + "_PERP";
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

// ------------------------------------------------------------ trade history
/** Finished trades, newest first. Kept longer than the action log: this is what
 *  win rate and cumulative profit are computed from. */
export async function appendTrade(record: TradeRecord): Promise<void> {
  const list = (await kvGet<TradeRecord[]>(K_TRADES)) ?? [];
  list.unshift(record);
  await kvSet(K_TRADES, list.slice(0, MAX_TRADES));
}

export async function getTrades(): Promise<TradeRecord[]> {
  return (await kvGet<TradeRecord[]>(K_TRADES)) ?? [];
}

export async function clearTrades(): Promise<void> {
  await kvSet(K_TRADES, []);
}

/** Empties the signal and order logs (dashboard lists). */
export async function clearLogs(): Promise<void> {
  await kvSet(K_SIGNALS, []);
  await kvSet(K_ORDERS, []);
}

/** Removes every signal and order record for a symbol - used when a trade
 *  idea is cancelled so its history disappears from the logs entirely. */
export async function purgeSymbolRecords(symbol: string): Promise<void> {
  const signals = (await kvGet<SignalRecord[]>(K_SIGNALS)) ?? [];
  await kvSet(K_SIGNALS, signals.filter((s) => s.symbol !== symbol));
  const orders = (await kvGet<OrderRecord[]>(K_ORDERS)) ?? [];
  await kvSet(K_ORDERS, orders.filter((o) => o.symbol !== symbol));
}

// ------------------------------------------------------- monitor heartbeat
/** When the monitor last ran. Without this there is no way to tell a working
 *  system from one whose cron stopped calling it - which looks identical from
 *  the dashboard (nothing happens) but leaves positions unmanaged. */
export interface MonitorRun {
  at: number;
  actionCount: number;
  actions: string[];
  error: string | null;
}

export async function setMonitorRun(run: MonitorRun): Promise<void> {
  await kvSet(K_MONITOR, run);
}

export async function getMonitorRun(): Promise<MonitorRun | null> {
  return await kvGet<MonitorRun>(K_MONITOR);
}

// -------------------------------------------- exchange protection snapshot
/** What protective orders the exchange actually holds, per symbol, as last seen
 *  by the monitor. Stored so the dashboard can show it without making its own
 *  exchange calls on every poll (which would invite rate limiting). */
export interface StopSnapshot {
  at: number;
  bySymbol: Record<string, { kind: "tp" | "sl"; trigger: number | null }[]>;
}

export async function setStopSnapshot(snap: StopSnapshot): Promise<void> {
  await kvSet(K_STOPSNAP, snap);
}

export async function getStopSnapshot(): Promise<StopSnapshot | null> {
  return await kvGet<StopSnapshot>(K_STOPSNAP);
}

// ----------------------------------- positions the tracker does not know
/** Positions the exchange holds that this app has no record of, as last seen by
 *  the monitor. They are unmanaged - no trailing, no scale-out, no close - and
 *  they block new signals on that symbol, because the duplicate guard refuses to
 *  open when the exchange already holds the coin. Surfacing them is the only way
 *  the dashboard can tell the truth about what is actually open. */
export interface UntrackedSnapshot {
  at: number;
  positions: {
    symbol: string;
    side: "long" | "short";
    qty: number;
    entryPrice: number;
  }[];
}

export async function setUntrackedSnapshot(snap: UntrackedSnapshot): Promise<void> {
  await kvSet(K_UNTRACKED, snap);
}

export async function getUntrackedSnapshot(): Promise<UntrackedSnapshot | null> {
  return await kvGet<UntrackedSnapshot>(K_UNTRACKED);
}

// ------------------------------------ listener login (Telethon) persistence
/** The user-account listener stores its api creds + StringSession here so it
 *  auto-resumes after a restart with no env config - log in once, forever. */
export async function getListenerSession(): Promise<{
  apiId: number;
  apiHash: string;
  session: string;
} | null> {
  return await kvGet(K_LISTENER);
}

export async function setListenerSession(v: {
  apiId: number;
  apiHash: string;
  session: string;
}): Promise<void> {
  await kvSet(K_LISTENER, v);
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

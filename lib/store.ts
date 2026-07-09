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
} from "./types";

const KEY_PREFIX = "tpx:";
const K_SETTINGS = KEY_PREFIX + "settings";
const K_POSITIONS = KEY_PREFIX + "positions";
const K_SIGNALS = KEY_PREFIX + "signals";
const K_ORDERS = KEY_PREFIX + "orders";
const K_COOLDOWN = KEY_PREFIX + "cooldown";
const K_DEDUP = KEY_PREFIX + "dedup";

const MAX_LOG = 200;

function redisFromEnv(): Redis | null {
  const url =
    process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token =
    process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
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
  return deepMerge(structuredClone(DEFAULT_SETTINGS), stored) as Settings;
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

// -------------------------------------------------- cooldown & dedup state
export async function getCooldowns(): Promise<Record<string, number>> {
  return (await kvGet<Record<string, number>>(K_COOLDOWN)) ?? {};
}

export async function setCooldown(symbol: string, at: number): Promise<void> {
  const map = await getCooldowns();
  map[symbol] = at;
  await kvSet(K_COOLDOWN, map);
}

/** Returns true if this exact message (chat:msg:digest) was already handled. */
export async function checkAndMarkSeen(dedupKey: string): Promise<boolean> {
  const seen = (await kvGet<string[]>(K_DEDUP)) ?? [];
  if (seen.includes(dedupKey)) return true;
  seen.unshift(dedupKey);
  await kvSet(K_DEDUP, seen.slice(0, 500));
  return false;
}

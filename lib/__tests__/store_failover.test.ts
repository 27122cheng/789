/**
 * The standby database. Writes mirror to every backend; reads fail over to the
 * standby when the primary throws - the scenario is the month the primary's
 * free quota ran out and login, settings, the monitor and trading all died
 * with it. With a standby configured, that month costs nothing.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const PRIMARY = "https://primary.test";
const STANDBY = "https://standby.test";

function stubEnvs() {
  vi.stubEnv("TPX_DISABLE_KV", "0"); // this suite explicitly wants backends
  vi.stubEnv("KV_REST_API_URL", PRIMARY);
  vi.stubEnv("KV_REST_API_TOKEN", "t-primary");
  vi.stubEnv("STANDBY_REDIS_REST_URL", STANDBY);
  vi.stubEnv("STANDBY_REDIS_REST_TOKEN", "t-standby");
}

/** Upstash REST protocol, minimally: POST <base>/ with ["CMD", args...]. The
 *  primary always answers with the real quota-exhausted error. */
function stubFetch(calls: { host: string; cmd: string }[]) {
  vi.stubGlobal("fetch", vi.fn(async (input: any, init?: any) => {
    const url = String(input?.url ?? input);
    const host = url.startsWith(PRIMARY) ? "primary" : "standby";
    // the client sends pipelines: [["set","k","v"], ...] - answer in kind
    let cmds: string[][] = [];
    try {
      const body = JSON.parse(init?.body ?? "[]");
      cmds = Array.isArray(body[0]) ? body : [body];
    } catch { /* leave empty */ }
    for (const c of cmds) calls.push({ host, cmd: String(c[0] ?? "?").toUpperCase() });
    if (host === "primary") {
      const err = "ERR max requests limit exceeded. Limit: 500000, Usage: 500000";
      return {
        ok: false, status: 429,
        json: async () => ({ error: err }),
        text: async () => JSON.stringify({ error: err }),
        headers: new Headers(),
      };
    }
    const answers = cmds.map((c) => {
      const cmd = String(c[0] ?? "?").toUpperCase();
      return {
        result:
          cmd === "GET" ? JSON.stringify({ BTCUSDT: { qty: 1 } })
          : cmd === "SET" ? "OK"
          : cmd === "DEL" ? 1
          : null,
      };
    });
    const payload = answers.length === 1 ? answers : answers;
    return {
      ok: true, status: 200,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
      headers: new Headers(),
    };
  }));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("standby database failover", () => {
  it("reads fall over to the standby when the primary is quota-dead", async () => {
    stubEnvs();
    const calls: { host: string; cmd: string }[] = [];
    stubFetch(calls);
    const store = await import("../store");

    const positions = await store.getPositions();
    expect(positions).toEqual({ BTCUSDT: { qty: 1 } });
    expect(calls.some((c) => c.host === "primary")).toBe(true);
    expect(calls.some((c) => c.host === "standby")).toBe(true);

    // the dead primary is benched: the next read goes straight to the standby
    const before = calls.filter((c) => c.host === "primary").length;
    await store.getPositions();
    expect(calls.filter((c) => c.host === "primary").length).toBe(before);

    const health = store.storeHealth();
    expect(health.backends).toEqual([
      { name: "primary", benched: true },
      { name: "standby", benched: false },
    ]);
    expect(health.lastError).toMatch(/max requests limit/);
  });

  it("writes mirror to every backend and survive the primary refusing", async () => {
    stubEnvs();
    const calls: { host: string; cmd: string }[] = [];
    stubFetch(calls);
    const store = await import("../store");

    await store.savePositions({});
    // both were attempted - the standby's copy is why failover loses nothing
    expect(calls.some((c) => c.host === "primary" && c.cmd === "SET")).toBe(true);
    expect(calls.some((c) => c.host === "standby" && c.cmd === "SET")).toBe(true);
  });
});

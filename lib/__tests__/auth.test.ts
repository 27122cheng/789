/**
 * Auth has to survive the store being unreachable, because the stored password
 * lives IN that store. Reporting a read failure as "wrong password" sends the
 * user off resetting a password that was never the problem - and an unhandled
 * throw here surfaces as a bare HTTP 500 on the login screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { hashPassword, requireAdmin } from "../auth";

// the stored hash is the thing under test here, so the store is controlled
let readHash: () => Promise<string | null> = async () => null;
vi.mock("../store", () => ({
  getAdminPasswordHash: () => readHash(),
  hasDurableStore: () => true,
}));

beforeEach(() => {
  readHash = async () => null;
});
afterEach(() => vi.unstubAllEnvs());

const req = (pw?: string) =>
  new NextRequest("https://x/api/state", {
    headers: pw ? { "x-admin-password": pw } : {},
  });

describe("requireAdmin", () => {
  it("accepts the built-in default when nothing is configured", async () => {
    expect(await requireAdmin(req("123456789"))).toBeNull();
  });

  it("rejects a wrong password with 401", async () => {
    const res = await requireAdmin(req("nope"));
    expect(res?.status).toBe(401);
  });

  it("reports a dead store as 503, not as a wrong password", async () => {
    readHash = async () => {
      throw new Error("upstash unreachable");
    };
    const res = await requireAdmin(req("123456789"));
    expect(res?.status).toBe(503);
    const body = await res!.json();
    expect(body.storeDown).toBe(true);
    expect(body.error).toMatch(/資料庫/);
    expect(body.error).toMatch(/ADMIN_PASSWORD/); // names the way back in
  });

  it("lets ADMIN_PASSWORD in without touching the store at all", async () => {
    // the escape hatch when the database is down or the password is forgotten
    let touched = false;
    readHash = async () => {
      touched = true;
      throw new Error("upstash unreachable");
    };
    vi.stubEnv("ADMIN_PASSWORD", "rescue-pw");
    expect(await requireAdmin(req("rescue-pw"))).toBeNull();
    expect(touched).toBe(false);
    expect((await requireAdmin(req("wrong")))?.status).toBe(401);
  });

  it("hashes with the salted scheme the stored value uses", () => {
    expect(hashPassword("abc")).toBe(hashPassword("abc"));
    expect(hashPassword("abc")).not.toBe(hashPassword("abd"));
  });
});

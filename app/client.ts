"use client";

/** Shared browser-side helpers: admin password storage + authed fetch. */

const PW_KEY = "tpx-admin-password";

export function getStoredPassword(): string {
  if (typeof window === "undefined") return "";
  return sessionStorage.getItem(PW_KEY) ?? "";
}

export function storePassword(pw: string): void {
  sessionStorage.setItem(PW_KEY, pw);
}

export async function apiFetch(
  path: string,
  init: RequestInit = {}
): Promise<{ status: number; body: any }> {
  const resp = await fetch(path, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      "x-admin-password": getStoredPassword(),
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
    cache: "no-store",
  });
  let body: any = null;
  try {
    body = await resp.json();
  } catch {
    /* empty */
  }
  return { status: resp.status, body };
}

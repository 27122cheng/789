"use client";

/**
 * Login panel with a first-run flow: when no admin password exists yet
 * (no ADMIN_PASSWORD env var and nothing in KV), it lets the first visitor
 * create one right in the browser - no Vercel configuration needed.
 */
import { useEffect, useState } from "react";
import { storePassword } from "./client";

export default function LoginPanel({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"loading" | "login" | "setup">("loading");
  const [durable, setDurable] = useState(true);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        setMode(d.mode === "unconfigured" ? "setup" : "login");
        setDurable(!!d.durableStore);
      })
      .catch(() => setMode("login"));
  }, []);

  async function doLogin() {
    setError("");
    storePassword(password);
    onAuthed();
  }

  async function doSetup() {
    setError("");
    if (password.length < 8) {
      setError("密碼至少需要 8 個字元");
      return;
    }
    if (password !== confirm) {
      setError("兩次輸入的密碼不一樣");
      return;
    }
    setBusy(true);
    const resp = await fetch("/api/auth", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password }),
      cache: "no-store",
    });
    const body = await resp.json().catch(() => ({}));
    setBusy(false);
    if (resp.ok) {
      storePassword(password);
      onAuthed();
    } else {
      setError(body?.error ?? `建立失敗 (HTTP ${resp.status})`);
    }
  }

  if (mode === "loading") {
    return (
      <div className="panel" style={{ maxWidth: 460, margin: "48px auto" }}>
        <p className="hint">載入中…</p>
      </div>
    );
  }

  if (mode === "setup") {
    return (
      <div className="panel" style={{ maxWidth: 460, margin: "48px auto" }}>
        <h1>首次使用：建立管理密碼</h1>
        <p className="hint">
          這組密碼用來保護你的 API 金鑰與交易設定，之後登入都用它。請自己想一組並記好。
        </p>
        {!durable && (
          <div className="banner warn">
            ⚠️ 尚未連接資料庫，密碼將無法保存。請先到 Vercel 專案 →
            Storage → Create Database → 選 <b>Upstash Redis</b>，
            建立後重新部署（Redeploy）再回來這頁。
          </div>
        )}
        <label>設定密碼（至少 8 個字元）</label>
        <input type="password" value={password}
               onChange={(e) => setPassword(e.target.value)} />
        <label>再輸入一次</label>
        <input type="password" value={confirm}
               onChange={(e) => setConfirm(e.target.value)}
               onKeyDown={(e) => e.key === "Enter" && doSetup()} />
        <button onClick={doSetup} disabled={busy || !durable}>
          {busy ? "建立中…" : "建立密碼並登入"}
        </button>
        {error && <div className="msg err">{error}</div>}
      </div>
    );
  }

  return (
    <div className="panel" style={{ maxWidth: 460, margin: "48px auto" }}>
      <h1>管理登入</h1>
      <p className="hint">輸入你建立的管理密碼（或部署時設定的 ADMIN_PASSWORD）。</p>
      <label>管理密碼</label>
      <input type="password" value={password}
             onChange={(e) => setPassword(e.target.value)}
             onKeyDown={(e) => e.key === "Enter" && doLogin()} />
      <button onClick={doLogin}>登入</button>
      {error && <div className="msg err">{error}</div>}
    </div>
  );
}

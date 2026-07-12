"use client";

/**
 * Login panel. When the built-in default password is active (no
 * ADMIN_PASSWORD env var, no custom password in KV) it logs in
 * automatically so the user lands straight on the dashboard.
 */
import { useEffect, useState } from "react";
import { storePassword } from "./client";

const DEFAULT_PASSWORD = "123456789";

export default function LoginPanel({ onAuthed }: { onAuthed: () => void }) {
  const [mode, setMode] = useState<"loading" | "login">("loading");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    fetch("/api/auth", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (d.mode === "default") {
          storePassword(DEFAULT_PASSWORD);
          onAuthed();
        } else {
          setMode("login");
        }
      })
      .catch(() => setMode("login"));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function doLogin() {
    setError("");
    storePassword(password);
    onAuthed();
  }

  if (mode === "loading") {
    return (
      <div className="panel" style={{ maxWidth: 460, margin: "48px auto" }}>
        <p className="hint">載入中…</p>
      </div>
    );
  }

  return (
    <div className="panel" style={{ maxWidth: 460, margin: "48px auto" }}>
      <h1>管理登入</h1>
      <p className="hint">輸入你的管理密碼。</p>
      <label>管理密碼</label>
      <input type="password" value={password}
             onChange={(e) => setPassword(e.target.value)}
             onKeyDown={(e) => e.key === "Enter" && doLogin()} />
      <button onClick={doLogin}>登入</button>
      {error && <div className="msg err">{error}</div>}
    </div>
  );
}

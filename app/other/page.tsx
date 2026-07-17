"use client";

/** 其他: 系統通知、Telegram 連線診斷、測試訊息解析 (moved off the dashboard). */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword } from "../client";
import LoginPanel from "../LoginPanel";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-TW", { hour12: false });
}

export default function OtherPage() {
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<any>(null);
  const [diag, setDiag] = useState<any>(null);
  const [testText, setTestText] = useState("");
  const [testResult, setTestResult] = useState<any>(null);

  const load = useCallback(async () => {
    const { status, body } = await apiFetch("/api/state");
    if (status === 200) {
      setState(body);
      setAuthed(true);
      setError("");
      apiFetch("/api/telegram/diag").then((r) => {
        if (r.status === 200) setDiag(r.body);
      });
    } else {
      setAuthed(false);
      setError(body?.needsSetup ? "" : body?.error ?? `HTTP ${status}`);
    }
  }, []);

  useEffect(() => {
    if (getStoredPassword()) load();
  }, [load]);

  async function runTest() {
    const { status, body } = await apiFetch("/api/parse-test", {
      method: "POST",
      body: JSON.stringify({ text: testText }),
    });
    setTestResult(status === 200 ? body : { error: body?.error ?? status });
  }

  if (!authed) {
    return (
      <div>
        <LoginPanel onAuthed={load} />
        {error && (
          <div className="msg err" style={{ maxWidth: 460, margin: "0 auto" }}>
            {error}
          </div>
        )}
      </div>
    );
  }

  return (
    <div>
      <h1>其他</h1>

      <h2>系統通知</h2>
      {state.liveTrading ? (
        <div className="banner live">
          ⚠️ LIVE TRADING 已啟用 — 收到的信號會送出真實訂單
        </div>
      ) : (
        <div className="banner dry">
          ✅ 模擬模式 (dry-run) — 只解析與記錄，不會真實下單
        </div>
      )}
      {state.authMode === "default" && (
        <div className="banner warn">
          🔑 目前使用預設密碼 123456789。若之後想改密碼，在 Vercel 加上
          ADMIN_PASSWORD 環境變數即可。
        </div>
      )}
      {!state.durableStore && (
        <div className="banner warn">
          ⚠️ 尚未連接 KV 儲存（Upstash Redis）。serverless 環境下設定與倉位
          <b>不會保存</b>。
        </div>
      )}

      <h2>Telegram 連線診斷</h2>
      <div className="panel">
        {!diag ? (
          <p className="hint">載入中…</p>
        ) : (
          <>
            {diag.problems && diag.problems.length > 0 ? (
              diag.problems.map((p: string, i: number) => (
                <div className="banner warn" key={i}>⚠️ {p}</div>
              ))
            ) : (
              <div className="banner dry">✅ Webhook 已註冊且沒有偵測到問題</div>
            )}
            <table>
              <tbody>
                <tr><th>機器人帳號</th><td className="mono">{diag.botUsername ? "@" + diag.botUsername : (diag.botToken ? "?" : "未設定 token")}</td></tr>
                <tr><th>Webhook 已註冊</th><td>{diag.webhook?.registered ? "是" : "否"}</td></tr>
                <tr><th>指向網址正確</th><td>{diag.webhook?.registered ? (diag.webhook?.urlMatches ? "是" : "否（指向別處）") : "-"}</td></tr>
                <tr><th>積壓未處理更新</th><td>{diag.webhook?.pendingUpdateCount ?? "-"}</td></tr>
                <tr><th>Telegram 最近錯誤</th><td className="fail">{diag.webhook?.lastErrorMessage ?? "無"}</td></tr>
              </tbody>
            </table>
            <p className="hint" style={{ marginTop: 12 }}>
              下方是「原始進站事件」——不論有沒有被採用，每一筆到達 webhook 的更新都會記錄。
            </p>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>時間</th><th>類型</th><th>群組</th><th>來自機器人</th><th>結果</th><th>說明</th></tr>
                </thead>
                <tbody>
                  {(diag.events ?? []).length === 0 ? (
                    <tr><td colSpan={6} className="hint">
                      還沒有收到任何進站事件。
                    </td></tr>
                  ) : (
                    diag.events.map((e: any, i: number) => (
                      <tr key={i}>
                        <td className="mono">{fmtTime(e.at)}</td>
                        <td>{e.updateType}</td>
                        <td className="mono">{e.chatTitle ?? e.chatId ?? "-"}<br/>
                          <span style={{ color: "var(--muted)", fontSize: 11 }}>{e.chatType}{e.chatId ? " " + e.chatId : ""}</span>
                        </td>
                        <td>{e.fromBot ? "⚠️ 是" : "否"}</td>
                        <td className={e.outcome === "accepted" ? "ok" : "fail"}>{e.outcome}</td>
                        <td style={{ maxWidth: 280, fontSize: 12 }}>{e.detail}<br/>
                          <span style={{ color: "var(--muted)" }}>{e.textPreview}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </>
        )}
      </div>

      <h2>測試訊息解析</h2>
      <div className="panel">
        <p className="hint">
          把一則群組訊息貼進來，看系統會怎麼判定（開倉/升級/加倉/平倉/取消/移動止損/忽略），
          不用真的發到群組就能驗證判斷力。
        </p>
        <textarea value={testText} onChange={(e) => setTestText(e.target.value)}
                  style={{ minHeight: 120 }}
                  placeholder="貼上一則信號或訊息…" />
        <button onClick={runTest} disabled={!testText.trim()}>測試解析</button>
        {testResult && (
          <pre style={{ marginTop: 12, background: "var(--bg)", padding: 12,
                        borderRadius: 6, overflowX: "auto", fontSize: 12 }}>
            {JSON.stringify(testResult, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );
}

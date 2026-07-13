"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword } from "./client";
import LoginPanel from "./LoginPanel";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-TW", { hour12: false });
}

function SideCell({ side }: { side: string | null }) {
  if (!side) return <td>-</td>;
  return (
    <td className={side === "long" ? "side-long" : "side-short"}>
      {side === "long" ? "多 LONG" : "空 SHORT"}
    </td>
  );
}

export default function Dashboard() {
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
      // 428 = first-run, the LoginPanel shows the setup flow itself
      setError(body?.needsSetup ? "" : body?.error ?? `HTTP ${status}`);
    }
  }, []);

  async function runTest() {
    const { status, body } = await apiFetch("/api/parse-test", {
      method: "POST",
      body: JSON.stringify({ text: testText }),
    });
    setTestResult(status === 200 ? body : { error: body?.error ?? status });
  }

  useEffect(() => {
    if (getStoredPassword()) load();
  }, [load]);

  useEffect(() => {
    if (!authed) return;
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [authed, load]);

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

  const positions = Object.values(state?.positions ?? {}) as any[];

  return (
    <div>
      <h1>儀表板</h1>

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
          <b>不會保存</b>，請在 Vercel 專案加入 Upstash Redis integration。
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
              下方是「原始進站事件」——不論有沒有被採用，每一筆到達 webhook 的更新都會記錄，
              用來確認 Telegram 到底有沒有把訊息送過來、以及來自哪個群組。
            </p>
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>時間</th><th>類型</th><th>群組</th><th>來自機器人</th><th>結果</th><th>說明</th></tr>
                </thead>
                <tbody>
                  {(diag.events ?? []).length === 0 ? (
                    <tr><td colSpan={6} className="hint">
                      還沒有收到任何進站事件。代表 Telegram 完全沒有把訊息送到這個網站——
                      通常是 webhook 沒註冊、機器人不在群組裡、或信號來自另一個機器人。
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
          把一則群組訊息貼進來，看系統會怎麼判定（開倉/加倉/平倉/取消/移動止損/忽略），
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

      <div className="statgrid">
        <div className="stat">
          <div className="k">Telegram 機器人</div>
          <div className="v">{state.configured.telegramBot ? "✅ 已設定" : "❌ 未設定"}</div>
        </div>
        <div className="stat">
          <div className="k">監聽群組數</div>
          <div className="v">{state.configured.allowedChats}</div>
        </div>
        <div className="stat">
          <div className="k">Pionex API</div>
          <div className="v">{state.configured.pionexKeys ? "✅ 已設定" : "❌ 未設定"}</div>
        </div>
        <div className="stat">
          <div className="k">移動止損</div>
          <div className="v">{state.trailingEnabled ? "啟用" : "停用"}</div>
        </div>
        <div className="stat">
          <div className="k">持倉中</div>
          <div className="v">{positions.length}</div>
        </div>
      </div>

      <h2>目前持倉</h2>
      <div className="panel">
        {positions.length === 0 ? (
          <p className="hint">目前沒有持倉。</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>幣種</th><th>方向</th><th>槓桿</th><th>均價</th>
                <th>數量</th><th>名目 USDT</th><th>止損</th><th>止盈</th>
                <th>加倉次數</th><th>模式</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol}>
                  <td className="mono">{p.symbol}</td>
                  <SideCell side={p.side} />
                  <td>{p.leverage}x</td>
                  <td className="mono">{p.entryPrice?.toFixed(4)}</td>
                  <td className="mono">{p.qty?.toFixed(6)}</td>
                  <td className="mono">{p.sizeUsdt?.toFixed(2)}</td>
                  <td className="mono">{p.stopLoss ? p.stopLoss.toFixed(4) : "-"}</td>
                  <td className="mono">{p.takeProfits?.join(" / ") || "-"}</td>
                  <td>{p.addCount}</td>
                  <td>{p.dryRun ? "模擬" : "真實"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <h2>訂單／動作紀錄</h2>
      <div className="panel" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>時間</th><th>動作</th><th>幣種</th><th>方向</th>
              <th>USDT</th><th>價格</th><th>結果</th><th>訊息</th>
            </tr>
          </thead>
          <tbody>
            {(state.orders ?? []).map((o: any, i: number) => (
              <tr key={i}>
                <td className="mono">{fmtTime(o.at)}</td>
                <td>{o.action}{o.dryRun ? " (模擬)" : ""}</td>
                <td className="mono">{o.symbol}</td>
                <SideCell side={o.side} />
                <td className="mono">{o.sizeUsdt ? o.sizeUsdt.toFixed(2) : "-"}</td>
                <td className="mono">{o.price ?? "-"}</td>
                <td className={o.success ? "ok" : "fail"}>{o.success ? "成功" : "失敗"}</td>
                <td style={{ maxWidth: 320 }}>{o.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>收到的訊息／信號</h2>
      <div className="panel" style={{ overflowX: "auto" }}>
        <table>
          <thead>
            <tr>
              <th>時間</th><th>判定</th><th>幣種</th><th>摘要</th><th>原始訊息</th>
            </tr>
          </thead>
          <tbody>
            {(state.signals ?? []).map((s: any, i: number) => (
              <tr key={i}>
                <td className="mono">{fmtTime(s.at)}</td>
                <td>
                  {s.action === "filtered" ? "🚫 已過濾" :
                   s.action === "ignored" ? "— 非信號" : `📈 ${s.action}`}
                </td>
                <td className="mono">{s.symbol ?? "-"}</td>
                <td>{s.summary}</td>
                <td style={{ maxWidth: 320, color: "var(--muted)" }}>
                  {s.rawText?.slice(0, 120)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword, storePassword } from "./client";

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
  const [password, setPassword] = useState("");
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState("");
  const [state, setState] = useState<any>(null);

  const load = useCallback(async () => {
    const { status, body } = await apiFetch("/api/state");
    if (status === 200) {
      setState(body);
      setAuthed(true);
      setError("");
    } else {
      setAuthed(false);
      setError(body?.error ?? `HTTP ${status}`);
    }
  }, []);

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
      <div className="panel" style={{ maxWidth: 420, margin: "48px auto" }}>
        <h1>管理登入</h1>
        <p className="hint">
          輸入部署時設定的 ADMIN_PASSWORD 環境變數值。
        </p>
        <label>管理密碼</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              storePassword(password);
              load();
            }
          }}
        />
        <button
          onClick={() => {
            storePassword(password);
            load();
          }}
        >
          登入
        </button>
        {error && <div className="msg err">{error}</div>}
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
      {!state.durableStore && (
        <div className="banner warn">
          ⚠️ 尚未連接 KV 儲存（Upstash Redis）。serverless 環境下設定與倉位
          <b>不會保存</b>，請在 Vercel 專案加入 Upstash Redis integration。
        </div>
      )}

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

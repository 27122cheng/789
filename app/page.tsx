"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword } from "./client";
import LoginPanel from "./LoginPanel";
import Pager, { PER_PAGE } from "./Pager";

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
  const [orderPage, setOrderPage] = useState(0);
  const [signalPage, setSignalPage] = useState(0);

  const load = useCallback(async () => {
    const { status, body } = await apiFetch("/api/state");
    if (status === 200) {
      setState(body);
      setAuthed(true);
      setError("");
    } else {
      setAuthed(false);
      setError(body?.needsSetup ? "" : body?.error ?? `HTTP ${status}`);
    }
  }, []);

  async function clearPositions() {
    if (!confirm("確定清空所有持倉？這只會清掉系統的追蹤紀錄，不會平掉 Pionex 上的真實倉位。")) return;
    const { status, body } = await apiFetch("/api/positions/clear", { method: "POST" });
    if (status === 200) {
      await load();
    } else {
      alert(body?.error ?? `清空失敗 (HTTP ${status})`);
    }
  }

  async function clearLogs() {
    if (!confirm("確定清空所有紀錄？（訂單／動作紀錄與收到的訊息，不影響持倉與設定）")) return;
    const { status, body } = await apiFetch("/api/logs/clear", { method: "POST" });
    if (status === 200) {
      setOrderPage(0);
      setSignalPage(0);
      await load();
    } else {
      alert(body?.error ?? `清空失敗 (HTTP ${status})`);
    }
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
  const orders = (state?.orders ?? []) as any[];
  const signals = (state?.signals ?? []) as any[];
  const orderRows = orders.slice(orderPage * PER_PAGE, (orderPage + 1) * PER_PAGE);
  const signalRows = signals.slice(signalPage * PER_PAGE, (signalPage + 1) * PER_PAGE);

  return (
    <div>
      <h1>儀表板</h1>

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
        <div className="stat">
          <div className="k">模式</div>
          <div className="v" style={{ color: state.liveTrading ? "var(--red)" : "var(--green)" }}>
            {state.liveTrading ? "⚠️ 真實" : "模擬"}
          </div>
        </div>
      </div>

      <h2>目前持倉</h2>
      <div className="panel">
        {positions.length === 0 ? (
          <p className="hint">目前沒有持倉。</p>
        ) : (
          <div style={{ overflowX: "auto" }}>
            <table>
              <thead>
                <tr>
                  <th>幣種</th><th>方向</th><th>槓桿</th><th>均價</th>
                  <th>數量</th><th>名目 USDT</th><th>止損</th><th>止盈</th>
                  <th>加倉位</th><th>加倉次數</th><th>模式</th>
                </tr>
              </thead>
              <tbody>
                {positions.map((p) => (
                  <tr key={p.symbol}>
                    <td className="mono">{p.symbol}</td>
                    <SideCell side={p.side} />
                    <td>{p.leverage}x</td>
                    <td className="mono">{p.entryPrice?.toFixed(6)}</td>
                    <td className="mono">{p.qty?.toFixed(6)}</td>
                    <td className="mono">{p.sizeUsdt?.toFixed(2)}</td>
                    <td className="mono">{p.stopLoss ? p.stopLoss.toFixed(6) : "-"}</td>
                    <td className="mono">{p.takeProfits?.join(" / ") || "-"}</td>
                    <td className="mono">
                      {(p.pendingAdds ?? []).length
                        ? p.pendingAdds.map((a: any) =>
                            `${typeof a === "number" ? a : a.level}${a.armed ? "⏳" : ""}`
                          ).join(" / ")
                        : "-"}
                    </td>
                    <td>{p.addCount}</td>
                    <td>
                      {p.pendingEntry ? "⏳ 待進場" : ""}
                      {p.pendingEntry ? " " : ""}
                      {p.dryRun ? "模擬" : "真實"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {positions.length > 0 && (
          <button
            onClick={clearPositions}
            style={{ background: "var(--red)", color: "#fff", marginTop: 14 }}
          >
            🗑 一鍵清空所有持倉
          </button>
        )}
        {positions.length > 0 && (
          <p className="hint" style={{ marginTop: 8 }}>
            只清掉系統的追蹤紀錄（適合清理累積的模擬倉）；不會平掉 Pionex 上的真實倉位。
          </p>
        )}
      </div>

      <h2>訂單／動作紀錄</h2>
      <div className="panel">
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>時間</th><th>動作</th><th>幣種</th><th>方向</th>
                <th>USDT</th><th>價格</th><th>結果</th><th>訊息</th>
              </tr>
            </thead>
            <tbody>
              {orderRows.length === 0 ? (
                <tr><td colSpan={8} className="hint">還沒有任何動作紀錄。</td></tr>
              ) : (
                orderRows.map((o: any, i: number) => (
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
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager page={orderPage} total={orders.length} onPage={setOrderPage} />
      </div>

      <h2>收到的訊息／信號</h2>
      <div className="panel">
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>時間</th><th>判定</th><th>幣種</th><th>摘要</th><th>原始訊息</th>
              </tr>
            </thead>
            <tbody>
              {signalRows.length === 0 ? (
                <tr><td colSpan={5} className="hint">還沒有收到任何訊息。</td></tr>
              ) : (
                signalRows.map((s: any, i: number) => (
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
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager page={signalPage} total={signals.length} onPage={setSignalPage} />
        {(orders.length > 0 || signals.length > 0) && (
          <button
            onClick={clearLogs}
            className="secondary"
            style={{ marginTop: 14 }}
          >
            🧹 清空所有紀錄（訂單／動作 + 收到的訊息）
          </button>
        )}
      </div>
    </div>
  );
}

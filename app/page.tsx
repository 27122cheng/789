"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword } from "./client";
import LoginPanel from "./LoginPanel";
import Pager, { PER_PAGE } from "./Pager";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-TW", { hour12: false });
}

/** What the exchange itself is holding for this symbol, as last seen by the
 *  monitor. Shown because OKX labels a stop-loss and a take-profit identically
 *  ("止盈止損·平空", same size) - only the trigger price differs - so a protected
 *  position looks like two duplicate orders unless the roles are spelled out. */
function ProtectionCell({ list }: { list: any[] | undefined }) {
  if (!list?.length) return <td className="mono">-</td>;
  const fmt = (t: number | null) => (t == null ? "?" : String(t));
  const sl = list.filter((o) => o.kind === "sl").map((o) => fmt(o.trigger));
  const tp = list
    .filter((o) => o.kind === "tp")
    .map((o) => fmt(o.trigger));
  return (
    <td className="mono" style={{ fontSize: 12 }}>
      {sl.length ? <span style={{ color: "var(--red)" }}>SL {sl.join(", ")}</span> : null}
      {sl.length && tp.length ? <br /> : null}
      {tp.length ? <span style={{ color: "var(--green)" }}>TP {tp.join(", ")}</span> : null}
    </td>
  );
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

  async function deletePosition(p: any) {
    const restingCount =
      (p.pendingEntry?.mode === "limit_order" ? 1 : 0) +
      (p.pendingAdds ?? []).filter((a: any) => a?.orderId).length;
    const held = p.qty > 0;
    if (
      !confirm(
        `刪除 ${p.symbol} 的持倉紀錄？\n\n` +
          (held
            ? "⚠️ 交易所上的真實持倉與止盈止損不會更動，只是本系統不再管理它" +
              "（移動止損、分批止盈都會停止）。\n"
            : "") +
          (restingCount
            ? `交易所上的 ${restingCount} 筆掛單（進場／加倉）會一併取消。\n`
            : "") +
          "\n刪除後這個幣種就能接受新的訊號。"
      )
    ) {
      return;
    }
    const { status, body } = await apiFetch("/api/positions/delete", {
      method: "POST",
      body: JSON.stringify({ symbol: p.symbol }),
    });
    if (status === 200) {
      if (body?.warning) alert(body.warning);
      await load();
    } else {
      alert(body?.error ?? `刪除失敗 (HTTP ${status})`);
    }
  }

  async function adoptPosition(p: any) {
    const stops = state.stopSnapshot?.bySymbol?.[p.symbol] ?? [];
    const hasSl = stops.some((o: any) => o.kind === "sl");
    if (
      !confirm(
        `接管 ${p.symbol}（${p.side === "long" ? "多" : "空"} ${p.qty}）？\n\n` +
          "會沿用交易所上現有的止損／止盈，不會下任何新單，也不會平倉。\n" +
          "接管後本系統就會開始管理它（移動止損、分批止盈、平倉）。\n" +
          (hasSl ? "" : "\n⚠️ 交易所上找不到這個幣種的止損單，接管後仍然沒有止損。\n")
      )
    ) {
      return;
    }
    const { status, body } = await apiFetch("/api/positions/adopt", {
      method: "POST",
      body: JSON.stringify({ symbol: p.symbol }),
    });
    if (status === 200) {
      await load();
    } else {
      alert(body?.error ?? `接管失敗 (HTTP ${status})`);
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

      {(() => {
        const run = state.monitorRun;
        const ageMs = run ? Date.now() - run.at : null;
        // the cron is meant to fire every minute; treat >5 min as stopped
        const stale = ageMs == null || ageMs > 5 * 60 * 1000;
        if (!stale && !run.error) {
          return (
            <p className="hint">
              ✅ 監控正常運作 — 最後執行 {Math.round((ageMs ?? 0) / 1000)} 秒前
              {run.actionCount ? `（${run.actionCount} 個動作）` : ""}
            </p>
          );
        }
        return (
          <div className="banner live" style={{ marginBottom: 14 }}>
            ⚠️ 監控{run ? "已停止" : "從未執行"}
            {run ? ` — 最後執行：${fmtTime(run.at)}` : ""}
            {run?.error ? `，錯誤：${run.error}` : ""}
            <br />
            止損、止盈、到價進場、補掛保護單都靠這個每分鐘的排程。
            請確認 cron-job.org 的排程有在跑（設定頁有網址與密鑰）。
          </div>
        );
      })()}

      {(state.untracked?.positions ?? []).length > 0 && (
        <div className="banner live" style={{ marginBottom: 14 }}>
          ⚠️ 交易所有 {state.untracked.positions.length} 筆持倉，本系統沒有追蹤
          （{fmtTime(state.untracked.at)} 檢查）
          <div style={{ overflowX: "auto", marginTop: 8 }}>
            <table>
              <thead>
                <tr>
                  <th>幣種</th><th>方向</th><th>數量</th><th>開倉均價</th>
                  <th>交易所保護單</th><th></th>
                </tr>
              </thead>
              <tbody>
                {state.untracked.positions.map((p: any) => (
                  <tr key={p.symbol}>
                    <td className="mono">{p.symbol}</td>
                    <SideCell side={p.side} />
                    <td className="mono">{p.qty}</td>
                    <td className="mono">{p.entryPrice}</td>
                    <ProtectionCell list={state.stopSnapshot?.bySymbol?.[p.symbol]} />
                    <td>
                      <button onClick={() => adoptPosition(p)} style={{ padding: "2px 10px" }}>
                        接管
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          這些倉位<b>不會被本系統管理</b>（不會移動止損、分批止盈、也不會平倉），
          而且它們會<b>擋掉同幣種的新訊號</b> —— 開倉前的重複檢查看到交易所已有持倉就會略過。
          <br />
          按「<b>接管</b>」會沿用交易所上現有的止損／止盈把它交回本系統管理（不會下新單、不會平倉）；
          如果只是分批止盈後剩下的零頭，直接到交易所平掉即可。
        </div>
      )}

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
                  <th>交易所保護單</th>
                  <th>加倉位</th><th>加倉次數</th><th>模式</th><th></th>
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
                    <ProtectionCell list={state.stopSnapshot?.bySymbol?.[p.symbol]} />
                    <td className="mono">
                      {(p.pendingAdds ?? []).length
                        ? p.pendingAdds.map((a: any) =>
                            `${typeof a === "number" ? a : a.level}${a.armed ? "⏳" : ""}`
                          ).join(" / ")
                        : "-"}
                    </td>
                    <td>{p.addCount}</td>
                    <td>
                      {p.pendingEntry
                        ? p.pendingEntry.mode === "limit_order"
                          ? "⏳ 掛單中 "
                          : p.pendingEntry.mode === "scheduled"
                            ? `⏳ 等待延遲${
                                p.pendingEntry.placeAt
                                  ? `（約 ${Math.max(
                                      0,
                                      Math.round((p.pendingEntry.placeAt - Date.now()) / 1000)
                                    )} 秒）`
                                  : ""
                              } `
                            : "⏳ 待進場 "
                        : ""}
                      {p.dryRun ? "模擬" : "真實"}
                    </td>
                    <td>
                      <button
                        onClick={() => deletePosition(p)}
                        title={`刪除 ${p.symbol} 的追蹤紀錄`}
                        aria-label={`刪除 ${p.symbol} 的追蹤紀錄`}
                        style={{
                          background: "transparent",
                          color: "var(--red)",
                          border: "none",
                          padding: "2px 6px",
                          fontSize: 16,
                          lineHeight: 1,
                          cursor: "pointer",
                        }}
                      >
                        ✕
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {positions.length > 0 && state.stopSnapshot && (
          <p className="hint" style={{ marginTop: 10 }}>
            「交易所保護單」是交易所上真實存在的委託（{fmtTime(state.stopSnapshot.at)} 更新）。
            交易所的列表會把止損與止盈都寫成「止盈止損·平空／平多」、數量也相同，
            只有觸發價不一樣，所以看起來像重複的單 —— 這一欄直接標明哪個是 SL、哪個是 TP。
            一個持倉有 1 個 SL + N 個分批 TP 是正常的。
          </p>
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

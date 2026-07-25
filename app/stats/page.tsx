"use client";

/** 績效: win rate and profit from the finished-trade history. */
import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword } from "../client";
import LoginPanel from "../LoginPanel";
import Pager, { PER_PAGE } from "../Pager";

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-TW", { hour12: false });
}

function money(v: number | null | undefined): string {
  if (v == null) return "-";
  return `${v > 0 ? "+" : ""}${v.toFixed(2)}`;
}

function Pnl({ v }: { v: number | null | undefined }) {
  if (v == null) return <td>-</td>;
  return (
    <td className="mono" style={{ color: v > 0 ? "var(--green)" : v < 0 ? "var(--red)" : undefined }}>
      {money(v)}
    </td>
  );
}

function Summary({ title, s }: { title: string; s: any }) {
  return (
    <div>
      <h2>{title}</h2>
      {s.trades === 0 ? (
        <div className="panel">
          <p className="hint">還沒有已結束的交易。倉位完全平掉後才會計入。</p>
        </div>
      ) : (
        <div className="statgrid">
          <div className="stat">
            <div className="k">勝率</div>
            <div className="v">{s.winRate}%</div>
          </div>
          <div className="stat">
            <div className="k">總損益 (USDT)</div>
            <div className="v" style={{ color: s.totalPnl >= 0 ? "var(--green)" : "var(--red)" }}>
              {money(s.totalPnl)}
            </div>
          </div>
          <div className="stat">
            <div className="k">交易筆數</div>
            <div className="v">{s.trades}<span className="hint"> （{s.wins} 勝 / {s.losses} 敗）</span></div>
          </div>
          <div className="stat">
            <div className="k">獲利因子</div>
            <div className="v">{s.profitFactor ?? "-"}</div>
          </div>
          <div className="stat">
            <div className="k">平均每筆</div>
            <div className="v">{money(s.avgPnl)}</div>
          </div>
          <div className="stat">
            <div className="k">平均 R 倍數</div>
            <div className="v">{s.avgR ?? "-"}</div>
          </div>
          <div className="stat">
            <div className="k">平均獲利 / 平均虧損</div>
            <div className="v">
              <span style={{ color: "var(--green)" }}>{s.avgWin.toFixed(2)}</span>
              {" / "}
              <span style={{ color: "var(--red)" }}>{s.avgLoss.toFixed(2)}</span>
            </div>
          </div>
          <div className="stat">
            <div className="k">最佳 / 最差</div>
            <div className="v">{money(s.best)} / {money(s.worst)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function StatsPage() {
  const [authed, setAuthed] = useState(false);
  const [error, setError] = useState("");
  const [data, setData] = useState<any>(null);
  const [page, setPage] = useState(0);

  const load = useCallback(async () => {
    const { status, body } = await apiFetch("/api/stats");
    if (status === 200) {
      setData(body);
      setAuthed(true);
      setError("");
    } else {
      setAuthed(false);
      setError(body?.needsSetup ? "" : body?.error ?? `HTTP ${status}`);
    }
  }, []);

  async function clearHistory() {
    if (!confirm("確定清空交易歷史？勝率與損益統計會全部歸零，無法復原。")) return;
    const { status, body } = await apiFetch("/api/stats/clear", { method: "POST" });
    if (status === 200) {
      setPage(0);
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
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [authed, load]);

  if (!authed) {
    return (
      <div>
        <LoginPanel onAuthed={load} />
        {error && (
          <div className="msg err" style={{ maxWidth: 460, margin: "0 auto" }}>{error}</div>
        )}
      </div>
    );
  }

  const recent = (data?.recent ?? []) as any[];
  const rows = recent.slice(page * PER_PAGE, (page + 1) * PER_PAGE);
  const bySymbol = (data?.bySymbol ?? []) as any[];

  return (
    <div>
      <h1>績效</h1>

      <Summary title="真實交易" s={data.live} />
      <Summary title="模擬交易" s={data.dry} />

      {bySymbol.length > 0 && (
        <>
          <h2>各幣種（真實）</h2>
          <div className="panel">
            <div style={{ overflowX: "auto" }}>
              <table>
                <thead>
                  <tr><th>幣種</th><th>筆數</th><th>勝率</th><th>損益 (USDT)</th></tr>
                </thead>
                <tbody>
                  {bySymbol.map((r) => (
                    <tr key={r.symbol}>
                      <td className="mono">{r.symbol}</td>
                      <td>{r.trades}</td>
                      <td>{r.winRate}%</td>
                      <Pnl v={r.pnl} />
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="hint" style={{ marginTop: 8 }}>由虧損最多排到最賺，方便找出該加入黑名單的幣種。</p>
          </div>
        </>
      )}

      <h2>交易紀錄</h2>
      <div className="panel">
        <div style={{ overflowX: "auto" }}>
          <table>
            <thead>
              <tr>
                <th>結束時間</th><th>幣種</th><th>方向</th><th>槓桿</th>
                <th>進場</th><th>出場</th><th>損益</th><th>%</th><th>R</th>
                <th>加倉</th><th>結束原因</th><th>模式</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={12} className="hint">還沒有已結束的交易。</td></tr>
              ) : (
                rows.map((t, i) => (
                  <tr key={i}>
                    <td className="mono">{fmtTime(t.closedAt)}</td>
                    <td className="mono">{t.symbol}</td>
                    <td className={t.side === "long" ? "side-long" : "side-short"}>
                      {t.side === "long" ? "多" : "空"}
                    </td>
                    <td>{t.leverage}x</td>
                    <td className="mono">{t.entryPrice}</td>
                    <td className="mono">{t.exitPrice}</td>
                    <Pnl v={t.pnlUsdt} />
                    <td className="mono">{t.pnlPercent}%</td>
                    <td className="mono">{t.rMultiple ?? "-"}</td>
                    <td>{t.addCount}</td>
                    <td>{t.reason}</td>
                    <td>{t.dryRun ? "模擬" : "真實"}</td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
        <Pager page={page} total={recent.length} onPage={setPage} />
        {recent.length > 0 && (
          <button onClick={clearHistory} className="secondary" style={{ marginTop: 14 }}>
            🧹 清空交易歷史
          </button>
        )}
        <p className="hint" style={{ marginTop: 8 }}>
          損益是每筆交易所有分批平倉加總後的實際結果。
          交易所端止損觸發的單子，出場價以止損價估算，可能與實際成交有些許差異。
        </p>
      </div>
    </div>
  );
}

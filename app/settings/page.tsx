"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch, getStoredPassword } from "../client";
import LoginPanel from "../LoginPanel";

export default function SettingsPage() {
  const [authed, setAuthed] = useState(false);
  const [monitorInfo, setMonitorInfo] = useState<{ url: string; secret: string } | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // form state
  const [botToken, setBotToken] = useState("");
  const [allowedChats, setAllowedChats] = useState("");
  const [reactToEdits, setReactToEdits] = useState(true);
  const [apiKey, setApiKey] = useState("");
  const [apiSecret, setApiSecret] = useState("");
  const [baseUrl, setBaseUrl] = useState("https://api.pionex.com");
  const [symbolFormat, setSymbolFormat] = useState("{base}_{quote}");
  const [liveTrading, setLiveTrading] = useState(false);
  const [sizingMode, setSizingMode] = useState("fixed_usdt");
  const [fixedUsdt, setFixedUsdt] = useState(100);
  const [percentBalance, setPercentBalance] = useState(5);
  const [addPositionUsdt, setAddPositionUsdt] = useState(0);
  const [levDefault, setLevDefault] = useState(10);
  const [levMax, setLevMax] = useState(20);
  const [whitelist, setWhitelist] = useState("");
  const [blacklist, setBlacklist] = useState("");
  const [maxOpenPositions, setMaxOpenPositions] = useState(5);
  const [maxAdds, setMaxAdds] = useState(2);
  const [cooldown, setCooldown] = useState(30);
  const [maxAge, setMaxAge] = useState(120);
  const [entryType, setEntryType] = useState("market");
  const [attachSl, setAttachSl] = useState(true);
  const [attachTp, setAttachTp] = useState(true);
  const [splitTp, setSplitTp] = useState(true);
  const [rtpEnabled, setRtpEnabled] = useState(false);
  const [rtpLevels, setRtpLevels] = useState("1:50");
  const [trailEnabled, setTrailEnabled] = useState(false);
  const [trailActivate, setTrailActivate] = useState(2);
  const [trailCallback, setTrailCallback] = useState(1);
  const [beOnTp1, setBeOnTp1] = useState(true);
  const [beOffset, setBeOffset] = useState(0.2);
  const [requireEntrySl, setRequireEntrySl] = useState(true);
  const [ignoreKeywords, setIgnoreKeywords] = useState("");

  const load = useCallback(async () => {
    const { status, body } = await apiFetch("/api/settings");
    if (status !== 200) {
      setAuthed(false);
      setError(body?.needsSetup ? "" : body?.error ?? `HTTP ${status}`);
      return;
    }
    setAuthed(true);
    setError("");
    setMonitorInfo(body.monitor ?? null);
    const s = body.settings;
    setBotToken(s.telegram.botToken ?? "");
    setAllowedChats((s.telegram.allowedChats ?? []).join(", "));
    setReactToEdits(!!s.telegram.reactToEdits);
    setApiKey(s.pionex.apiKey ?? "");
    setApiSecret(s.pionex.apiSecret ?? "");
    setBaseUrl(s.pionex.baseUrl ?? "https://api.pionex.com");
    setSymbolFormat(s.pionex.symbolFormat ?? "{base}_{quote}");
    setLiveTrading(!!s.trading.liveTrading);
    setSizingMode(s.trading.sizing.mode);
    setFixedUsdt(s.trading.sizing.fixedUsdt);
    setPercentBalance(s.trading.sizing.percentBalance);
    setAddPositionUsdt(s.trading.addPositionUsdt ?? 0);
    setLevDefault(s.trading.leverage.default);
    setLevMax(s.trading.leverage.max);
    setWhitelist((s.trading.risk.symbolWhitelist ?? []).join(", "));
    setBlacklist((s.trading.risk.symbolBlacklist ?? []).join(", "));
    setMaxOpenPositions(s.trading.risk.maxOpenPositions);
    setMaxAdds(s.trading.risk.maxAddsPerPosition);
    setCooldown(s.trading.risk.cooldownSeconds);
    setMaxAge(s.trading.risk.maxSignalAgeSeconds);
    setEntryType(s.trading.orders.entryType);
    setAttachSl(!!s.trading.orders.attachStopLoss);
    setAttachTp(!!s.trading.orders.attachTakeProfit);
    setSplitTp(s.trading.orders.splitTakeProfit !== false);
    const rtp = s.trading.orders.rTakeProfit ?? { enabled: false, levels: [] };
    setRtpEnabled(!!rtp.enabled);
    setRtpLevels(
      (rtp.levels ?? []).map((l: any) => `${l.r}:${l.closePercent}`).join(", ") || "1:50"
    );
    setTrailEnabled(!!s.trading.trailing.enabled);
    setTrailActivate(s.trading.trailing.activateProfitPercent);
    setTrailCallback(s.trading.trailing.callbackPercent);
    setBeOnTp1(s.trading.trailing.moveToBreakevenOnTp1 !== false);
    setBeOffset(s.trading.trailing.breakevenOffsetPercent ?? 0.2);
    setRequireEntrySl(s.trading.risk.requireEntryAndSl !== false);
    setIgnoreKeywords((s.filters.ignoreKeywords ?? []).join(", "));
  }, []);

  useEffect(() => {
    if (getStoredPassword()) load();
  }, [load]);

  const splitList = (v: string) =>
    v.split(/[,\n]/).map((x) => x.trim()).filter(Boolean);

  async function save() {
    setSaving(true);
    setMsg(null);
    const { status, body } = await apiFetch("/api/settings", {
      method: "POST",
      body: JSON.stringify({
        telegram: {
          botToken,
          allowedChats: splitList(allowedChats),
          reactToEdits,
        },
        pionex: { apiKey, apiSecret, baseUrl, symbolFormat },
        trading: {
          liveTrading,
          sizing: {
            mode: sizingMode,
            fixedUsdt: Number(fixedUsdt),
            percentBalance: Number(percentBalance),
          },
          addPositionUsdt: Number(addPositionUsdt),
          leverage: { default: Number(levDefault), max: Number(levMax) },
          risk: {
            symbolWhitelist: splitList(whitelist).map((s) => s.toUpperCase()),
            symbolBlacklist: splitList(blacklist).map((s) => s.toUpperCase()),
            maxOpenPositions: Number(maxOpenPositions),
            maxAddsPerPosition: Number(maxAdds),
            cooldownSeconds: Number(cooldown),
            maxSignalAgeSeconds: Number(maxAge),
            requireEntryAndSl: requireEntrySl,
          },
          orders: {
            entryType,
            attachStopLoss: attachSl,
            attachTakeProfit: attachTp,
            splitTakeProfit: splitTp,
            rTakeProfit: {
              enabled: rtpEnabled,
              levels: rtpLevels
                .split(/[,\n]/)
                .map((s) => s.trim())
                .filter(Boolean)
                .map((pair) => {
                  const [r, pct] = pair.split(":").map((x) => Number(x.trim()));
                  return { r, closePercent: pct };
                })
                .filter((l) => l.r > 0 && l.closePercent > 0),
            },
          },
          trailing: {
            enabled: trailEnabled,
            activateProfitPercent: Number(trailActivate),
            callbackPercent: Number(trailCallback),
            moveToBreakevenOnTp1: beOnTp1,
            breakevenOffsetPercent: Number(beOffset),
          },
        },
        filters: { ignoreKeywords: splitList(ignoreKeywords) },
      }),
    });
    setSaving(false);
    if (status === 200) {
      setMsg({ ok: true, text: "已儲存 ✅" + (body.durableStore ? "" : "（注意：未連接 KV，serverless 上不會保存）") });
      load();
    } else {
      setMsg({ ok: false, text: body?.error ?? `儲存失敗 (HTTP ${status})` });
    }
  }

  async function registerWebhook() {
    setMsg(null);
    const { status, body } = await apiFetch("/api/setup-webhook", { method: "POST" });
    if (status === 200) {
      const err = body.lastErrorMessage ? `；Telegram 最近錯誤：${body.lastErrorMessage}` : "";
      setMsg({
        ok: true,
        text: `✅ 已重新註冊並同步新密鑰。積壓更新：${body.pendingUpdateCount}${err}。回儀表板看「原始進站事件」確認訊息有進來。`,
      });
    } else {
      setMsg({ ok: false, text: body?.error ?? `註冊失敗 (HTTP ${status})` });
    }
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
      <h1>設定</h1>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Telegram 機器人</h2>
        <p className="hint">
          用 @BotFather 建立機器人取得 token，把機器人加入信號群組（頻道要設為管理員）。
          在群組中機器人預設收不到所有訊息，請對 BotFather 用 /setprivacy 設為 Disabled。
        </p>
        <label>Bot Token</label>
        <input type="text" value={botToken} onChange={(e) => setBotToken(e.target.value)}
               placeholder="123456:ABC-DEF..." />
        <label>監聽的群組／頻道（username 或數字 chat id，逗號分隔）</label>
        <input type="text" value={allowedChats} onChange={(e) => setAllowedChats(e.target.value)}
               placeholder="mysignalgroup, -1001234567890" />
        <div className="checkbox">
          <input type="checkbox" id="edits" checked={reactToEdits}
                 onChange={(e) => setReactToEdits(e.target.checked)} />
          <label htmlFor="edits" style={{ margin: 0 }}>訊息被編輯時視為新信號重新解析</label>
        </div>
        <button className="secondary" onClick={registerWebhook}>
          註冊 Telegram Webhook（儲存 token 後按這裡）
        </button>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>Pionex API</h2>
        <p className="hint">在 Pionex 的 API 管理建立金鑰；只開交易權限，不要開提現。</p>
        <div className="row">
          <div>
            <label>API Key</label>
            <input type="text" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
          </div>
          <div>
            <label>API Secret</label>
            <input type="password" value={apiSecret} onChange={(e) => setApiSecret(e.target.value)} />
          </div>
        </div>
        <label>API Base URL</label>
        <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <label>
          合約代碼格式（{"{base}"}=幣種、{"{quote}"}=計價幣）— 若下單出現
          TRADE_INVALID_SYMBOL，用「其他」頁的 Pionex 探測查真實格式後改這裡
        </label>
        <input type="text" value={symbolFormat}
               onChange={(e) => setSymbolFormat(e.target.value)}
               placeholder="{base}_{quote}" />
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>交易</h2>
        <div className="checkbox">
          <input type="checkbox" id="live" checked={liveTrading}
                 onChange={(e) => setLiveTrading(e.target.checked)} />
          <label htmlFor="live" style={{ margin: 0, color: "var(--red)" }}>
            ⚠️ 啟用真實下單（LIVE）— 未勾選時所有信號只做模擬
          </label>
        </div>
        <div className="row3">
          <div>
            <label>部位大小模式</label>
            <select value={sizingMode} onChange={(e) => setSizingMode(e.target.value)}>
              <option value="fixed_usdt">固定 USDT</option>
              <option value="percent_balance">餘額百分比</option>
              <option value="signal">依信號指定（無則用固定值）</option>
            </select>
          </div>
          <div>
            <label>固定金額 (USDT)</label>
            <input type="number" value={fixedUsdt} onChange={(e) => setFixedUsdt(+e.target.value)} />
          </div>
          <div>
            <label>餘額百分比 (%)</label>
            <input type="number" value={percentBalance} onChange={(e) => setPercentBalance(+e.target.value)} />
          </div>
        </div>
        <div className="row3">
          <div>
            <label>加倉金額 (USDT，0 = 同主要設定)</label>
            <input type="number" value={addPositionUsdt} onChange={(e) => setAddPositionUsdt(+e.target.value)} />
          </div>
          <div>
            <label>預設槓桿</label>
            <input type="number" value={levDefault} onChange={(e) => setLevDefault(+e.target.value)} />
          </div>
          <div>
            <label>槓桿上限</label>
            <input type="number" value={levMax} onChange={(e) => setLevMax(+e.target.value)} />
          </div>
        </div>
        <div className="row">
          <div>
            <label>進場單類型</label>
            <select value={entryType} onChange={(e) => setEntryType(e.target.value)}>
              <option value="market">市價 (market)</option>
              <option value="limit">限價 (limit，用信號的入場價)</option>
            </select>
          </div>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 16 }}>
            <div className="checkbox">
              <input type="checkbox" id="asl" checked={attachSl}
                     onChange={(e) => setAttachSl(e.target.checked)} />
              <label htmlFor="asl" style={{ margin: 0 }}>套用信號止損</label>
            </div>
            <div className="checkbox">
              <input type="checkbox" id="atp" checked={attachTp}
                     onChange={(e) => setAttachTp(e.target.checked)} />
              <label htmlFor="atp" style={{ margin: 0 }}>套用信號止盈</label>
            </div>
          </div>
        </div>
        <div className="checkbox">
          <input type="checkbox" id="splittp" checked={splitTp}
                 onChange={(e) => setSplitTp(e.target.checked)} />
          <label htmlFor="splittp" style={{ margin: 0 }}>
            分批止盈：每個止盈價位平掉一部分（例如兩檔各平一半、三檔各平 1/3，
            最後一檔平剩餘）。取消勾選＝第一個止盈就全部平倉。
          </label>
        </div>

        <div className="checkbox" style={{ marginTop: 16 }}>
          <input type="checkbox" id="rtp" checked={rtpEnabled}
                 onChange={(e) => setRtpEnabled(e.target.checked)} />
          <label htmlFor="rtp" style={{ margin: 0 }}>
            啟用「R 倍數分批止盈」（依進場到止損的風險倍數提前止盈一部分）
          </label>
        </div>
        <label>R 止盈設定（格式 <code>R:平倉%</code>，逗號分隔）</label>
        <input type="text" value={rtpLevels}
               onChange={(e) => setRtpLevels(e.target.value)}
               placeholder="1:50, 2:30, 3:20" />
        <p className="hint">
          R = 進場價到止損價的距離（單筆風險）。例如 <code>1:50, 2:30</code> 代表：
          帳面獲利到達 <b>1R</b> 先平倉 <b>50%</b>，到達 <b>2R</b> 再平 <b>30%</b>
          （比例以「原始倉位」計算）。需要信號有止損才會啟用；與上面的價位止盈可並存。
        </p>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>移動止損（trailing stop）</h2>
        <p className="hint">
          由監控端點每次執行時檢查：獲利達「啟動門檻」後，止損會跟在最新價格後方
          「回撤距離」處，只上移不下移。信號的止盈止損也由同一個端點監控觸發。
        </p>
        {monitorInfo && (
          <div className="banner warn" style={{ wordBreak: "break-all" }}>
            <b>啟用監控（免費做法）：</b>到 cron-job.org 註冊，建立一個每分鐘執行的排程：
            <br />網址：<code>{monitorInfo.url}</code>
            <br />加一個 Header：<code>Authorization</code> ＝{" "}
            <code>Bearer {monitorInfo.secret}</code>
          </div>
        )}
        <div className="row3">
          <div className="checkbox" style={{ alignSelf: "end" }}>
            <input type="checkbox" id="trail" checked={trailEnabled}
                   onChange={(e) => setTrailEnabled(e.target.checked)} />
            <label htmlFor="trail" style={{ margin: 0 }}>啟用移動止損</label>
          </div>
          <div>
            <label>啟動門檻（價格獲利 %）</label>
            <input type="number" step="0.1" value={trailActivate}
                   onChange={(e) => setTrailActivate(+e.target.value)} />
          </div>
          <div>
            <label>回撤距離 (%)</label>
            <input type="number" step="0.1" value={trailCallback}
                   onChange={(e) => setTrailCallback(+e.target.value)} />
          </div>
        </div>
        <div className="row">
          <div className="checkbox" style={{ alignSelf: "end" }}>
            <input type="checkbox" id="betp1" checked={beOnTp1}
                   onChange={(e) => setBeOnTp1(e.target.checked)} />
            <label htmlFor="betp1" style={{ margin: 0 }}>
              觸及止盈一後把止損移到進場價附近（多單下方、空單上方）
            </label>
          </div>
          <div>
            <label>距進場價的偏移 (%)</label>
            <input type="number" step="0.05" value={beOffset}
                   onChange={(e) => setBeOffset(+e.target.value)} />
          </div>
        </div>
      </div>

      <div className="panel">
        <h2 style={{ marginTop: 0 }}>風控與過濾</h2>
        <div className="row">
          <div>
            <label>幣種白名單（留空 = 全部允許）</label>
            <input type="text" value={whitelist} onChange={(e) => setWhitelist(e.target.value)}
                   placeholder="BTCUSDT, ETHUSDT" />
          </div>
          <div>
            <label>幣種黑名單</label>
            <input type="text" value={blacklist} onChange={(e) => setBlacklist(e.target.value)} />
          </div>
        </div>
        <div className="row3">
          <div>
            <label>最大同時持倉數</label>
            <input type="number" value={maxOpenPositions} onChange={(e) => setMaxOpenPositions(+e.target.value)} />
          </div>
          <div>
            <label>單一持倉最大加倉次數</label>
            <input type="number" value={maxAdds} onChange={(e) => setMaxAdds(+e.target.value)} />
          </div>
          <div>
            <label>同幣種冷卻（秒）</label>
            <input type="number" value={cooldown} onChange={(e) => setCooldown(+e.target.value)} />
          </div>
        </div>
        <label>信號最大時效（秒，過舊的訊息不執行）</label>
        <input type="number" value={maxAge} onChange={(e) => setMaxAge(+e.target.value)} />
        <div className="checkbox">
          <input type="checkbox" id="reqsl" checked={requireEntrySl}
                 onChange={(e) => setRequireEntrySl(e.target.checked)} />
          <label htmlFor="reqsl" style={{ margin: 0 }}>
            開倉信號必須有進場價與止損才執行（建議開啟，避免分析文被誤判成信號）
          </label>
        </div>
        <label>忽略關鍵字（訊息含任一關鍵字即過濾，逗號分隔）— 用來擋數據公布、新聞、廣告</label>
        <textarea value={ignoreKeywords} onChange={(e) => setIgnoreKeywords(e.target.value)} />
      </div>

      <button onClick={save} disabled={saving}>{saving ? "儲存中..." : "儲存設定"}</button>
      {msg && <div className={`msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</div>}
    </div>
  );
}

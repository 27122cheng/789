/**
 * Executes parsed signals against Pionex (or simulates them in dry-run) and
 * maintains the bot's own position state in the KV store.
 *
 * Stop-loss / take-profit / trailing-stop are enforced "softly": the
 * /api/cron/monitor endpoint checks current prices against each position's
 * stored SL/TP levels and market-closes (fully for SL, per-target fraction
 * for TP) when a level is crossed, and ratchets the SL when trailing is
 * enabled. This works regardless of whether Pionex supports exchange-side
 * stop orders - but it is only as granular as how often the monitor runs.
 */
import { parseSignal, dedupKey, isFiltered } from "./parser";
import { AttachRejectedError, ExchangeClient } from "./exchange";
import { ceilToDecimals, floorToDecimals } from "./num";
import { PionexApiError, PionexClient } from "./pionex";
import { OkxClient } from "./okx";
import {
  appendOrder,
  appendSignal,
  checkAndMarkSeen,
  getCooldowns,
  getPositions,
  purgeSymbolRecords,
  savePositions,
  setCooldown,
} from "./store";
import { OrderRecord, ParsedSignal, Position, Settings } from "./types";

/** Raised when the venue's minimum order size exceeds the configured position
 *  size and the user chose to skip rather than trade bigger than intended. */
class BelowMinSizeError extends Error {}

function makeClient(settings: Settings): ExchangeClient {
  if (settings.exchange === "okx") {
    return new OkxClient(
      settings.okx.apiKey,
      settings.okx.apiSecret,
      settings.okx.passphrase,
      settings.okx.baseUrl,
      settings.okx.tdMode,
      settings.okx.demo
    );
  }
  return new PionexClient(
    settings.pionex.apiKey,
    settings.pionex.apiSecret,
    settings.pionex.baseUrl,
    settings.pionex.symbolFormat
  );
}

/** True when orders should really be sent: live mode + the selected venue's
 *  credentials are all present (OKX additionally needs a passphrase). */
function isLive(settings: Settings): boolean {
  if (!settings.trading.liveTrading) return false;
  if (settings.exchange === "okx") {
    return (
      !!settings.okx.apiKey && !!settings.okx.apiSecret && !!settings.okx.passphrase
    );
  }
  return !!settings.pionex.apiKey && !!settings.pionex.apiSecret;
}

async function record(
  action: OrderRecord["action"],
  pos: {
    symbol: string;
    side: string | null;
    sizeUsdt: number;
    qty: number;
    price: number | null;
    leverage: number;
  },
  live: boolean,
  success: boolean,
  message: string,
  orderIds: string[] = []
): Promise<OrderRecord> {
  const rec: OrderRecord = {
    at: Date.now(),
    action,
    symbol: pos.symbol,
    side: pos.side,
    sizeUsdt: pos.sizeUsdt,
    qty: pos.qty,
    price: pos.price,
    leverage: pos.leverage,
    dryRun: !live,
    success,
    message,
    orderIds,
  };
  await appendOrder(rec);
  return rec;
}

// ------------------------------------------------------------------ sizing
/**
 * The POSITION VALUE (notional) to open, in USDT.
 *
 * The configured amount is normally the margin committed, so the position is
 * that amount times the leverage - 10 USDT at 20x opens a 200 USDT position.
 * Set basis "notional" to have the amount mean the position value itself, with
 * leverage only affecting how much margin it ties up.
 */
async function computeSizeUsdt(
  settings: Settings,
  signal: ParsedSignal,
  client: ExchangeClient,
  live: boolean,
  forAdd: boolean,
  leverage: number
): Promise<number> {
  const sizing = settings.trading.sizing;
  const lev = sizing.basis === "notional" ? 1 : Math.max(1, leverage);

  if (forAdd && settings.trading.addPositionUsdt > 0) {
    return (signal.sizeUsdt ?? settings.trading.addPositionUsdt) * lev;
  }
  if (sizing.mode === "signal" && signal.sizeUsdt && signal.sizeUsdt > 0) {
    // an amount named by the signal is taken at face value
    return signal.sizeUsdt;
  }
  if (sizing.mode === "percent_balance") {
    if (!live) return sizing.fixedUsdt * lev; // no balance to query in dry-run
    const balance = await client.getAvailableUsdt();
    if (balance <= 0) throw new Error(`available balance is ${balance}`);
    return ((balance * sizing.percentBalance) / 100) * lev;
  }
  return sizing.fixedUsdt * lev;
}

function computeLeverage(settings: Settings, signal: ParsedSignal): number {
  const cfg = settings.trading.leverage;
  // Signals from 加密掃描 Pro usually omit leverage; which value to fall back
  // to is configurable, defaulting to the maximum.
  const fallback = cfg.whenUnspecified === "default" ? cfg.default : cfg.max;
  const lev = signal.leverage ?? fallback;
  return Math.min(Math.max(lev, 1), cfg.max);
}

async function fetchPriceSafe(
  client: ExchangeClient,
  symbol: string,
  fallback: number | null
): Promise<number | null> {
  try {
    return await client.getPrice(client.perpSymbol(symbol));
  } catch {
    return fallback;
  }
}

function venueName(settings: Settings): string {
  return settings.exchange === "okx" ? "OKX" : "Pionex";
}

/** True for rejections caused by the account/credentials rather than by this
 *  particular order: API permissions, a wrong passphrase, a demo-vs-live key
 *  mismatch, the wrong account mode. Retrying, resizing or switching to a
 *  market order cannot help, so the trade must fail loudly rather than fall
 *  back to a watcher that is guaranteed to fail later too. */
function isPermissionDenied(msg: string): boolean {
  return (
    /TRADE_TYPE_DENIED|not in whitelist|user denied|PERMISSION|UNAUTHORIZED|FORBIDDEN/i.test(msg) ||
    /\b(50100|50101|50102|50103|50104|50105|50111|50112|50113|50114|51010)\b/.test(msg) ||
    /APIKey does not match|passphrase|invalid signature|invalid authorization/i.test(msg)
  );
}

/** Plain-Chinese cause + fix for the OKX credential/config errors that are
 *  otherwise just an opaque number. */
function okxCodeHint(msg: string): string | null {
  if (/\b50101\b|APIKey does not match/i.test(msg))
    return "（金鑰的環境不符：模擬盤金鑰要勾「使用 OKX 模擬盤」，正式盤金鑰要取消勾選。兩者不通用。）";
  if (/\b50105\b|passphrase/i.test(msg))
    return "（Passphrase 錯誤：那是你建立金鑰時自己設定的密碼，不是登入密碼。忘記只能刪掉重建金鑰。）";
  if (/\b(50111|50113)\b|invalid signature/i.test(msg))
    return "（API Key 或 Secret 有誤，常見原因是複製時多了空白。）";
  if (/\b50102\b/.test(msg))
    return "（請求時間戳過期，通常是暫時性問題，稍後會自動重試。）";
  if (/\b50110\b/.test(msg))
    return "（此金鑰綁了 IP 白名單，但 Vercel 的出口 IP 不固定 → 請把白名單清空。）";
  if (/\b51010\b/.test(msg))
    return "（帳戶模式不支援合約：請到 OKX 把帳戶模式改成「現貨和合約模式」以上。）";
  if (/\b51008\b/.test(msg))
    return "（可用保證金不足：確認 USDT 已從「資金帳戶」劃轉到「交易帳戶」。）";
  if (/posSide/i.test(msg))
    return "（持倉模式參數不符：系統會自動偵測單向／雙向持倉，若持續出現請重新儲存一次設定以清除快取。）";
  return null;
}

function permHint(settings: Settings): string {
  if (settings.exchange === "okx") {
    return (
      "（OKX 拒絕此金鑰下單：請確認 API 金鑰有勾選「交易」權限、Passphrase 正確、" +
      "IP 白名單有包含 Vercel（或先留空不限制），且帳戶已開通合約交易。）"
    );
  }
  return (
    "（此 Pionex 帳號的 API 未開通「合約 PERP」交易權限：Pionex 的合約 API 需要白名單，" +
    "一般帳號預設只能用 API 交易現貨。建議改用 OKX，其合約 API 對一般帳號開放。）"
  );
}

/** Align signal prices to Pionex's price precision per the user's rule:
 *  entry & stop-loss round UP (無條件進位), take-profits round DOWN (無條件縮減).
 *  If the precision can't be determined, values are left unchanged. */
async function alignPrices(
  client: ExchangeClient,
  symbol: string,
  p: { entry?: number | null; stopLoss?: number | null; takeProfits?: number[] }
): Promise<{ entry: number | null; stopLoss: number | null; takeProfits: number[] }> {
  const dec = await client.pricePrecision(symbol);
  const up = (v: number | null | undefined) =>
    v == null ? null : dec == null ? v : ceilToDecimals(v, dec);
  const down = (v: number) => (dec == null ? v : floorToDecimals(v, dec));
  return {
    entry: up(p.entry),
    stopLoss: up(p.stopLoss),
    takeProfits: (p.takeProfits ?? []).map(down),
  };
}

// -------------------------------------------------------------- risk gates
function riskReject(
  settings: Settings,
  signal: ParsedSignal,
  positions: Record<string, Position>,
  cooldowns: Record<string, number>
): string | null {
  const risk = settings.trading.risk;
  const sym = signal.symbol;

  const wl = risk.symbolWhitelist.map((s) => s.toUpperCase()).filter(Boolean);
  const bl = risk.symbolBlacklist.map((s) => s.toUpperCase()).filter(Boolean);
  if (wl.length && !wl.includes(sym)) return `${sym} not in whitelist`;
  if (bl.includes(sym)) return `${sym} is blacklisted`;

  const ageSec = (Date.now() - signal.timestamp) / 1000;
  if (ageSec > risk.maxSignalAgeSeconds)
    return `signal is ${Math.round(ageSec)}s old (max ${risk.maxSignalAgeSeconds}s)`;

  const last = cooldowns[sym];
  if (
    signal.action === "open" &&
    last &&
    (Date.now() - last) / 1000 < risk.cooldownSeconds
  ) {
    // The cooldown exists to stop a symbol being re-entered immediately after
    // it closed, so it applies to opens only. Adds are authorised steps in the
    // provider's own sequence, and management signals (stop moves, fills,
    // cancels, closes) must always get through - a blocked stop update is a
    // risk, not a duplicate. Re-delivery is already handled by dedup.
    return `cooldown active for ${sym}`;
  }

  if (signal.action === "open") {
    if (positions[sym]) return `position already open for ${sym}`;
    if (Object.keys(positions).length >= risk.maxOpenPositions)
      return `max open positions reached (${risk.maxOpenPositions})`;
    if (
      risk.requireEntryAndSl &&
      (signal.entryPrice === null || signal.stopLoss === null)
    )
      return "open signal has no entry price or stop loss (requireEntryAndSl)";
  }
  if (signal.action === "add") {
    const pos = positions[sym];
    if (!pos) return `no open position for ${sym} to add to`;
    if (pos.addCount >= risk.maxAddsPerPosition)
      return `max adds per position reached (${risk.maxAddsPerPosition})`;
  }
  return null;
}

// --------------------------------------------------------------- open / add
async function placeEntry(
  client: ExchangeClient,
  live: boolean,
  symbol: string,
  side: "long" | "short",
  sizeUsdt: number,
  entryType: "market" | "limit",
  limitPrice: number | null,
  refPrice: number | null,
  leverage?: number,
  belowMinSize: "lift" | "skip" = "lift",
  // attached to the entry order so the position is protected the instant it
  // fills, with no dependence on the monitor
  protect?: { stopLoss: number | null; takeProfit: number | null }
): Promise<{ qty: number; price: number; orderIds: string[]; note: string; attached: boolean }> {
  const perp = client.perpSymbol(symbol);
  const price = limitPrice ?? refPrice;
  if (!price || price <= 0) throw new Error(`no price available for ${symbol}`);
  let qty = sizeUsdt / price;

  if (!live) {
    return {
      qty,
      price,
      orderIds: [],
      note: `dry-run: simulated ${entryType} ${side} ${symbol} ${sizeUsdt} USDT @ ${price}`,
      attached: false,
    };
  }

  // Venues where leverage is an instrument setting (OKX) need it applied
  // before the order, otherwise the position uses whatever was set last.
  if (leverage && client.setLeverage) {
    await client.setLeverage(perp, leverage).catch(() => {
      /* non-fatal: the order still goes out at the account's current leverage */
    });
  }

  // Snap quantity to the contract's size step (round down) and lift it to the
  // minimum order size, so it passes the venue's SIZE filter.
  const f = await client.orderFilters(symbol);
  const baseDec = f.baseDecimals ?? 6;
  const minSize = entryType === "limit" ? f.minSizeLimit : f.minSizeMarket;
  qty = floorToDecimals(qty, baseDec);
  // The venue's minimum can exceed the configured position size (e.g. OKX's
  // 0.01 BTC-USDT-SWAP contract is worth ~6.4 USDT). Lifting silently would
  // put more at risk than the user asked for, so the record says so.
  let liftedNote = "";
  if (minSize && qty < minSize) {
    if (belowMinSize === "skip") {
      throw new BelowMinSizeError(
        `${symbol} 需要至少 ${minSize}（約 ${(minSize * price).toFixed(2)} USDT），` +
        `高於設定的 ${sizeUsdt} USDT，依設定跳過這筆`
      );
    }
    qty = minSize;
    liftedNote =
      ` ⚠️ 低於交易所最低下單量，已提高到 ${minSize}` +
      `（實際名目 ${(qty * price).toFixed(2)} USDT，設定為 ${sizeUsdt} USDT）`;
  } else {
    // Sizes come in fixed increments, so the configured amount is rounded
    // DOWN to the next step (never up - that would exceed the intended risk).
    // On expensive coins one step can be worth several USDT, making the real
    // position noticeably smaller than configured, so say so.
    const actual = qty * price;
    if (actual < sizeUsdt * 0.98) {
      const step = Math.pow(10, -baseDec);
      liftedNote =
        ` ⚠️ 已向下對齊下單階梯（實際名目 ${actual.toFixed(2)} USDT，` +
        `設定為 ${sizeUsdt} USDT；每階約 ${(step * price).toFixed(2)} USDT）`;
    }
  }
  const qtyStr = qty.toFixed(baseDec);

  const apiSide = side === "long" ? "BUY" : "SELL";
  const attach =
    protect && (protect.stopLoss != null || protect.takeProfit != null)
      ? { stopLoss: protect.stopLoss, takeProfit: protect.takeProfit }
      : undefined;
  let attached = !!attach;
  let resp: Awaited<ReturnType<typeof client.placeOrder>>;
  const send = (withAttach: boolean) => {
    const common = { symbol: perp, side: apiSide, size: qtyStr } as const;
    const extra = withAttach && attach ? { attach } : {};
    if (entryType === "limit" && limitPrice) {
      // align the limit price to the price step to pass the PRICE filter
      const priceStr =
        f.quoteDecimals == null ? String(limitPrice) : limitPrice.toFixed(f.quoteDecimals);
      return client.placeOrder({ ...common, type: "LIMIT", price: priceStr, ...extra });
    }
    // market order: size-based for both directions (perp) - no price filter
    return client.placeOrder({ ...common, type: "MARKET", ...extra });
  };

  try {
    resp = await send(true);
  } catch (err) {
    // Only the attached levels were rejected, so the order was never created:
    // place it bare rather than losing the trade, and let the monitor add the
    // protection separately.
    if (err instanceof AttachRejectedError) {
      attached = false;
      resp = await send(false);
    } else {
      throw err;
    }
  }
  const oid = resp.orderId;
  return {
    qty,
    price,
    orderIds: oid ? [oid] : [],
    note:
      `${entryType} ${side} order placed (qty ${qtyStr})${liftedNote}` +
      (attached ? "；已附帶止盈止損" : ""),
    attached,
  };
}

/**
 * The first target still BEYOND `entry` in the trade's direction, falling back to
 * the furthest one.
 *
 * An add enters later and further along than the main position, so the first
 * target can already be behind it - attaching 止盈一 to a tranche that entered
 * above it would take a loss the moment it fills, or be rejected outright.
 */
function targetBeyond(
  side: "long" | "short",
  entry: number,
  takeProfits: number[]
): number | null {
  if (!takeProfits.length) return null;
  const beyond = takeProfits.filter((t) =>
    side === "long" ? t > entry : t < entry
  );
  return beyond.length ? beyond[0] : takeProfits[takeProfits.length - 1];
}

/**
 * How the remaining position is divided across its take-profit targets - the
 * same rule the monitor applies, so the exchange orders and the monitor agree:
 * with 分批止盈 on, each target closes an equal share of the ORIGINAL size and
 * the last one closes whatever is left; with it off, the first target closes
 * everything.
 */
function tpSlices(
  settings: Settings,
  pos: Position
): { price: number; size: number }[] {
  const tps = pos.takeProfits ?? [];
  if (!tps.length || pos.qty <= 0) return [];
  if (settings.trading.orders.splitTakeProfit === false) {
    return [{ price: tps[0], size: pos.qty }];
  }
  const share =
    pos.tpCountOriginal > 0 ? pos.originalQty / pos.tpCountOriginal : pos.qty;
  const out: { price: number; size: number }[] = [];
  let left = pos.qty;
  tps.forEach((price, i) => {
    if (left <= 0) return;
    const size = i === tps.length - 1 ? left : Math.min(left, share);
    if (size > 0) {
      out.push({ price, size });
      left -= size;
    }
  });
  return out;
}

/**
 * Mirror the position's stop-loss and take-profit targets onto the exchange as
 * resting orders, so it is protected even if this app stops running.
 *
 * Cancel-and-replace, because the levels and the remaining size both move
 * (trailing, breakeven, partial take-profits). Failures are reported but never
 * abort the trade: the monitor remains the working stop, the exchange order is
 * a safety net on top of it.
 */
async function syncExchangeStops(
  client: ExchangeClient,
  settings: Settings,
  live: boolean,
  pos: Position
): Promise<string | null> {
  if (!settings.trading.orders.exchangeStops) return null;
  if (!live || pos.dryRun) return null;
  if (!client.placeStopOrders || !client.cancelStopOrders) return null;

  const venue = client.perpSymbol(pos.symbol);
  try {
    // If the existing orders cannot be enumerated and cancelled, placing more
    // would stack a second set on top of live ones. Better to leave what is
    // already there and report it than to duplicate protection.
    await client.cancelStopOrders(venue);
    if (pos.qty <= 0) return null;
    const sl = pos.stopLoss;
    const takeProfits = tpSlices(settings, pos);
    if (sl == null && !takeProfits.length) return null;
    const ids = await client.placeStopOrders({
      symbol: venue,
      side: pos.side === "long" ? "SELL" : "BUY", // closing side
      size: String(pos.qty),
      stopLoss: sl,
      takeProfits: takeProfits.map((t) => ({ price: t.price, size: String(t.size) })),
    });
    const tpDesc = takeProfits.length
      ? takeProfits.map((t) => t.price).join("/")
      : "-";
    return `交易所止盈止損已掛（SL ${sl ?? "-"} / TP ${tpDesc}，共 ${ids.length} 張）`;
  } catch (err) {
    return `⚠️ 交易所止盈止損掛單失敗：${(err as Error).message}（本系統監控仍會執行）`;
  }
}

async function closeQty(
  client: ExchangeClient,
  live: boolean,
  pos: Position,
  qty: number
): Promise<string[]> {
  if (!live || pos.dryRun) return [];
  const perp = client.perpSymbol(pos.symbol);
  const apiSide = pos.side === "long" ? "SELL" : "BUY";
  // perp close: size-based market order in the opposite direction, size
  // snapped to the contract step
  const f = await client.orderFilters(pos.symbol);
  const baseDec = f.baseDecimals ?? 6;
  const sizeStr = floorToDecimals(qty, baseDec).toFixed(baseDec);
  const resp = await client.placeOrder({
    symbol: perp, side: apiSide, type: "MARKET", size: sizeStr, reduceOnly: true,
  });
  return resp.orderId ? [resp.orderId] : [];
}

// ------------------------------------------------------------ main handler
export async function handleIncomingMessage(
  text: string,
  meta: { chatId: string; messageId: number; timestamp: number },
  settings: Settings
): Promise<void> {
  // 1. noise filter (news, data releases, ads ...) - dropped silently, no record
  if (isFiltered(text, settings.filters.ignoreKeywords)) {
    return;
  }

  // 2. parse
  const signal = parseSignal(text, meta, {
    ignoreKeywords: settings.filters.ignoreKeywords,
    extraLongKeywords: settings.filters.extraLongKeywords,
    extraShortKeywords: settings.filters.extraShortKeywords,
  });
  if (!signal) {
    // not a trade signal (chatter / analysis) - dropped silently, no record
    return;
  }

  // 3. dedup (covers Telegram redeliveries; edits get a new content digest)
  if (await checkAndMarkSeen(dedupKey(signal))) return;

  // cancels run silently in the background: no signal/order records, and the
  // cancelled trade's earlier records are purged from the logs
  if (signal.action === "cancel") {
    await executeSignal(signal, settings);
    return;
  }

  await appendSignal({
    at: Date.now(), chatId: meta.chatId, messageId: meta.messageId,
    action: signal.action, symbol: signal.symbol, side: signal.side,
    summary:
      `${signal.action} ${signal.symbol}` +
      (signal.side ? ` ${signal.side}` : "") +
      (signal.stopLoss ? ` SL=${signal.stopLoss}` : "") +
      (signal.stopLossBreakeven ? " SL=breakeven" : "") +
      (signal.takeProfits.length ? ` TP=${signal.takeProfits.join("/")}` : ""),
    rawText: text.slice(0, 500),
  });

  await executeSignal(signal, settings);
}

export async function executeSignal(
  signal: ParsedSignal,
  settings: Settings
): Promise<void> {
  const live = isLive(settings);
  const client = makeClient(settings);
  const positions = await getPositions();
  const cooldowns = await getCooldowns();
  const sym = signal.symbol;
  const pos = positions[sym];

  // 長線單升級信號 for an already-open position: update its SL/TP and attach
  // the 加倉計劃 instead of rejecting as a duplicate open.
  if (signal.action === "open" && signal.upgrade && pos) {
    const maxAdds = settings.trading.risk.maxAddsPerPosition;
    const aligned = await alignPrices(client, sym, {
      stopLoss: signal.stopLoss,
      takeProfits: signal.takeProfits,
    });
    if (aligned.stopLoss != null) pos.stopLoss = aligned.stopLoss;
    if (aligned.takeProfits.length) {
      pos.takeProfits = [...aligned.takeProfits].sort((a, b) =>
        pos.side === "long" ? a - b : b - a);
      pos.tpCountOriginal = Math.max(pos.tpCountOriginal, pos.takeProfits.length);
    }
    pos.pendingAdds = signal.addLevels
      .slice(0, Math.max(0, maxAdds - pos.addCount))
      .map((level) => ({ level, armedAt: null, armed: false }));
    await savePositions(positions);
    await syncExchangeStops(client, settings, live, pos);
    await record("upgrade",
      { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: aligned.stopLoss, leverage: pos.leverage },
      live, true,
      `長線單升級: SL=${aligned.stopLoss ?? "unchanged"} TP=${aligned.takeProfits.join("/") || "unchanged"}` +
        (pos.pendingAdds.length ? ` 加倉位=${pos.pendingAdds.map((a) => a.level).join("/")}` : ""));
    return;
  }

  // Risk-control rejections (duplicate position, max open positions, cooldown,
  // stale signal, whitelist ...) are expected and only cause confusion in the
  // log, so they are dropped silently with no record. Genuine execution
  // failures (Pionex API errors) below ARE still recorded.
  const reject = riskReject(settings, signal, positions, cooldowns);
  if (reject) {
    return;
  }

  try {
    switch (signal.action) {
      case "open": {
        if (!signal.side) {
          return; // incomplete signal (no direction) - drop silently
        }
        const leverage = computeLeverage(settings, signal);
        const sizeUsdt = await computeSizeUsdt(settings, signal, client, live, false, leverage);
        // align signal prices to Pionex precision: entry/SL up, TP down
        const aligned = await alignPrices(client, sym, {
          entry: signal.entryPrice,
          stopLoss: signal.stopLoss,
          takeProfits: signal.takeProfits,
        });
        const refPrice = await fetchPriceSafe(client, sym, aligned.entry);
        const entryType = settings.trading.orders.entryType;
        const maxAdds = settings.trading.risk.maxAddsPerPosition;
        const slForRisk = settings.trading.orders.attachStopLoss ? aligned.stopLoss : null;
        const rt = settings.trading.orders.rTakeProfit;

        // fields shared by an immediately-filled and a pending (到價進場) position
        const common = {
          symbol: sym,
          side: signal.side,
          leverage,
          sizeUsdt,
          stopLoss: slForRisk,
          takeProfits: settings.trading.orders.attachTakeProfit
            ? [...aligned.takeProfits].sort((a, b) =>
                signal.side === "long" ? a - b : b - a)
            : [],
          tpCountOriginal: signal.takeProfits.length,
          pendingAdds: signal.addLevels
            .slice(0, maxAdds)
            .map((level) => ({ level, armedAt: null, armed: false })),
          entryOrderType: entryType,
          beMoved: false,
          openedAt: Date.now(),
          addCount: 0,
          dryRun: !live,
        };
        const mkR = (risk: number | null) =>
          rt?.enabled && risk
            ? rt.levels.map((l) => ({ r: l.r, closePercent: l.closePercent, done: false }))
            : [];

        // Last line of defence against stacking a second position on the same
        // symbol. The tracker already blocks a duplicate open, but it can be
        // out of sync with reality - records cleared, KV reset, a position
        // opened by hand, or a close that silently failed - and the exchange is
        // the only authority on what is actually held.
        if (live) {
          const venue = client.perpSymbol(sym);

          // A resting order counts too: it is a position waiting to happen, so
          // placing another would leave two orders that can BOTH fill. The
          // tracker blocks its own duplicates, so anything found here is
          // unknown to it - orphaned by cleared records, or placed by hand.
          const working = await client.getOpenOrders(venue).catch(() => []);
          if (working.length) {
            await record("open",
              { symbol: sym, side: signal.side, sizeUsdt, qty: 0, price: aligned.entry, leverage },
              live, false,
              `交易所已有 ${working.length} 筆 ${sym} 掛單（本系統未追蹤），` +
                `為避免重複進場已略過，未下任何單。請先到交易所確認或撤銷該掛單`);
            return;
          }

          const held = client.fetchPositions
            ? (await client.fetchPositions().catch(() => []))
                .find((p) => p.symbol === venue && p.qty > 0)
            : undefined;
          if (held) {
            if (held.side !== signal.side) {
              // opposite direction: opening would hedge or flip the position,
              // which no signal asked for. Needs a human, so say so.
              await record("open",
                { symbol: sym, side: signal.side, sizeUsdt, qty: 0, price: aligned.entry, leverage },
                live, false,
                `交易所已有${held.side === "long" ? "多" : "空"}單持倉（${held.qty} @ ${held.entryPrice}），` +
                  `本次為${signal.side === "long" ? "多" : "空"}單訊號，方向衝突 → 已略過，未下任何單`);
              return;
            }
            // same direction: don't open again - adopt the existing position so
            // this signal's stop/targets manage it from here.
            const risk = slForRisk != null ? Math.abs(held.entryPrice - slForRisk) : null;
            positions[sym] = {
              ...common,
              entryPrice: held.entryPrice,
              qty: held.qty,
              originalQty: held.qty,
              initialRisk: risk,
              rTargets: mkR(risk),
              orderIds: [],
              pendingEntry: null,
            };
            await savePositions(positions);
            await setCooldown(sym, Date.now());
            const adoptNote = await syncExchangeStops(client, settings, live, positions[sym]);
            await record("open",
              { symbol: sym, side: signal.side, sizeUsdt, qty: held.qty, price: held.entryPrice, leverage },
              live, true,
              `交易所已有同向持倉（${held.qty} @ ${held.entryPrice}）→ 未重複下單，` +
                `改為接管並套用本次的止損／止盈` + (adoptNote ? `；${adoptNote}` : ""));
            return;
          }
        }

        // entryType "limit" + a target the market hasn't reached yet: rest a
        // REAL limit order on Pionex at the signal's entry price so it fills at
        // exactly that price. If Pionex rejects it (price band / filters), fall
        // back to 到價進場 - the monitor market-enters when price arrives.
        if (entryType === "limit" && aligned.entry != null && refPrice != null) {
          const dir: "up" | "down" = refPrice >= aligned.entry ? "down" : "up";
          const reached = dir === "down" ? refPrice <= aligned.entry : refPrice >= aligned.entry;
          if (!reached) {
            const risk = slForRisk != null ? Math.abs(aligned.entry - slForRisk) : null;
            let mode: "limit_order" | "watch" = "watch";
            let orderId: string | null = null;
            let pendQty = sizeUsdt / aligned.entry;
            let note = `掛單等待到價進場 @ ${aligned.entry}（現價 ${refPrice}）`;
            if (live) {
              try {
                const r = await placeEntry(
                  client, true, sym, signal.side, sizeUsdt, "limit", aligned.entry, refPrice, leverage,
                  settings.trading.orders.belowMinSize ?? "lift",
                  settings.trading.orders.exchangeStops
                    ? { stopLoss: slForRisk, takeProfit: common.takeProfits[0] ?? null }
                    : undefined
                );
                mode = "limit_order";
                orderId = r.orderIds[0] ?? null;
                pendQty = r.qty;
                note = `已在 ${venueName(settings)} 掛限價單 @ ${aligned.entry}（現價 ${refPrice}）`;
              } catch (err) {
                const emsg = (err as Error).message;
                // An account-permission rejection will hit the market fallback
                // too, so fail now instead of parking a position that cannot
                // ever be filled.
                if (isPermissionDenied(emsg)) {
                  await record("open",
                    { symbol: sym, side: signal.side, sizeUsdt, qty: 0, price: aligned.entry, leverage },
                    live, false, `${venueName(settings)} 拒絕下單：${emsg}${okxCodeHint(emsg) ?? permHint(settings)}`);
                  return;
                }
                // otherwise keep the trade alive: watch the price ourselves
                note =
                  `${venueName(settings)} 掛限價單被拒（${emsg}）` +
                  `→ 改用到價自動進場 @ ${aligned.entry}（現價 ${refPrice}）`;
              }
            }
            positions[sym] = {
              ...common,
              entryPrice: aligned.entry, // planned entry
              qty: 0,
              originalQty: 0,
              initialRisk: risk,
              rTargets: mkR(risk),
              orderIds: orderId ? [orderId] : [],
              pendingEntry: { target: aligned.entry, dir, mode, orderId, qty: pendQty },
            };
            await savePositions(positions);
            await setCooldown(sym, Date.now());
            await record("open",
              { symbol: sym, side: signal.side, sizeUsdt, qty: 0, price: aligned.entry, leverage },
              live, true, note, orderId ? [orderId] : []);
            return;
          }
        }

        // otherwise fill now at market
        const tpForAttach = common.takeProfits[0] ?? null;
        const res = await placeEntry(
          client, live, sym, signal.side, sizeUsdt, "market", null, refPrice ?? aligned.entry, leverage,
          settings.trading.orders.belowMinSize ?? "lift",
          settings.trading.orders.exchangeStops
            ? { stopLoss: slForRisk, takeProfit: tpForAttach }
            : undefined
        );
        const initialRisk =
          slForRisk != null ? Math.abs(res.price - slForRisk) : null;
        positions[sym] = {
          ...common,
          entryPrice: res.price,
          qty: res.qty,
          originalQty: res.qty,
          initialRisk,
          rTargets: mkR(initialRisk),
          orderIds: res.orderIds,
          pendingEntry: null,
        };
        await savePositions(positions);
        await setCooldown(sym, Date.now());
        // the attached levels already cover a single-target trade; only fall
        // back to separate orders when they cannot express it
        const needsExtraStops =
          !res.attached || tpSlices(settings, positions[sym]).length > 1;
        const stopNote = needsExtraStops
          ? await syncExchangeStops(client, settings, live, positions[sym])
          : null;
        await record("open",
          { symbol: sym, side: signal.side, sizeUsdt, qty: res.qty, price: res.price, leverage },
          live, true, res.note + (stopNote ? `；${stopNote}` : ""), res.orderIds);
        return;
      }

      case "add": {
        const p = pos!;
        const sizeUsdt = await computeSizeUsdt(settings, signal, client, live, true, p.leverage);
        const refPrice = await fetchPriceSafe(client, sym, signal.entryPrice ?? p.entryPrice);
        const addLive = live && !p.dryRun;

        // 加倉確認: the signal names a price to rest a limit order at ("回踩此價
        // 成交"), and the breakout it waits for has already been confirmed by
        // the sender. Rest a real order there instead of buying at market, and
        // leave the MAIN stop alone - the signal says it moves later, under its
        // own notice; the stop quoted here belongs to this tranche only.
        if (signal.entryPrice != null && addLive) {
          // The 請掛單 message quotes the stop that applies to the whole
          // position, so adopt it - keeping a stale one would ignore a stop the
          // provider has already moved. An add always runs on the position's
          // stop, never a tighter one of its own: that would let the added size
          // be stopped out alone while the rest kept running.
          const alignedAdd = await alignPrices(client, sym, {
            entry: signal.entryPrice,
            stopLoss: signal.stopLoss,
          });
          // 「成交後止損改至 X」only takes effect when the tranche fills, so it is
          // carried on the pending add rather than applied now.
          const afterFill = (
            await alignPrices(client, sym, { stopLoss: signal.stopLossAfterFill })
          ).stopLoss;
          const stopChanged =
            alignedAdd.stopLoss != null && alignedAdd.stopLoss !== p.stopLoss;
          if (alignedAdd.stopLoss != null) p.stopLoss = alignedAdd.stopLoss;
          const addLevel = alignedAdd.entry ?? signal.entryPrice;
          const r = await placeEntry(
            client, true, sym, p.side, sizeUsdt, "limit", addLevel, refPrice, p.leverage,
            settings.trading.orders.belowMinSize ?? "lift",
            settings.trading.orders.exchangeStops
              ? {
                  stopLoss: p.stopLoss,
                  takeProfit: targetBeyond(p.side, addLevel, p.takeProfits),
                }
              : undefined
          );
          p.pendingAdds = [
            ...(p.pendingAdds ?? []),
            {
              level: addLevel,
              armedAt: Date.now(),
              armed: true,
              orderId: r.orderIds[0] ?? null,
              qty: r.qty,
              sizeUsdt,
              stopLoss: p.stopLoss,
              stopLossAfterFill: afterFill,
              attached: r.attached,
            },
          ];
          await savePositions(positions);
          await setCooldown(sym, Date.now());
          // the size already held must follow the same stop
          const addSyncNote = stopChanged
            ? await syncExchangeStops(client, settings, live, p)
            : null;
          await record("add",
            { symbol: sym, side: p.side, sizeUsdt, qty: 0, price: addLevel, leverage: p.leverage },
            true, true,
            `加倉確認：已掛限價單 @ ${addLevel}（回踩成交）` +
              (r.attached
                ? `，已附帶止損 ${p.stopLoss ?? "-"}（與主倉相同）／止盈 ${targetBeyond(p.side, addLevel, p.takeProfits) ?? "-"}`
                : "") +
              (stopChanged ? `；止損同步更新為 ${p.stopLoss}` : "；止損維持 " + (p.stopLoss ?? "-")) +
              (afterFill != null ? `；成交後將改為 ${afterFill}` : "") +
              (addSyncNote ? `；${addSyncNote}` : ""),
            r.orderIds);
          return;
        }

        const res = await placeEntry(
          client, addLive, sym, p.side, sizeUsdt, "market", null, refPrice, p.leverage,
          settings.trading.orders.belowMinSize ?? "lift",
          settings.trading.orders.exchangeStops
            ? { stopLoss: p.stopLoss, takeProfit: p.takeProfits[0] ?? null }
            : undefined
        );
        const newQty = p.qty + res.qty;
        p.entryPrice = (p.entryPrice * p.qty + res.price * res.qty) / newQty;
        p.qty = newQty;
        p.originalQty += res.qty;
        p.sizeUsdt += sizeUsdt;
        p.addCount += 1;
        await savePositions(positions);
        await setCooldown(sym, Date.now());
        const addStopNote = await syncExchangeStops(client, settings, live, p);
        await record("add",
          { symbol: sym, side: p.side, sizeUsdt, qty: res.qty, price: res.price, leverage: p.leverage },
          live && !p.dryRun, true,
          `added to position (${p.addCount}x); ${res.note}` + (addStopNote ? `；${addStopNote}` : ""),
          res.orderIds);
        return;
      }

      case "add_plan": {
        // 加倉訊號: the level is announced but the 2-minute hold that rules out a
        // fake breakout has not happened yet. The 加倉確認｜請掛單 message is
        // what authorises the order, so nothing is placed here.
        await record("add_plan",
          { symbol: sym, side: pos?.side ?? signal.side, sizeUsdt: 0, qty: 0, price: signal.entryPrice, leverage: pos?.leverage ?? 0 },
          live, true,
          `加倉訊號已收到${signal.entryPrice ? `（加倉價位 ${signal.entryPrice}` : "（"}` +
            `${signal.stopLoss ? `，預計止損 ${signal.stopLoss}` : ""}）` +
            "；等「加倉確認｜請掛單」才會掛單");
        return;
      }

      case "add_cancel": {
        // 加倉掛單失效: pull the tranche's resting order. The POSITION stays -
        // only the unfilled add is withdrawn.
        if (!pos) return;
        const resting = (pos.pendingAdds ?? []).filter((a) => a.orderId);
        if (live && !pos.dryRun) {
          for (const a of resting) {
            await client.cancelOrder(client.perpSymbol(sym), String(a.orderId)).catch(() => {});
          }
        }
        pos.pendingAdds = (pos.pendingAdds ?? []).filter((a) => !a.orderId);
        await savePositions(positions);
        await record("add_cancel",
          { symbol: sym, side: pos.side, sizeUsdt: 0, qty: 0, price: resting[0]?.level ?? null, leverage: pos.leverage },
          live && !pos.dryRun, true,
          resting.length
            ? `加倉掛單失效 → 已撤銷 ${resting.length} 張加倉掛單（持倉不變）`
            : "加倉掛單失效 → 沒有待成交的加倉掛單，持倉不變");
        return;
      }

      case "close": {
        if (!pos) {
          return; // close signal for a symbol we don't hold - ignore silently
        }
        const ids = await closeQty(client, live, pos, pos.qty);
        if (live && !pos.dryRun && client.cancelStopOrders) {
          await client.cancelStopOrders(client.perpSymbol(sym)).catch(() => {});
        }
        delete positions[sym];
        await savePositions(positions);
        await record("close",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: null, leverage: pos.leverage },
          live && !pos.dryRun, true,
          pos.dryRun || !live ? "dry-run: position closed in tracker" : "position closed (market)", ids);
        return;
      }

      case "cancel": {
        // Silent background handling: cancel exchange orders / drop or close
        // the tracked position, purge the trade's earlier signal & order
        // records, and record nothing new.
        if (live) {
          await client.cancelAllOrders(client.perpSymbol(sym));
          if (client.cancelStopOrders) {
            await client.cancelStopOrders(client.perpSymbol(sym)).catch(() => {});
          }
        }
        if (pos) {
          // Anything actually filled must be exited - including a limit entry
          // that already got filled (qty > 0); only an unfilled pending order
          // can just be dropped after cancelling it above.
          if (pos.qty > 0) {
            await closeQty(client, live, pos, pos.qty);
          }
          delete positions[sym];
        }
        await savePositions(positions);
        await purgeSymbolRecords(sym);
        return;
      }

      case "update_sl": {
        if (!pos) {
          return; // SL update for a symbol we don't hold - ignore silently
        }
        const rawSl = signal.stopLossBreakeven ? pos.entryPrice : signal.stopLoss;
        if (rawSl == null) {
          await record("update_sl", { symbol: sym, side: pos.side, sizeUsdt: 0, qty: 0, price: null, leverage: pos.leverage }, live, false, "no stop-loss value found in message");
          return;
        }
        // stop-loss rounds UP to Pionex precision (無條件進位)
        const newSl = (await alignPrices(client, sym, { stopLoss: rawSl })).stopLoss!;
        const old = pos.stopLoss;
        pos.stopLoss = newSl;
        await savePositions(positions);
        const slStopNote = await syncExchangeStops(client, settings, live, pos);
        await record("update_sl",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: newSl, leverage: pos.leverage },
          live, true,
          `stop-loss moved ${old ?? "none"} -> ${newSl}${signal.stopLossBreakeven ? " (breakeven)" : ""}` +
            (slStopNote ? `；${slStopNote}` : ""));
        return;
      }

      case "update_tp": {
        if (!pos) {
          return; // TP update for a symbol we don't hold - ignore silently
        }
        if (!signal.takeProfits.length) {
          await record("update_tp", { symbol: sym, side: pos.side, sizeUsdt: 0, qty: 0, price: null, leverage: pos.leverage }, live, false, "no take-profit values found in message");
          return;
        }
        // take-profits round DOWN to Pionex precision (無條件縮減)
        const alignedTps = (await alignPrices(client, sym, { takeProfits: signal.takeProfits })).takeProfits;
        pos.takeProfits = [...alignedTps].sort((a, b) =>
          pos.side === "long" ? a - b : b - a);
        pos.tpCountOriginal = Math.max(pos.tpCountOriginal, pos.takeProfits.length);
        await savePositions(positions);
        const tpStopNote = await syncExchangeStops(client, settings, live, pos);
        await record("update_tp",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: pos.takeProfits[0], leverage: pos.leverage },
          live, true,
          `take-profits set to ${pos.takeProfits.join("/")}` + (tpStopNote ? `；${tpStopNote}` : ""));
        return;
      }
    }
  } catch (err) {
    if (err instanceof BelowMinSizeError) {
      // a deliberate no-trade, not a failure - keep it out of the action log
      // for the same reason risk rejections are dropped there
      return;
    }
    // PionexApiError.message already carries the "Pionex API error ..." prefix
    let msg = err instanceof PionexApiError
      ? err.message
      : `execution failed: ${(err as Error).message}`;
    // add a plain-language hint for the common min-order-size rejection
    if (/AMOUNT_FILTER|MIN_?AMOUNT|MIN_?NOTIONAL|too small/i.test(msg)) {
      msg += "（下單金額低於 Pionex 最低下單額，請到設定調高「固定金額」）";
    }
    if (isPermissionDenied(msg)) {
      msg += okxCodeHint(msg) ?? permHint(settings);
    }
    await record(signal.action,
      { symbol: sym, side: signal.side, sizeUsdt: 0, qty: 0, price: null, leverage: 0 },
      live, false, msg);
  }
}

// -------------------------------------------------------------- monitoring
/** One monitor tick: trailing-stop ratchet + soft SL/TP enforcement.
 *  Returns a human-readable list of the actions it took. */
export async function monitorTick(settings: Settings): Promise<string[]> {
  const live = isLive(settings);
  const client = makeClient(settings);
  const positions = await getPositions();
  const actions: string[] = [];
  let changed = false;

  const pendingTimeoutMs = 6 * 60 * 60 * 1000; // drop unfilled 到價進場 after 6h
  // A fresh entry may not be visible on the exchange for a moment, so a
  // position is only treated as closed once it has had time to register.
  const closeGraceMs = 2 * 60 * 1000;

  // Fetched at most once per tick and shared: the exchange is the authority on
  // what is actually held, and asking per symbol would multiply API calls.
  let realCache:
    | { symbol: string; side: "long" | "short"; qty: number; entryPrice: number }[]
    | null
    | undefined;
  const realPositions = async () => {
    if (realCache === undefined) {
      realCache = client.fetchPositions
        ? await client.fetchPositions().catch(() => null)
        : null;
    }
    return realCache;
  };

  // Same idea for orders: one account-wide snapshot of resting orders and of
  // protective orders, reused for every symbol. Per-symbol queries multiply with
  // the number of positions, and being rate-limited is what previously made the
  // monitor mistake "query failed" for "no protection". null means the snapshot
  // is unavailable this tick, and callers must then do nothing rather than guess.
  let openCache: { symbol: string; orderId: string }[] | null | undefined;
  const allOpenOrders = async () => {
    if (openCache === undefined) {
      openCache = client.fetchAllOpenOrders
        ? await client.fetchAllOpenOrders().catch(() => null)
        : null;
    }
    return openCache;
  };
  /** Is this order still resting? Uses the account-wide snapshot when the venue
   *  offers one, else falls back to a per-symbol query. null = cannot tell. */
  const isResting = async (venue: string, orderId: string): Promise<boolean | null> => {
    if (client.fetchAllOpenOrders) {
      const open = await allOpenOrders();
      if (open == null) return null;
      return open.some((o) => o.orderId === orderId && o.symbol === venue);
    }
    const open = await client.getOpenOrders(venue).catch(() => null);
    if (open == null) return null;
    return open.some((o: any) => String(o.orderId ?? o.id ?? "") === orderId);
  };

  let stopCache: { symbol: string; algoId: string }[] | null | undefined;
  const allStopOrders = async () => {
    if (stopCache === undefined) {
      stopCache = client.fetchAllStopOrders
        ? await client.fetchAllStopOrders().catch(() => null)
        : null;
    }
    return stopCache;
  };

  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    const price = await fetchPriceSafe(client, sym, null);
    if (price == null) {
      actions.push(`${sym}: price unavailable, skipped`);
      continue;
    }

    // The exchange may have filled the entry while this app was not running -
    // the monitor otherwise only learns of a fill by watching the order leave
    // the book, which it cannot do during any gap. The exchange's own position
    // is the source of truth, so adopt it and let this tick protect it.
    if (pos.pendingEntry && live && !pos.dryRun && client.fetchPositions) {
      const venue = client.perpSymbol(sym);
      const real = ((await realPositions()) ?? []).find(
        (p) => p.symbol === venue && p.qty > 0
      );
      if (real) {
        const target = pos.pendingEntry.target;
        pos.entryPrice = real.entryPrice || target;
        pos.qty = real.qty;
        pos.originalQty = real.qty;
        pos.initialRisk =
          pos.stopLoss != null ? Math.abs(pos.entryPrice - pos.stopLoss) : null;
        pos.pendingEntry = null;
        changed = true;
        actions.push(`${sym}: 交易所已有持倉，同步為已成交（${real.qty} @ ${pos.entryPrice}）`);
        await record("open",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: real.qty, price: pos.entryPrice, leverage: pos.leverage },
          true, true, `與交易所同步：持倉 ${real.qty} @ ${pos.entryPrice}`);
      }
    }

    // Not filled yet: either a real limit order rests on Pionex, or we watch
    // the price ourselves and market-enter on touch (到價進場).
    if (pos.pendingEntry) {
      const { target, dir } = pos.pendingEntry;
      const mode = pos.pendingEntry.mode ?? "watch"; // legacy positions: watch
      if (Date.now() - pos.openedAt > pendingTimeoutMs) {
        if (live && !pos.dryRun && mode === "limit_order") {
          await client.cancelAllOrders(client.perpSymbol(sym)).catch(() => {});
        }
        delete positions[sym];
        changed = true;
        actions.push(`${sym}: 待進場逾時未到價，取消`);
        continue;
      }

      // A real resting order fills on the exchange; detect it by the order
      // leaving the open-orders book.
      if (mode === "limit_order") {
        const oid = pos.pendingEntry.orderId;
        const stillResting = await isResting(client.perpSymbol(sym), String(oid));
        if (stillResting == null) continue; // can't tell right now - retry later
        if (stillResting) continue; // still waiting at the entry price

        // Gone from the book means filled OR cancelled. Ask which: booking a
        // cancelled order as a fill would invent a position that never existed.
        let filledQty = pos.pendingEntry.qty;
        let filledAt = target;
        if (client.getOrderState && oid) {
          const st = await client
            .getOrderState(client.perpSymbol(sym), String(oid))
            .catch(() => null);
          if (st && st.state !== "filled" && st.filledQty <= 0) {
            delete positions[sym];
            changed = true;
            actions.push(`${sym}: 進場掛單已取消／失效（狀態 ${st.state}）→ 移除追蹤`);
            await record("cancel",
              { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: 0, price: target, leverage: pos.leverage },
              true, true,
              `進場掛單未成交就消失（交易所狀態 ${st.state}）→ 移除追蹤，未持倉`);
            continue;
          }
          if (st && st.filledQty > 0) {
            filledQty = st.filledQty;
            filledAt = st.avgPrice ?? target;
          }
        }
        pos.entryPrice = filledAt;
        pos.qty = filledQty;
        pos.originalQty = filledQty;
        pos.initialRisk = pos.stopLoss != null ? Math.abs(filledAt - pos.stopLoss) : null;
        pos.pendingEntry = null;
        changed = true;
        actions.push(`${sym}: 限價單已成交 @ ${filledAt}`);
        const filledStopNote = await syncExchangeStops(client, settings, live, pos);
        if (filledStopNote) actions.push(`${sym}: ${filledStopNote}`);
        await record("open",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: target, leverage: pos.leverage },
          live && !pos.dryRun, true, `限價單成交 @ ${target}`, oid ? [String(oid)] : []);
        continue;
      }

      // watch mode: the last price is only a once-a-minute sample, so also
      // check the candle high/low since the order was placed - otherwise a
      // wick that touches the entry between polls is missed entirely.
      let reached = dir === "down" ? price <= target : price >= target;
      if (!reached && live && !pos.dryRun) {
        const range = await client
          .priceRange(client.perpSymbol(sym), pos.openedAt)
          .catch(() => null);
        if (range) {
          reached = dir === "down" ? range.low <= target : range.high >= target;
          if (reached) {
            actions.push(`${sym}: 期間曾觸及 ${target}（區間 ${range.low}~${range.high}）`);
          }
        }
      }
      if (!reached) continue; // keep waiting
      try {
        const res = await placeEntry(
          client, live && !pos.dryRun, sym, pos.side, pos.sizeUsdt, "market", null, price, pos.leverage
        );
        pos.entryPrice = res.price;
        pos.qty = res.qty;
        pos.originalQty = res.qty;
        pos.initialRisk = pos.stopLoss != null ? Math.abs(res.price - pos.stopLoss) : null;
        pos.pendingEntry = null;
        changed = true;
        actions.push(`${sym}: 到價進場 @ ${target}（現價 ${price}）`);
        const entryStopNote = await syncExchangeStops(client, settings, live, pos);
        if (entryStopNote) actions.push(`${sym}: ${entryStopNote}`);
        await record("open",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: res.qty, price: res.price, leverage: pos.leverage },
          live && !pos.dryRun, true, `到價進場 @ ${target}（現價 ${price}）`, res.orderIds);
      } catch (err) {
        const emsg = (err as Error).message;
        actions.push(`${sym}: 到價進場失敗: ${emsg}`);
        if (isPermissionDenied(emsg)) {
          // the account cannot trade perps via API - retrying every tick would
          // just spam the log, so drop the position and say why once.
          delete positions[sym];
          changed = true;
          await record("open",
            { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: 0, price: target, leverage: pos.leverage },
            live && !pos.dryRun, false, `到價但 ${venueName(settings)} 拒絕下單：${emsg}${okxCodeHint(emsg) ?? permHint(settings)}`);
        }
      }
      continue; // just entered (or failed) - don't run SL/TP this tick
    }
    const dir = pos.side === "long" ? 1 : -1;
    // set when a partial close shrinks the position, so the exchange stop can
    // be re-placed for the remaining size before this tick ends
    let sizeShrunk = false;

    // The mirror of the fill reconciliation above: a stop firing on the
    // exchange, a manual close or a liquidation all END the position without
    // this app doing anything. Unnoticed, the tracker keeps a zombie position -
    // the self-heal below re-places protective orders for it every single tick,
    // and the orphan sweep skips them because the tracker still "holds" it.
    if (
      live && !pos.dryRun && !pos.pendingEntry && pos.qty > 0 &&
      Date.now() - pos.openedAt > closeGraceMs
    ) {
      const real = await realPositions();
      if (real) {
        const stillOpen = real.some(
          (p) => p.symbol === client.perpSymbol(sym) && p.qty > 0
        );
        if (!stillOpen) {
          const venue = client.perpSymbol(sym);
          if (client.cancelStopOrders) {
            await client.cancelStopOrders(venue).catch(() => {});
          }
          await client.cancelAllOrders(venue).catch(() => {});
          delete positions[sym];
          changed = true;
          actions.push(`${sym}: 交易所已無持倉（止損或平倉已執行）→ 同步移除追蹤`);
          await record("close",
            { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: price, leverage: pos.leverage },
            true, true,
            "交易所已無此持倉（止損或平倉已在交易所執行）→ 同步移除追蹤，" +
              "並撤銷殘留的保護單與加倉掛單");
          continue;
        }
      }
    }

    // Self-heal: protective orders are otherwise only placed when something
    // happens (fill, SL change, partial close), so a position that was opened
    // before this feature existed - or whose orders failed, were cancelled by
    // hand, or expired - would sit unprotected forever. Check every tick and
    // place them if the exchange has none.
    if (
      settings.trading.orders.exchangeStops &&
      live && !pos.dryRun && pos.qty > 0 &&
      client.placeStopOrders
    ) {
      const venue = client.perpSymbol(sym);
      // null/-1 = unknown this tick; only a KNOWN-empty result may place orders
      let existing = -1;
      if (client.fetchAllStopOrders) {
        const stops = await allStopOrders();
        if (stops != null) existing = stops.filter((o) => o.symbol === venue).length;
      } else if (client.countStopOrders) {
        existing = await client.countStopOrders(venue).catch(() => -1);
      }
      if (existing === 0) {
        const note = await syncExchangeStops(client, settings, live, pos);
        if (note) {
          actions.push(`${sym}: ${note}`);
          await record("stops_synced",
            { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: pos.stopLoss, leverage: pos.leverage },
            true, !note.startsWith("⚠️"), `補掛保護單：${note}`);
        }
      }
    }

    // trailing stop: once profit exceeds the activation threshold, keep the
    // SL at callbackPercent behind the best price seen (ratchet only).
    const trailing = settings.trading.trailing;
    if (trailing.enabled) {
      const profitPct = ((price - pos.entryPrice) / pos.entryPrice) * 100 * dir;
      if (profitPct >= trailing.activateProfitPercent) {
        const candidate =
          pos.side === "long"
            ? price * (1 - trailing.callbackPercent / 100)
            : price * (1 + trailing.callbackPercent / 100);
        const better =
          pos.stopLoss == null ||
          (pos.side === "long" ? candidate > pos.stopLoss : candidate < pos.stopLoss);
        if (better) {
          const old = pos.stopLoss;
          pos.stopLoss = candidate;
          changed = true;
          actions.push(`${sym}: trailing SL ${old?.toFixed(6) ?? "none"} -> ${candidate.toFixed(6)}`);
          await syncExchangeStops(client, settings, live, pos);
          await record("trailing_move",
            { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: candidate, leverage: pos.leverage },
            live && !pos.dryRun, true, `trailing stop moved to ${candidate.toFixed(6)} (price ${price})`);
        }
      }
    }

    // 加倉計劃 with pullback entries: once price stays beyond a level for
    // addArmSeconds, the level is "armed" (a virtual limit order at the
    // level); the add then fills when price pulls back (回踩) to the level.
    // Tolerates legacy stored positions where levels were plain numbers.
    const armSeconds = settings.trading.addArmSeconds ?? 60;
    const now = Date.now();
    const pending = (pos.pendingAdds ?? []).map((a: any) =>
      typeof a === "number" ? { level: a, armedAt: null, armed: false } : a
    );
    const remaining: typeof pending = [];
    for (const add of pending) {
      // A 加倉確認 tranche rests as a real order on the exchange; it is filled
      // when it leaves the book, exactly like the entry order.
      if (add.orderId && live && !pos.dryRun) {
        const resting = await isResting(client.perpSymbol(sym), String(add.orderId));
        if (resting == null) {
          remaining.push(add);   // can't tell right now, check again later
          continue;
        }
        if (resting) {
          remaining.push(add);
          continue;
        }
        let addQty = add.qty ?? 0;
        let addAt = add.level;
        if (client.getOrderState) {
          const st = await client
            .getOrderState(client.perpSymbol(sym), String(add.orderId))
            .catch(() => null);
          if (st && st.state !== "filled" && st.filledQty <= 0) {
            actions.push(`${sym}: 加倉掛單已取消／失效（狀態 ${st.state}）→ 不計入持倉`);
            await record("add_cancel",
              { symbol: sym, side: pos.side, sizeUsdt: 0, qty: 0, price: add.level, leverage: pos.leverage },
              true, true,
              `加倉掛單未成交就消失（交易所狀態 ${st.state}）→ 未加倉，持倉不變`);
            continue;   // drop the tranche without touching the position
          }
          if (st && st.filledQty > 0) {
            addQty = st.filledQty;
            addAt = st.avgPrice ?? add.level;
          }
        }
        if (addQty > 0) {
          const newQty = pos.qty + addQty;
          pos.entryPrice = (pos.entryPrice * pos.qty + addAt * addQty) / newQty;
          pos.qty = newQty;
          pos.originalQty += addQty;
          pos.sizeUsdt += add.sizeUsdt ?? 0;
          pos.addCount += 1;
          changed = true;
          // the deferred stop becomes live exactly now, for the whole position
          const moved = add.stopLossAfterFill != null && add.stopLossAfterFill !== pos.stopLoss;
          if (add.stopLossAfterFill != null) pos.stopLoss = add.stopLossAfterFill;
          actions.push(
            `${sym}: 加倉限價單成交 @ ${add.level}` +
              (moved ? `，止損改至 ${pos.stopLoss}` : "")
          );
          // The tranche's own attached stop covers the WAIT between placing the
          // order and it filling. Once filled the provider sends 止損上移 for
          // the whole position, and that update replaces every resting order -
          // so protection is re-placed here for the full size. Keeping only the
          // tranche's stop would leave the rest uncovered the moment the update
          // arrived.
          const note = await syncExchangeStops(client, settings, live, pos);
          await record("add",
            { symbol: sym, side: pos.side, sizeUsdt: add.sizeUsdt ?? 0, qty: addQty, price: add.level, leverage: pos.leverage },
            true, true,
            `加倉限價單成交 @ ${add.level}（第 ${pos.addCount} 次）` +
              (moved ? `；整倉止損改至 ${pos.stopLoss}` : "") +
              (note ? `；${note}` : ""),
            [String(add.orderId)]);
        }
        continue;   // done with this tranche either way
      }

      // Self-judged timing is off by default: the provider confirms the
      // breakout and sends 加倉確認｜請掛單, so arming the same level here as
      // well would add to the position twice. The level is kept for reference.
      if (!settings.trading.autoArmAddLevels) {
        remaining.push(add);
        continue;
      }

      const beyond =
        add.level < pos.entryPrice ? price <= add.level : price >= add.level;
      const pulledBack =
        add.level < pos.entryPrice ? price >= add.level : price <= add.level;

      if (!add.armed) {
        if (beyond) {
          if (add.armedAt == null) {
            add.armedAt = now;
            changed = true;
          }
          if (now - add.armedAt >= armSeconds * 1000) {
            add.armed = true;
            changed = true;
            actions.push(`${sym}: add level ${add.level} armed (beyond ${armSeconds}s), waiting for pullback`);
          }
        } else if (add.armedAt != null) {
          add.armedAt = null; // bounced back before the arm window elapsed
          changed = true;
        }
        remaining.push(add);
        continue;
      }

      // armed: fill when price pulls back to the level
      if (!pulledBack) {
        remaining.push(add);
        continue;
      }
      if (pos.addCount >= settings.trading.risk.maxAddsPerPosition) {
        actions.push(`${sym}: add level ${add.level} pullback but max adds used, dropped`);
        changed = true;
        continue; // drop the level
      }
      const addUsdt =
        settings.trading.addPositionUsdt > 0
          ? settings.trading.addPositionUsdt
          : settings.trading.sizing.fixedUsdt;
      try {
        const res = await placeEntry(
          client, live && !pos.dryRun, sym, pos.side, addUsdt,
          "market", null, add.level, pos.leverage
        );
        const newQty = pos.qty + res.qty;
        pos.entryPrice = (pos.entryPrice * pos.qty + res.price * res.qty) / newQty;
        pos.qty = newQty;
        pos.originalQty += res.qty;
        pos.sizeUsdt += addUsdt;
        pos.addCount += 1;
        changed = true;
        actions.push(`${sym}: 回踩加倉 at ${add.level} executed (${addUsdt} USDT)`);
        await record("add",
          { symbol: sym, side: pos.side, sizeUsdt: addUsdt, qty: res.qty, price: res.price, leverage: pos.leverage },
          live && !pos.dryRun, true,
          `加倉計劃 回踩成交 @ ${add.level} (現價 ${price}); ${res.note}`, res.orderIds);
      } catch (err) {
        remaining.push(add); // retry next tick
        actions.push(`${sym}: planned add FAILED: ${(err as Error).message}`);
      }
    }
    pos.pendingAdds = remaining;

    // R-multiple scale-out: at r×R profit, close closePercent% of original qty
    if (pos.initialRisk && pos.initialRisk > 0 && (pos.rTargets ?? []).length) {
      const rProfit = ((price - pos.entryPrice) * dir) / pos.initialRisk;
      for (const t of pos.rTargets) {
        if (t.done || rProfit < t.r || pos.qty <= 1e-9) continue;
        const qtyToClose = Math.min(pos.qty, (pos.originalQty * t.closePercent) / 100);
        if (qtyToClose <= 1e-9) { t.done = true; continue; }
        try {
          const ids = await closeQty(client, live, pos, qtyToClose);
          pos.qty -= qtyToClose;
          t.done = true;
          changed = true;
          sizeShrunk = true;
          actions.push(`${sym}: ${t.r}R 達標，平 ${t.closePercent}% (${qtyToClose.toFixed(6)})`);
          await record("tp_hit",
            { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: qtyToClose, price, leverage: pos.leverage },
            live && !pos.dryRun, true,
            `R 止盈：達 ${t.r}R (現價 ${price})，平倉 ${t.closePercent}%`, ids);
        } catch (err) {
          actions.push(`${sym}: R止盈平倉 FAILED: ${(err as Error).message}`);
          break;
        }
      }
      if (pos.qty <= 1e-9) {
        delete positions[sym];
        actions.push(`${sym}: R 止盈已全數平倉`);
        continue;
      }
    }

    // stop-loss: close everything
    if (pos.stopLoss != null && (price - pos.stopLoss) * dir <= 0) {
      try {
        const ids = await closeQty(client, live, pos, pos.qty);
        if (live && !pos.dryRun && client.cancelStopOrders) {
          await client.cancelStopOrders(client.perpSymbol(sym)).catch(() => {});
        }
        delete positions[sym];
        changed = true;
        actions.push(`${sym}: SL hit at ${price}, position closed`);
        await record("sl_hit",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price, leverage: pos.leverage },
          live && !pos.dryRun, true, `stop-loss ${pos.stopLoss} hit at ${price}, closed`, ids);
      } catch (err) {
        actions.push(`${sym}: SL close FAILED: ${(err as Error).message}`);
        await record("sl_hit",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price, leverage: pos.leverage },
          live && !pos.dryRun, false, `stop-loss close failed: ${(err as Error).message}`);
      }
      continue;
    }

    // take-profit. 分批止盈 (default): each hit target closes an equal fraction
    // of the original qty (last target closes the remainder). When splitting
    // is off, the first hit target closes the whole position.
    const splitTp = settings.trading.orders.splitTakeProfit !== false;
    while (pos.takeProfits.length && (price - pos.takeProfits[0]) * dir >= 0) {
      const target = pos.takeProfits.shift()!;
      const fraction = pos.tpCountOriginal > 0 ? 1 / pos.tpCountOriginal : 1;
      const qtyToClose = !splitTp || pos.takeProfits.length === 0
        ? pos.qty // close everything (no-split, or the last target)
        : Math.min(pos.qty, pos.originalQty * fraction);
      try {
        const ids = await closeQty(client, live, pos, qtyToClose);
        pos.qty -= qtyToClose;
        changed = true;
        sizeShrunk = true;
        actions.push(`${sym}: TP ${target} hit at ${price}, closed ${qtyToClose.toFixed(6)}`);
        await record("tp_hit",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: qtyToClose, price, leverage: pos.leverage },
          live && !pos.dryRun, true, `take-profit ${target} hit at ${price}`, ids);

        // 觸及止盈一 -> 止損移到進場價附近 (多單移到下方一點點, 空單鏡像)
        const t = settings.trading.trailing;
        if (t.moveToBreakevenOnTp1 && !pos.beMoved && pos.qty > 1e-9) {
          const offset = t.breakevenOffsetPercent / 100;
          const newSl =
            pos.side === "long"
              ? pos.entryPrice * (1 - offset)
              : pos.entryPrice * (1 + offset);
          const better =
            pos.stopLoss == null ||
            (pos.side === "long" ? newSl > pos.stopLoss : newSl < pos.stopLoss);
          pos.beMoved = true;
          if (better) {
            const old = pos.stopLoss;
            pos.stopLoss = newSl;
            actions.push(`${sym}: TP1 hit -> SL moved to breakeven zone ${newSl.toFixed(6)}`);
            await syncExchangeStops(client, settings, live, pos);
            await record("trailing_move",
              { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: newSl, leverage: pos.leverage },
              live && !pos.dryRun, true,
              `TP1 hit: SL ${old ?? "none"} -> ${newSl.toFixed(6)} (entry ${pos.entryPrice})`);
          }
        }
      } catch (err) {
        pos.takeProfits.unshift(target); // retry next tick
        actions.push(`${sym}: TP close FAILED: ${(err as Error).message}`);
        break;
      }
      if (pos.qty <= 1e-9) {
        delete positions[sym];
        actions.push(`${sym}: all targets filled, position fully closed`);
        break;
      }
    }

    if (sizeShrunk) {
      if (positions[sym]) {
        // remaining size changed -> re-place the exchange stop to match
        const note = await syncExchangeStops(client, settings, live, pos);
        if (note) actions.push(`${sym}: ${note}`);
      } else if (live && !pos.dryRun && client.cancelStopOrders) {
        await client.cancelStopOrders(client.perpSymbol(sym)).catch(() => {});
      }
    }
  }

  // Protective orders outlive the position they were placed for when a close
  // happens outside this app (manual close, liquidation, a stop firing). They
  // are reduce-only so they cannot open anything, but they accumulate and make
  // "is this position protected?" unanswerable. Remove the ones whose symbol is
  // no longer held anywhere.
  if (live && client.cancelStopOrderIds) {
    try {
      // both already fetched for this tick; re-fetching would double the cost
      const stops = await allStopOrders();
      const held = await realPositions();
      if (stops == null || held == null) throw new Error("snapshot unavailable");
      const heldSymbols = new Set(held.filter((h) => h.qty > 0).map((h) => h.symbol));
      const trackedSymbols = new Set(
        Object.values(positions)
          .filter((p) => !p.dryRun)
          .map((p) => client.perpSymbol(p.symbol))
      );
      const orphans = stops.filter(
        (o) => !heldSymbols.has(o.symbol) && !trackedSymbols.has(o.symbol)
      );
      if (orphans.length) {
        await client.cancelStopOrderIds(orphans);
        const syms = [...new Set(orphans.map((o) => o.symbol))].join(", ");
        actions.push(`清理無持倉的殘留止盈止損單 ${orphans.length} 筆（${syms}）`);
        await record("stops_synced",
          { symbol: syms.slice(0, 40), side: null, sizeUsdt: 0, qty: 0, price: null, leverage: 0 },
          true, true,
          `清理殘留保護單 ${orphans.length} 筆：${syms}（這些幣種已無持倉）`);
      }
    } catch {
      /* enumeration failed - try again next tick rather than guess */
    }
  }

  if (changed) await savePositions(positions);
  return actions;
}

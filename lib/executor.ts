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
  appendTrade,
  checkAndMarkSeen,
  getCooldowns,
  getPositions,
  purgeSymbolRecords,
  savePositions,
  setCooldown,
  setStopSnapshot,
  setUntrackedSnapshot,
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

/** True when nothing this app can do will make the order work: the account is
 *  rejected, has no money, or the coin has no contract at all.
 *
 *  This matters because a rejected LIMIT order otherwise downgrades the trade to
 *  到價自動進場 - the monitor watching the price and entering at market. That is
 *  a sensible fallback for a price/precision quarrel with the venue, but for
 *  these three the market order fails exactly the same way, so the fallback just
 *  parks a position that can never fill and hides the real reason for a while. */
function isUnrecoverable(msg: string): boolean {
  return isPermanentReject(msg) || /\b51008\b|[Ii]nsufficient .*margin/.test(msg);
}

/** The subset of the above that will never resolve on its own. Insufficient
 *  margin is deliberately NOT here: it frees up as soon as another position
 *  closes, so a watcher already waiting on a price is worth keeping. A coin the
 *  venue does not list never becomes tradable, and neither does a key without
 *  trading permission - those must be dropped, or every tick retries forever. */
function isPermanentReject(msg: string): boolean {
  return (
    isPermissionDenied(msg) ||
    /NO_CONTRACT|沒有這個永續合約|找不到合約/.test(msg)
  );
}

/** Plain-Chinese cause + fix for the OKX credential/config errors that are
 *  otherwise just an opaque number. */
function okxCodeHint(msg: string): string | null {
  if (/NO_CONTRACT|沒有這個永續合約|找不到合約/.test(msg))
    return (
      "（OKX 沒有上架這個幣種的 USDT 永續合約，或訊號的幣種代號被解析錯了。" +
      "請到「收到的訊息」看這則的原始內容核對代號；OKX 沒有的幣種本系統無法交易。）"
    );
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
  if (/\b51008\b|[Ii]nsufficient .*margin/.test(msg))
    return (
      "（交易帳戶的可用保證金不足，這筆沒有下單。常見原因：①USDT 還在「資金帳戶」沒劃轉到「交易帳戶」；" +
      "②同時開太多倉，保證金被既有持倉與掛單佔住 —— 未成交的限價單一樣會凍結保證金；" +
      "③單筆金額或槓桿設定過大。可到設定調低「固定金額」或「同時最多持倉數」。）"
    );
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
  if (wl.length && !wl.includes(sym)) return `${sym} 不在白名單內，未交易`;
  if (bl.includes(sym)) return `${sym} 在黑名單內，未交易`;

  const ageSec = (Date.now() - signal.timestamp) / 1000;
  if (ageSec > risk.maxSignalAgeSeconds)
    return (
      `訊號已經過期 ${Math.round(ageSec)} 秒（上限 ${risk.maxSignalAgeSeconds} 秒），未交易。` +
      `若訊號本來就有延遲，請到設定調高「訊號最大延遲秒數」`
    );

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
    return `${sym} 還在冷卻時間內（${risk.cooldownSeconds} 秒），未重複進場`;
  }

  if (signal.action === "open") {
    if (positions[sym]) return `${sym} 已經有持倉／掛單，未重複進場`;
    if (Object.keys(positions).length >= risk.maxOpenPositions)
      return (
        `已達同時最多持倉數 ${risk.maxOpenPositions}，這筆訊號未交易。` +
        `請先平掉或刪除一筆，或到設定調高上限`
      );
    if (
      risk.requireEntryAndSl &&
      (signal.entryPrice === null || signal.stopLoss === null)
    )
      return "訊號缺少進場價或止損，依設定「必須有進場價與止損」未交易";
  }
  if (signal.action === "add") {
    const pos = positions[sym];
    if (!pos) return `${sym} 沒有持倉可加倉`;
    if (pos.addCount >= risk.maxAddsPerPosition)
      return `${sym} 已達單筆最多加倉次數 ${risk.maxAddsPerPosition}`;
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
  // attached to the entry order so the FULL protective plan is live the instant
  // it fills, with no dependence on the monitor
  protect?: {
    stopLoss: number | null;
    takeProfits: { price: number; size: string }[];
  }
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
  let levWarn = "";
  if (leverage && client.setLeverage) {
    try {
      await client.setLeverage(perp, leverage);
    } catch (err) {
      // Non-fatal, but never silent: the order then goes out at whatever
      // leverage the instrument currently has, and with margin-based sizing that
      // changes how much margin it actually needs.
      levWarn =
        `；⚠️ 設定槓桿 ${leverage}x 失敗（${(err as Error).message}），` +
        `交易所會沿用該合約目前的槓桿，實際所需保證金可能與設定不符`;
    }
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
    protect && (protect.stopLoss != null || protect.takeProfits.length > 0)
      ? { stopLoss: protect.stopLoss, takeProfits: protect.takeProfits }
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
      (attached ? "；已附帶止盈止損" : "") +
      levWarn,
    attached,
  };
}

/**
 * The target to attach to an ENTRY order: the FURTHEST one still beyond `entry`.
 *
 * An attachment covers the whole order, so attaching 止盈一 would close the
 * entire position at the first target and defeat 分批止盈 - the split targets are
 * laid out as separate orders once the position exists. Taking the furthest
 * instead means the attachment can only ever close everything at the final
 * target, which is the conservative outcome for the window before those orders
 * are in place.
 *
 * Targets already behind `entry` are excluded: an add enters further along than
 * the main position, so 止盈一 can sit below it, and attaching that would book a
 * loss the moment it fills. If nothing is beyond, no target is attached at all -
 * the stop still is.
 */
function attachTarget(
  side: "long" | "short",
  entry: number,
  takeProfits: number[]
): number | null {
  const beyond = takeProfits.filter((t) =>
    side === "long" ? t > entry : t < entry
  );
  return beyond.length ? beyond[beyond.length - 1] : null;
}

/**
 * The complete protective plan for a position that is about to be opened, so it
 * can ride along ON the entry order.
 *
 * Every level is computable up front: R prices come from entry and stop, and the
 * final target comes from the signal. Placing them with the order means the plan
 * is live the instant it fills, instead of waiting for the next monitor tick -
 * which is the difference between a partial take-profit happening and not
 * happening if this app stops running.
 *
 * The monitor still re-derives slices later from the position's ACTUAL remaining
 * size; this is the opening snapshot.
 */
function entryProtection(
  settings: Settings,
  side: "long" | "short",
  entry: number,
  stopLoss: number | null,
  qty: number,
  takeProfits: number[],
  /** The share each target closes, when the PROVIDER stated it. Its own split
   *  wins over the configured R levels: the rest of its messages assume it. */
  percents: (number | null)[] = []
): { price: number; size: number }[] {
  if (percents.some((p) => p != null) && takeProfits.length) {
    const out: { price: number; size: number }[] = [];
    let left = qty;
    takeProfits.forEach((price, i) => {
      if (left <= 0) return;
      const pct = percents[i];
      // the last target, and any target with no stated share, takes the rest
      const last = i === takeProfits.length - 1;
      const size = last || pct == null ? left : Math.min(left, (qty * pct) / 100);
      if (size > 0) {
        out.push({ price, size });
        left -= size;
      }
    });
    return out;
  }
  const dir = side === "long" ? 1 : -1;
  const rt = settings.trading.orders.rTakeProfit;
  const rApplies =
    !!rt?.enabled && (rt.applyWhen !== "single_target" || takeProfits.length <= 1);
  const risk = stopLoss != null ? Math.abs(entry - stopLoss) : 0;
  const out: { price: number; size: number }[] = [];
  let left = qty;

  // whatever is left exits at the furthest target the trade can still reach
  const finalTp = attachTarget(side, entry, takeProfits);

  if (rApplies && risk > 0) {
    for (const l of rt.levels) {
      const price = entry + dir * l.r * risk;
      // An R level at or beyond the final target is pointless: the target closes
      // everything there anyway. Dropping it is what "沒有那麼多 R 就在止盈二
      // 全平" means in practice.
      if (finalTp != null && (side === "long" ? price >= finalTp : price <= finalTp)) {
        break;
      }
      const size = Math.min(left, (qty * l.closePercent) / 100);
      if (size <= 0) break;
      out.push({ price, size });
      left -= size;
    }
  }
  if (finalTp != null && left > 0) out.push({ price: finalTp, size: left });
  else if (!out.length && finalTp != null) out.push({ price: finalTp, size: qty });
  return out;
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
  // A provider that states its own shares (「止盈一…減倉 60%」) overrides the
  // equal split, measured against the ORIGINAL size like the equal split is.
  const pcts = pos.tpPercents ?? [];
  const share =
    pos.tpCountOriginal > 0 ? pos.originalQty / pos.tpCountOriginal : pos.qty;
  const out: { price: number; size: number }[] = [];
  let left = pos.qty;
  tps.forEach((price, i) => {
    if (left <= 0) return;
    const pct = pcts[i];
    const slice = pct != null ? (pos.originalQty * pct) / 100 : share;
    const size = i === tps.length - 1 ? left : Math.min(left, slice);
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

/** Snaps a plan's prices to the venue's tick (targets round DOWN) and renders the
 *  sizes as strings for the order payload. */
async function alignPlan(
  client: ExchangeClient,
  symbol: string,
  plan: { price: number; size: number }[]
): Promise<{ price: number; size: string }[]> {
  if (!plan.length) return [];
  const dec = await client.pricePrecision(symbol);
  return plan.map((p) => ({
    price: dec == null ? p.price : floorToDecimals(p.price, dec),
    size: String(p.size),
  }));
}

/** Books a close against the position's running totals, so a trade that scaled
 *  out at several levels can be filed with its true total rather than only the
 *  last exit. */
function bookClose(pos: Position, qty: number, exitPrice: number): number {
  const dir = pos.side === "long" ? 1 : -1;
  const pnl = (exitPrice - pos.entryPrice) * qty * dir;
  pos.realizedPnl = (pos.realizedPnl ?? 0) + pnl;
  pos.closedQty = (pos.closedQty ?? 0) + qty;
  return pnl;
}

/** Files a finished trade for the win-rate/profit page. */
async function finishTrade(
  pos: Position,
  exitPrice: number,
  reason: string,
  // the venue's own realised PnL, net of fees and funding. Preferred over our
  // own arithmetic whenever available: it is what actually hit the account.
  exchangePnl?: number | null
): Promise<void> {
  const qty = pos.closedQty ?? 0;
  if (qty <= 0) return;   // nothing was ever closed - not a completed trade
  const margin = pos.leverage > 0 ? pos.sizeUsdt / pos.leverage : pos.sizeUsdt;
  const pnl = exchangePnl != null ? exchangePnl : pos.realizedPnl ?? 0;
  await appendTrade({
    symbol: pos.symbol,
    side: pos.side,
    leverage: pos.leverage,
    entryPrice: pos.entryPrice,
    exitPrice,
    qty,
    sizeUsdt: pos.sizeUsdt,
    pnlUsdt: +pnl.toFixed(6),
    pnlPercent: margin > 0 ? +((pnl / margin) * 100).toFixed(3) : 0,
    rMultiple:
      pos.initialRisk && pos.initialRisk > 0 && qty > 0
        ? +(pnl / (pos.initialRisk * qty)).toFixed(3)
        : null,
    addCount: pos.addCount,
    openedAt: pos.openedAt,
    closedAt: Date.now(),
    reason: exchangePnl != null ? `${reason}（交易所結算）` : reason,
    dryRun: pos.dryRun,
  });
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
    // Recorded, not silent. These are deliberate no-trades, but silence is what
    // makes "why did nothing happen?" unanswerable - the signal shows up in the
    // received-messages list and then simply never becomes an order, with no
    // trace of the rule that stopped it.
    await record(signal.action,
      { symbol: sym, side: signal.side, sizeUsdt: 0, qty: 0, price: signal.entryPrice, leverage: 0 },
      live, false, reject);
    return;
  }

  try {
    switch (signal.action) {
      case "open": {
        if (!signal.side) {
          return; // incomplete signal (no direction) - drop silently
        }
        // The configured maximum is a preference; the instrument has a hard
        // ceiling that is far lower on small caps than on BTC. With margin-based
        // sizing the notional is margin x leverage, so asking for leverage the
        // instrument does not allow makes the order need many times the intended
        // margin - which the exchange refuses as 51008, insufficient margin.
        let leverage = computeLeverage(settings, signal);
        let levNote = "";
        if (client.maxLeverage) {
          const venueMax = await client.maxLeverage(sym).catch(() => null);
          if (venueMax && leverage > venueMax) {
            levNote =
              `（${venueName(settings)} 對 ${sym} 最高 ${venueMax}x，` +
              `槓桿自 ${leverage}x 下調為 ${venueMax}x）`;
            leverage = venueMax;
          }
        }
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
          // targets are stored nearest-first, the same order the signal lists
          // 止盈一/止盈二 in, so the stated shares line up with them
          tpPercents: settings.trading.orders.attachTakeProfit
            ? signal.takeProfitPercents
            : [],
          tpCountOriginal: signal.takeProfits.length,
          pendingAdds: signal.addLevels
            .slice(0, maxAdds)
            .map((level) => ({ level, armedAt: null, armed: false })),
          entryOrderType: entryType,
          beMoved: false,
          realizedPnl: 0,
          closedQty: 0,
          openedAt: Date.now(),
          addCount: 0,
          dryRun: !live,
        };
        // R levels split both signal shapes identically. When they are in charge,
        // intermediate targets must not ALSO close a slice - that would have two
        // mechanisms closing the same position - so only the final target closes,
        // and it closes everything left.
        const targetsCount = common.takeProfits.length;
        const rApplies =
          !!rt?.enabled &&
          (rt.applyWhen !== "single_target" || targetsCount <= 1);
        const mkR = (risk: number | null) =>
          rApplies && risk
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

        // Some providers only consider a call valid once price has held the
        // level for a few minutes. Placing immediately would enter on the spike
        // their rule is designed to sit out, so the order is deferred and the
        // monitor places it when the wait is up. Timed from the SIGNAL's own
        // timestamp, so delivery lag counts towards the wait instead of adding
        // to it.
        const delaySec = settings.trading.orders.entryDelaySeconds ?? 0;
        const placeAt = signal.timestamp + delaySec * 1000;
        if (delaySec > 0 && Date.now() < placeAt && aligned.entry != null && refPrice != null) {
          const risk = slForRisk != null ? Math.abs(aligned.entry - slForRisk) : null;
          const waitSec = Math.round((placeAt - Date.now()) / 1000);
          positions[sym] = {
            ...common,
            entryPrice: aligned.entry, // planned
            qty: 0,
            originalQty: 0,
            initialRisk: risk,
            rTargets: mkR(risk),
            orderIds: [],
            pendingEntry: {
              target: aligned.entry,
              dir: refPrice >= aligned.entry ? "down" : "up",
              mode: "scheduled",
              orderId: null,
              qty: sizeUsdt / aligned.entry,
              placeAt,
            },
          };
          await savePositions(positions);
          await setCooldown(sym, Date.now());
          await record("open",
            { symbol: sym, side: signal.side, sizeUsdt, qty: 0, price: aligned.entry, leverage },
            live, true,
            `延後掛單：訊號時間 +${delaySec} 秒後才掛（約 ${waitSec} 秒後，` +
              `進場價 ${aligned.entry}，現價 ${refPrice}）` + levNote);
          return;
        }

        // entryType "limit" + a target the market hasn't reached yet: rest a
        // REAL limit order at the signal's entry price so it fills at exactly
        // that price. If the venue rejects it, the trade is skipped by default -
        // see orders.limitRejected.
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
                    ? {
                        stopLoss: slForRisk,
                        takeProfits: await alignPlan(
                          client, sym,
                          entryProtection(
                            settings, signal.side, aligned.entry!, slForRisk,
                            aligned.entry! > 0 ? sizeUsdt / aligned.entry! : 0,
                            common.takeProfits, signal.takeProfitPercents
                          )
                        ),
                      }
                    : undefined
                );
                mode = "limit_order";
                orderId = r.orderIds[0] ?? null;
                pendQty = r.qty;
                note =
                  `已在 ${venueName(settings)} 掛限價單 @ ${aligned.entry}（現價 ${refPrice}）` +
                  levNote;
              } catch (err) {
                const emsg = (err as Error).message;
                // Watching the price ourselves is a much weaker substitute for a
                // resting order - once-a-minute sampling, a market fill instead
                // of the signal's price, and nothing at all while the monitor is
                // down - so most of those trades never really enter. Skipping is
                // the default, and account-level rejections skip regardless
                // because the market fallback would fail identically.
                if (
                  (settings.trading.orders.limitRejected ?? "skip") === "skip" ||
                  isUnrecoverable(emsg)
                ) {
                  await record("open",
                    { symbol: sym, side: signal.side, sizeUsdt, qty: 0, price: aligned.entry, leverage },
                    live, false,
                    `${venueName(settings)} 掛限價單被拒 @ ${aligned.entry}（現價 ${refPrice}）：` +
                      `${emsg}${okxCodeHint(emsg) ?? (isUnrecoverable(emsg) ? permHint(settings) : "")}` +
                      `→ 略過這筆，不進場`);
                  return;
                }
                // opted in to the fallback: keep the trade alive by watching
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
        const plannedEntry = refPrice ?? aligned.entry ?? 0;
        const plannedQty = plannedEntry > 0 ? sizeUsdt / plannedEntry : 0;
        const tpPlan = await alignPlan(
          client, sym,
          entryProtection(
            settings, signal.side, plannedEntry, slForRisk, plannedQty,
            common.takeProfits, signal.takeProfitPercents
          )
        );
        const res = await placeEntry(
          client, live, sym, signal.side, sizeUsdt, "market", null, refPrice ?? aligned.entry, leverage,
          settings.trading.orders.belowMinSize ?? "lift",
          settings.trading.orders.exchangeStops
            ? { stopLoss: slForRisk, takeProfits: tpPlan }
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
          live, true, res.note + levNote + (stopNote ? `；${stopNote}` : ""), res.orderIds);
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
                  takeProfits: await alignPlan(
                    client, sym,
                    entryProtection(
                      settings, p.side, addLevel, p.stopLoss,
                      addLevel > 0 ? sizeUsdt / addLevel : 0,
                      p.takeProfits, p.tpPercents ?? []
                    )
                  ),
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
                ? `，已附帶止損 ${p.stopLoss ?? "-"}（與主倉相同）／止盈 ${attachTarget(p.side, addLevel, p.takeProfits) ?? "-"}`
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
            ? {
                stopLoss: p.stopLoss,
                takeProfits: await alignPlan(
                  client, sym,
                  entryProtection(
                    settings, p.side, refPrice ?? p.entryPrice, p.stopLoss,
                    (refPrice ?? p.entryPrice) > 0 ? sizeUsdt / (refPrice ?? p.entryPrice) : 0,
                    p.takeProfits, p.tpPercents ?? []
                  )
                ),
              }
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
        const exitPx = (await fetchPriceSafe(client, sym, pos.entryPrice)) ?? pos.entryPrice;
        const ids = await closeQty(client, live, pos, pos.qty);
        if (live && !pos.dryRun && client.cancelStopOrders) {
          await client.cancelStopOrders(client.perpSymbol(sym)).catch(() => {});
        }
        bookClose(pos, pos.qty, exitPx);
        await finishTrade(pos, exitPx, "close");
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
    if (isUnrecoverable(msg)) {
      msg += okxCodeHint(msg) ?? permHint(settings);
    }
    await record(signal.action,
      { symbol: sym, side: signal.side, sizeUsdt: 0, qty: 0, price: null, leverage: 0 },
      live, false, msg);
  }
}

/**
 * Places the entry for a position that was deferred by orders.entryDelaySeconds.
 *
 * Mutates `pos` in place and returns a note for the action log, or null when
 * nothing could be done this tick (so the caller leaves the position alone and
 * retries). On a terminal failure it clears `pendingEntry` and leaves qty at 0,
 * which tells the caller to drop the position.
 *
 * The wait exists precisely because the market moves during it, so the decision
 * of limit-vs-market is made HERE against the price now, not against the price
 * when the signal arrived.
 */
async function placeDeferredEntry(
  client: ExchangeClient,
  settings: Settings,
  live: boolean,
  pos: Position,
  price: number
): Promise<string | null> {
  const sym = pos.symbol;
  const target = pos.pendingEntry!.target;
  const dir = pos.pendingEntry!.dir;
  const reached = dir === "down" ? price <= target : price >= target;
  const entryType = pos.entryOrderType ?? settings.trading.orders.entryType;
  const isLiveOrder = live && !pos.dryRun;
  const protect = settings.trading.orders.exchangeStops
    ? {
        stopLoss: pos.stopLoss,
        takeProfits: await alignPlan(
          client, sym,
          entryProtection(
            settings, pos.side, target, pos.stopLoss,
            target > 0 ? pos.sizeUsdt / target : 0,
            pos.takeProfits, pos.tpPercents ?? []
          )
        ),
      }
    : undefined;

  // still short of the level: rest the limit order the delay was holding back
  if (entryType === "limit" && !reached) {
    try {
      const r = await placeEntry(
        client, isLiveOrder, sym, pos.side, pos.sizeUsdt, "limit", target, price,
        pos.leverage, settings.trading.orders.belowMinSize ?? "lift", protect
      );
      pos.pendingEntry = {
        target, dir, mode: isLiveOrder ? "limit_order" : "watch",
        orderId: r.orderIds[0] ?? null, qty: r.qty, placeAt: null,
      };
      pos.orderIds = r.orderIds;
      await record("open",
        { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: 0, price: target, leverage: pos.leverage },
        isLiveOrder, true, `延後時間到 → ${r.note}`, r.orderIds);
      return `延後時間到，已掛限價單 @ ${target}（現價 ${price}）`;
    } catch (err) {
      const emsg = (err as Error).message;
      if (
        (settings.trading.orders.limitRejected ?? "skip") === "skip" ||
        isUnrecoverable(emsg)
      ) {
        pos.pendingEntry = null; // caller drops the position
        await record("open",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: 0, price: target, leverage: pos.leverage },
          isLiveOrder, false,
          `延後時間到但掛限價單被拒：${emsg}${okxCodeHint(emsg) ?? ""} → 略過這筆，不進場`);
        return `延後時間到但掛單被拒（${emsg}）→ 略過`;
      }
      pos.pendingEntry = { target, dir, mode: "watch", orderId: null, qty: pos.pendingEntry!.qty, placeAt: null };
      return `延後時間到但掛單被拒（${emsg}）→ 改用到價自動進場`;
    }
  }

  // price already at or through the level: enter now at market
  try {
    const r = await placeEntry(
      client, isLiveOrder, sym, pos.side, pos.sizeUsdt, "market", null, price,
      pos.leverage, settings.trading.orders.belowMinSize ?? "lift", protect
    );
    pos.entryPrice = r.price;
    pos.qty = r.qty;
    pos.originalQty = r.qty;
    pos.initialRisk = pos.stopLoss != null ? Math.abs(r.price - pos.stopLoss) : null;
    pos.pendingEntry = null;
    pos.orderIds = r.orderIds;
    const needsExtra = !r.attached || tpSlices(settings, pos).length > 1;
    const stopNote = needsExtra
      ? await syncExchangeStops(client, settings, live, pos)
      : null;
    await record("open",
      { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: r.qty, price: r.price, leverage: pos.leverage },
      isLiveOrder, true,
      `延後時間到，已到價 → ${r.note}` + (stopNote ? `；${stopNote}` : ""), r.orderIds);
    return `延後時間到且已到價，市價進場 @ ${r.price}`;
  } catch (err) {
    const emsg = (err as Error).message;
    if (err instanceof BelowMinSizeError || isUnrecoverable(emsg)) {
      pos.pendingEntry = null; // caller drops the position
      await record("open",
        { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: 0, price: target, leverage: pos.leverage },
        isLiveOrder, false, `延後時間到但進場失敗：${emsg}${okxCodeHint(emsg) ?? ""} → 略過這筆`);
      return `延後時間到但進場失敗（${emsg}）→ 略過`;
    }
    return null; // transient - leave it scheduled and try again next tick
  }
}

/**
 * Takes an untracked exchange position back under management.
 *
 * Everything needed is already on the exchange: side, size and entry price from
 * the position itself, and the stop / targets from the protective orders resting
 * against it. Nothing is ordered or cancelled here - the position keeps exactly
 * the protection it has; this only gives the monitor a record to work from, so
 * it resumes trailing, scaling out and closing, and so the symbol stops being
 * blocked by its own untracked position.
 */
export async function adoptPosition(
  symbol: string,
  settings: Settings
): Promise<{ ok: boolean; error?: string; stopLoss: number | null; takeProfits: number[] }> {
  const empty = { stopLoss: null, takeProfits: [] as number[] };
  if (!isLive(settings)) {
    return { ok: false, error: "未啟用真實交易，無法接管交易所持倉", ...empty };
  }
  const client = makeClient(settings);
  if (!client.fetchPositions) {
    return { ok: false, error: `${venueName(settings)} 不支援查詢持倉`, ...empty };
  }
  const venue = client.perpSymbol(symbol);
  const real = (await client.fetchPositions()).find(
    (p) => p.symbol === venue && p.qty > 0
  );
  if (!real) {
    return { ok: false, error: `交易所目前沒有 ${symbol} 的持倉`, ...empty };
  }

  const positions = await getPositions();
  if (positions[symbol]) {
    return { ok: false, error: `${symbol} 已經在追蹤中`, ...empty };
  }

  // Read the levels the position is actually protected by, rather than inventing
  // new ones - re-deriving them from settings could place a stop the exchange
  // does not have and manage the trade against the wrong risk.
  let stopLoss: number | null = null;
  let takeProfits: number[] = [];
  if (client.fetchAllStopOrders) {
    const stops = (await client.fetchAllStopOrders().catch(() => []))
      .filter((o) => o.symbol === venue);
    stopLoss = stops.find((o) => o.kind === "sl")?.trigger ?? null;
    takeProfits = stops
      .filter((o) => o.kind === "tp" && o.trigger != null)
      .map((o) => o.trigger as number)
      .sort((a, b) => (real.side === "long" ? a - b : b - a));
  }

  const initialRisk = stopLoss != null ? Math.abs(real.entryPrice - stopLoss) : null;
  positions[symbol] = {
    symbol,
    side: real.side,
    entryPrice: real.entryPrice,
    qty: real.qty,
    originalQty: real.qty,
    sizeUsdt: real.qty * real.entryPrice,
    leverage: settings.trading.leverage.default,
    stopLoss,
    takeProfits,
    tpCountOriginal: takeProfits.length,
    tpHit: [],
    pendingAdds: [],
    entryOrderType: settings.trading.orders.entryType,
    beMoved: false,
    initialRisk,
    // The trade's history is unknown - which R levels already paid out cannot be
    // recovered - so no scale-out plan is invented for it.
    rTargets: [],
    realizedPnl: 0,
    closedQty: 0,
    openedAt: Date.now(),
    addCount: 0,
    dryRun: false,
    orderIds: [],
    pendingEntry: null,
  } as Position;
  await savePositions(positions);
  await appendOrder({
    at: Date.now(),
    action: "open",
    symbol,
    side: real.side,
    sizeUsdt: real.qty * real.entryPrice,
    qty: real.qty,
    price: real.entryPrice,
    leverage: settings.trading.leverage.default,
    dryRun: false,
    success: true,
    message:
      `接管交易所既有持倉（${real.qty} @ ${real.entryPrice}），` +
      `沿用交易所上的保護單：SL ${stopLoss ?? "無"} / TP ${takeProfits.join("/") || "無"}` +
      (stopLoss == null ? "；⚠️ 交易所上找不到止損，請自行確認" : ""),
    orderIds: [],
  });
  return { ok: true, stopLoss, takeProfits };
}

/**
 * Removes ONE tracked position, for the dashboard's per-row delete.
 *
 * Deliberately does not touch a real open position: the exchange is the source
 * of truth and its stop/take-profit orders stay in place, so an accidental
 * click cannot leave money unprotected. The monitor simply stops managing it.
 *
 * A resting ENTRY order is the exception. It exists only because of this record
 * and nothing else would ever reconcile it, so leaving it would let it fill
 * later into a position nothing is tracking. It is cancelled with the record.
 */
export async function dropPosition(
  symbol: string,
  settings: Settings
): Promise<{ found: boolean; cancelledEntry: boolean; warning: string | null }> {
  const positions = await getPositions();
  const pos = positions[symbol];
  if (!pos) return { found: false, cancelledEntry: false, warning: null };

  // Every resting order this record owns, not just the entry: a 加倉確認 rests a
  // REAL limit order too, and it is tracked only here. Leaving one behind would
  // let it fill later into a position nothing manages.
  const restingIds: string[] = [];
  if (pos.pendingEntry?.mode === "limit_order" && pos.pendingEntry.orderId) {
    restingIds.push(String(pos.pendingEntry.orderId));
  }
  for (const add of pos.pendingAdds ?? []) {
    if (add.orderId) restingIds.push(String(add.orderId));
  }

  let cancelledEntry = false;
  const failed: string[] = [];
  let warning: string | null = null;
  if (restingIds.length && isLive(settings) && !pos.dryRun) {
    const client = makeClient(settings);
    const venue = client.perpSymbol(symbol);
    for (const id of restingIds) {
      try {
        await client.cancelOrder(venue, id);
        cancelledEntry = true;
      } catch (err) {
        failed.push(`${id}（${(err as Error).message}）`);
      }
    }
    if (failed.length) {
      // still remove the record - the user asked for that - but say plainly
      // that an order they cannot see here may still be resting
      warning =
        `交易所上還有 ${failed.length} 筆掛單取消失敗：${failed.join("、")}。` +
        `請自行到 ${venueName(settings)} 撤單，否則它成交後不會有人管理。`;
    }
  }

  delete positions[symbol];
  await savePositions(positions);
  await appendOrder({
    at: Date.now(),
    action: "cancel",
    symbol,
    side: pos.side,
    sizeUsdt: pos.sizeUsdt,
    qty: pos.qty,
    price: null,
    leverage: pos.leverage,
    dryRun: pos.dryRun,
    success: true,
    message:
      `手動從網站刪除持倉紀錄` +
      (cancelledEntry
        ? `，並取消交易所的掛單 ${restingIds.length - failed.length} 筆`
        : "") +
      (pos.qty > 0 ? "（交易所上的真實持倉與止盈止損未更動）" : "") +
      (warning ? `；⚠️ ${warning}` : ""),
    orderIds: [],
  });
  return { found: true, cancelledEntry, warning };
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

  // Which symbols this app was managing when the tick STARTED. The exchange
  // snapshot is read once, before the loop mutates anything, so a position
  // closed during this tick would otherwise still be in that snapshot and get
  // reported as untracked - a false alarm that clears itself a minute later.
  const trackedAtStart = new Set(
    Object.values(positions)
      .filter((p) => !p.dryRun)
      .map((p) => client.perpSymbol(p.symbol))
  );

  // Give up on an unfilled entry after this long (orders.entryTimeoutHours);
  // 0 means never, so the comparison below must not treat it as "already due".
  const timeoutHours = settings.trading.orders.entryTimeoutHours ?? 6;
  const pendingTimeoutMs = timeoutHours > 0 ? timeoutHours * 3_600_000 : Infinity;
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

  let stopCache:
    | {
        symbol: string;
        algoId: string;
        kind: "tp" | "sl";
        trigger: number | null;
        size: string | null;
      }[]
    | null
    | undefined;
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
        const hours = timeoutHours;
        // "Not filled" has to be a fact, not an assumption. The fill check above
        // adopts the position when the exchange holds it, but it is skipped
        // whenever the positions snapshot could not be read this tick - and then
        // this branch would delete the record of an entry that DID fill, leaving
        // a live position nothing manages. Only expire what can be verified.
        if (live && !pos.dryRun && client.fetchPositions) {
          if ((await realPositions()) == null) {
            actions.push(`${sym}: 逾時但無法確認交易所是否已成交，保留追蹤，下次再試`);
            continue;
          }
        }
        // The resting order must be gone from the exchange BEFORE the record
        // is: dropping the record while the order still rests would leave it to
        // fill hours later into a position nothing manages. A failed cancel
        // therefore keeps the position for another tick instead of orphaning it.
        if (live && !pos.dryRun && mode === "limit_order") {
          try {
            await client.cancelAllOrders(client.perpSymbol(sym));
          } catch (err) {
            actions.push(
              `${sym}: 逾時撤單失敗（${(err as Error).message}），保留追蹤，下次再試`
            );
            continue;
          }
        }
        delete positions[sym];
        changed = true;
        actions.push(`${sym}: 待進場逾時未到價，取消`);
        await record("cancel",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: 0, price: target, leverage: pos.leverage },
          live && !pos.dryRun, true,
          `掛單 ${hours} 小時未成交 → 已撤單並移除追蹤（進場價 ${target}）`);
        continue;
      }

      // Deferred by orders.entryDelaySeconds: nothing is on the exchange yet.
      if (mode === "scheduled") {
        const at = pos.pendingEntry.placeAt ?? 0;
        if (Date.now() < at) continue; // wait is not up
        const note = await placeDeferredEntry(client, settings, live, pos, price);
        if (note === null) continue; // could not act this tick - try again
        changed = true;
        if (!pos.qty && !pos.pendingEntry) delete positions[sym];
        actions.push(`${sym}: ${note}`);
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
        if (isPermanentReject(emsg)) {
          // the account cannot trade this, ever - retrying every tick would
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
          // The exchange executed the close, so read ITS result rather than
          // estimating from the trigger price - that would miss slippage, gaps
          // and fees. Falls back to the stop as an estimate if unavailable.
          const closed = client.fetchClosedPositions
            ? (await client.fetchClosedPositions().catch(() => []))
                .filter(
                  (c) =>
                    c.symbol === client.perpSymbol(sym) &&
                    c.closedAt >= pos.openedAt - 60_000
                )
                .sort((a, b) => b.closedAt - a.closedAt)[0]
            : undefined;
          const exit = closed?.closePrice || pos.stopLoss || price;
          bookClose(pos, pos.qty, exit);
          await finishTrade(pos, exit, "exchange", closed?.realizedPnl ?? null);
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
          bookClose(pos, qtyToClose, price);
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
        await finishTrade(pos, price, "r_tp");
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
        bookClose(pos, pos.qty, price);
        await finishTrade(pos, price, "sl_hit");
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
    // When R levels are doing the splitting, an intermediate target closes
    // nothing (it still moves the stop to breakeven below); the final target
    // closes the remainder, so a trade that never reaches the higher R levels
    // ends fully closed at 止盈二.
    const rSplitting = (pos.rTargets ?? []).length > 0;
    while (pos.takeProfits.length && (price - pos.takeProfits[0]) * dir >= 0) {
      const target = pos.takeProfits.shift()!;
      const isFinalTarget = pos.takeProfits.length === 0;
      const fraction = pos.tpCountOriginal > 0 ? 1 / pos.tpCountOriginal : 1;
      const qtyToClose = isFinalTarget || !splitTp || rSplitting
        ? (rSplitting && !isFinalTarget ? 0 : pos.qty)
        : Math.min(pos.qty, pos.originalQty * fraction);
      if (qtyToClose <= 0) {
        // target passed but R is in charge of partials - note it and let the
        // breakeven move below still happen
        actions.push(`${sym}: 觸及止盈 ${target}（分批由 R 倍數負責，未平倉）`);
        changed = true;
        const t = settings.trading.trailing;
        if (t.moveToBreakevenOnTp1 && !pos.beMoved && pos.qty > 1e-9) {
          const offset = t.breakevenOffsetPercent / 100;
          const newSl = pos.side === "long"
            ? pos.entryPrice * (1 - offset)
            : pos.entryPrice * (1 + offset);
          const better = pos.stopLoss == null ||
            (pos.side === "long" ? newSl > pos.stopLoss : newSl < pos.stopLoss);
          pos.beMoved = true;
          if (better) {
            pos.stopLoss = newSl;
            await syncExchangeStops(client, settings, live, pos);
            actions.push(`${sym}: 止損移到保本區 ${newSl.toFixed(6)}`);
          }
        }
        continue;
      }
      try {
        const ids = await closeQty(client, live, pos, qtyToClose);
        bookClose(pos, qtyToClose, price);
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
        await finishTrade(pos, price, "tp_hit");
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
      // record what protection exists so the dashboard can display it without
      // making exchange calls of its own
      const bySymbol: Record<string, { kind: "tp" | "sl"; trigger: number | null }[]> = {};
      for (const o of stops) {
        (bySymbol[o.symbol] ??= []).push({ kind: o.kind, trigger: o.trigger });
      }
      await setStopSnapshot({ at: Date.now(), bySymbol });

      // The reverse of the orphan sweep: positions the EXCHANGE holds that this
      // app has no record of. They arise when a close is booked while a
      // remainder is still open - a scale-out whose slices did not add up, or a
      // record deleted by hand. They are unmanaged, and worse, the duplicate
      // guard refuses to open that symbol again while they exist, so the coin
      // goes quiet with no visible reason. Record them for the dashboard.
      await setUntrackedSnapshot({
        at: Date.now(),
        positions: held
          .filter(
            (h) =>
              h.qty > 0 &&
              !trackedSymbols.has(h.symbol) &&
              !trackedAtStart.has(h.symbol)
          )
          .map((h) => ({
            symbol: h.symbol,
            side: h.side,
            qty: h.qty,
            entryPrice: h.entryPrice,
          })),
      });

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

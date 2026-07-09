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
import { PionexApiError, PionexClient, toPerpSymbol } from "./pionex";
import {
  appendOrder,
  appendSignal,
  checkAndMarkSeen,
  getCooldowns,
  getPositions,
  savePositions,
  setCooldown,
} from "./store";
import { OrderRecord, ParsedSignal, Position, Settings } from "./types";

function makeClient(settings: Settings): PionexClient {
  return new PionexClient(
    settings.pionex.apiKey,
    settings.pionex.apiSecret,
    settings.pionex.baseUrl
  );
}

function isLive(settings: Settings): boolean {
  return (
    settings.trading.liveTrading &&
    !!settings.pionex.apiKey &&
    !!settings.pionex.apiSecret
  );
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
async function computeSizeUsdt(
  settings: Settings,
  signal: ParsedSignal,
  client: PionexClient,
  live: boolean,
  forAdd: boolean
): Promise<number> {
  if (forAdd && settings.trading.addPositionUsdt > 0) {
    return signal.sizeUsdt ?? settings.trading.addPositionUsdt;
  }
  const sizing = settings.trading.sizing;
  if (sizing.mode === "signal" && signal.sizeUsdt && signal.sizeUsdt > 0) {
    return signal.sizeUsdt;
  }
  if (sizing.mode === "percent_balance") {
    if (!live) return sizing.fixedUsdt; // no balance to query in dry-run
    const balance = await client.getAvailableUsdt();
    if (balance <= 0) throw new Error(`available balance is ${balance}`);
    return (balance * sizing.percentBalance) / 100;
  }
  return sizing.fixedUsdt;
}

function computeLeverage(settings: Settings, signal: ParsedSignal): number {
  const lev = signal.leverage ?? settings.trading.leverage.default;
  return Math.min(Math.max(lev, 1), settings.trading.leverage.max);
}

async function fetchPriceSafe(
  client: PionexClient,
  symbol: string,
  fallback: number | null
): Promise<number | null> {
  try {
    return await client.getPrice(toPerpSymbol(symbol));
  } catch {
    return fallback;
  }
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
  if (last && (Date.now() - last) / 1000 < risk.cooldownSeconds)
    return `cooldown active for ${sym}`;

  if (signal.action === "open") {
    if (positions[sym]) return `position already open for ${sym}`;
    if (Object.keys(positions).length >= risk.maxOpenPositions)
      return `max open positions reached (${risk.maxOpenPositions})`;
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
  client: PionexClient,
  live: boolean,
  symbol: string,
  side: "long" | "short",
  sizeUsdt: number,
  entryType: "market" | "limit",
  limitPrice: number | null,
  refPrice: number | null
): Promise<{ qty: number; price: number; orderIds: string[]; note: string }> {
  const perp = toPerpSymbol(symbol);
  const price = limitPrice ?? refPrice;
  if (!price || price <= 0) throw new Error(`no price available for ${symbol}`);
  const qty = sizeUsdt / price;

  if (!live) {
    return {
      qty,
      price,
      orderIds: [],
      note: `dry-run: simulated ${entryType} ${side} ${symbol} ${sizeUsdt} USDT @ ${price}`,
    };
  }

  const apiSide = side === "long" ? "BUY" : "SELL";
  let resp: Record<string, any>;
  if (entryType === "limit" && limitPrice) {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "LIMIT",
      size: qty.toFixed(6), price: String(limitPrice),
    });
  } else if (apiSide === "BUY") {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "MARKET", amount: sizeUsdt.toFixed(2),
    });
  } else {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "MARKET", size: qty.toFixed(6),
    });
  }
  const oid = String(resp?.data?.orderId ?? "");
  return {
    qty,
    price,
    orderIds: oid ? [oid] : [],
    note: `${entryType} ${side} order placed`,
  };
}

async function closeQty(
  client: PionexClient,
  live: boolean,
  pos: Position,
  qty: number
): Promise<string[]> {
  if (!live || pos.dryRun) return [];
  const perp = toPerpSymbol(pos.symbol);
  const apiSide = pos.side === "long" ? "SELL" : "BUY";
  let resp: Record<string, any>;
  if (apiSide === "SELL") {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "MARKET", size: qty.toFixed(6),
    });
  } else {
    // closing a short = market BUY; use quote amount based on current price
    const price = await client.getPrice(perp);
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "MARKET",
      amount: (qty * price).toFixed(2),
    });
  }
  const oid = String(resp?.data?.orderId ?? "");
  return oid ? [oid] : [];
}

// ------------------------------------------------------------ main handler
export async function handleIncomingMessage(
  text: string,
  meta: { chatId: string; messageId: number; timestamp: number },
  settings: Settings
): Promise<void> {
  // 1. noise filter (news, data releases, ads ...)
  if (isFiltered(text, settings.filters.ignoreKeywords)) {
    await appendSignal({
      at: Date.now(), chatId: meta.chatId, messageId: meta.messageId,
      action: "filtered", symbol: null, side: null,
      summary: "matched ignore keyword", rawText: text.slice(0, 500),
    });
    return;
  }

  // 2. parse
  const signal = parseSignal(text, meta, {
    ignoreKeywords: settings.filters.ignoreKeywords,
    extraLongKeywords: settings.filters.extraLongKeywords,
    extraShortKeywords: settings.filters.extraShortKeywords,
  });
  if (!signal) {
    // unrecognizable chatter - log lightly so the dashboard shows liveness
    await appendSignal({
      at: Date.now(), chatId: meta.chatId, messageId: meta.messageId,
      action: "ignored", symbol: null, side: null,
      summary: "no trading pair / not a signal", rawText: text.slice(0, 200),
    });
    return;
  }

  // 3. dedup (covers Telegram redeliveries; edits get a new content digest)
  if (await checkAndMarkSeen(dedupKey(signal))) return;

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

  const reject = riskReject(settings, signal, positions, cooldowns);
  if (reject) {
    await record(
      signal.action,
      { symbol: sym, side: signal.side, sizeUsdt: 0, qty: 0, price: null, leverage: 0 },
      live, false, `rejected: ${reject}`
    );
    return;
  }

  try {
    switch (signal.action) {
      case "open": {
        if (!signal.side) {
          await record(signal.action, { symbol: sym, side: null, sizeUsdt: 0, qty: 0, price: null, leverage: 0 }, live, false, "rejected: no long/short side in signal");
          return;
        }
        const leverage = computeLeverage(settings, signal);
        const sizeUsdt = await computeSizeUsdt(settings, signal, client, live, false);
        const refPrice = await fetchPriceSafe(client, sym, signal.entryPrice);
        const entryType = settings.trading.orders.entryType;
        const limitPrice =
          entryType === "limit" ? signal.entryPrice ?? refPrice : null;
        const res = await placeEntry(
          client, live, sym, signal.side, sizeUsdt,
          limitPrice ? entryType : "market", limitPrice, refPrice
        );
        positions[sym] = {
          symbol: sym,
          side: signal.side,
          leverage,
          entryPrice: res.price,
          qty: res.qty,
          originalQty: res.qty,
          sizeUsdt,
          stopLoss: settings.trading.orders.attachStopLoss ? signal.stopLoss : null,
          takeProfits: settings.trading.orders.attachTakeProfit
            ? [...signal.takeProfits].sort((a, b) =>
                signal.side === "long" ? a - b : b - a)
            : [],
          tpCountOriginal: signal.takeProfits.length,
          orderIds: res.orderIds,
          openedAt: Date.now(),
          addCount: 0,
          dryRun: !live,
        };
        await savePositions(positions);
        await setCooldown(sym, Date.now());
        await record("open",
          { symbol: sym, side: signal.side, sizeUsdt, qty: res.qty, price: res.price, leverage },
          live, true, res.note, res.orderIds);
        return;
      }

      case "add": {
        const p = pos!;
        const sizeUsdt = await computeSizeUsdt(settings, signal, client, live, true);
        const refPrice = await fetchPriceSafe(client, sym, signal.entryPrice ?? p.entryPrice);
        const res = await placeEntry(
          client, live && !p.dryRun, sym, p.side, sizeUsdt, "market", null, refPrice
        );
        const newQty = p.qty + res.qty;
        p.entryPrice = (p.entryPrice * p.qty + res.price * res.qty) / newQty;
        p.qty = newQty;
        p.originalQty += res.qty;
        p.sizeUsdt += sizeUsdt;
        p.addCount += 1;
        if (signal.stopLoss) p.stopLoss = signal.stopLoss;
        await savePositions(positions);
        await setCooldown(sym, Date.now());
        await record("add",
          { symbol: sym, side: p.side, sizeUsdt, qty: res.qty, price: res.price, leverage: p.leverage },
          live && !p.dryRun, true, `added to position (${p.addCount}x); ${res.note}`, res.orderIds);
        return;
      }

      case "close": {
        if (!pos) {
          await record("close", { symbol: sym, side: null, sizeUsdt: 0, qty: 0, price: null, leverage: 0 }, live, false, `no tracked position for ${sym}`);
          return;
        }
        const ids = await closeQty(client, live, pos, pos.qty);
        delete positions[sym];
        await savePositions(positions);
        await record("close",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: null, leverage: pos.leverage },
          live && !pos.dryRun, true,
          pos.dryRun || !live ? "dry-run: position closed in tracker" : "position closed (market)", ids);
        return;
      }

      case "cancel": {
        let n = 0;
        if (live) n = await client.cancelAllOrders(toPerpSymbol(sym));
        if (pos && pos.orderIds.length) pos.orderIds = [];
        await savePositions(positions);
        await record("cancel",
          { symbol: sym, side: null, sizeUsdt: 0, qty: 0, price: null, leverage: 0 },
          live, true,
          live ? `cancelled ${n} open order(s)` : "dry-run: pending orders cleared in tracker");
        return;
      }

      case "update_sl": {
        if (!pos) {
          await record("update_sl", { symbol: sym, side: null, sizeUsdt: 0, qty: 0, price: null, leverage: 0 }, live, false, `no tracked position for ${sym}`);
          return;
        }
        const newSl = signal.stopLossBreakeven ? pos.entryPrice : signal.stopLoss;
        if (newSl == null) {
          await record("update_sl", { symbol: sym, side: pos.side, sizeUsdt: 0, qty: 0, price: null, leverage: pos.leverage }, live, false, "no stop-loss value found in message");
          return;
        }
        const old = pos.stopLoss;
        pos.stopLoss = newSl;
        await savePositions(positions);
        await record("update_sl",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: newSl, leverage: pos.leverage },
          live, true, `stop-loss moved ${old ?? "none"} -> ${newSl}${signal.stopLossBreakeven ? " (breakeven)" : ""}`);
        return;
      }

      case "update_tp": {
        if (!pos) {
          await record("update_tp", { symbol: sym, side: null, sizeUsdt: 0, qty: 0, price: null, leverage: 0 }, live, false, `no tracked position for ${sym}`);
          return;
        }
        if (!signal.takeProfits.length) {
          await record("update_tp", { symbol: sym, side: pos.side, sizeUsdt: 0, qty: 0, price: null, leverage: pos.leverage }, live, false, "no take-profit values found in message");
          return;
        }
        pos.takeProfits = [...signal.takeProfits].sort((a, b) =>
          pos.side === "long" ? a - b : b - a);
        pos.tpCountOriginal = Math.max(pos.tpCountOriginal, pos.takeProfits.length);
        await savePositions(positions);
        await record("update_tp",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: pos.takeProfits[0], leverage: pos.leverage },
          live, true, `take-profits set to ${pos.takeProfits.join("/")}`);
        return;
      }
    }
  } catch (err) {
    const msg = err instanceof PionexApiError
      ? `Pionex API error: ${err.message}`
      : `execution failed: ${(err as Error).message}`;
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

  for (const sym of Object.keys(positions)) {
    const pos = positions[sym];
    const price = await fetchPriceSafe(client, sym, null);
    if (price == null) {
      actions.push(`${sym}: price unavailable, skipped`);
      continue;
    }
    const dir = pos.side === "long" ? 1 : -1;

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
          await record("trailing_move",
            { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: candidate, leverage: pos.leverage },
            live && !pos.dryRun, true, `trailing stop moved to ${candidate.toFixed(6)} (price ${price})`);
        }
      }
    }

    // stop-loss: close everything
    if (pos.stopLoss != null && (price - pos.stopLoss) * dir <= 0) {
      try {
        const ids = await closeQty(client, live, pos, pos.qty);
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

    // take-profit: each hit target closes an equal fraction of the original qty
    while (pos.takeProfits.length && (price - pos.takeProfits[0]) * dir >= 0) {
      const target = pos.takeProfits.shift()!;
      const fraction = pos.tpCountOriginal > 0 ? 1 / pos.tpCountOriginal : 1;
      const qtyToClose = pos.takeProfits.length === 0
        ? pos.qty // last target -> close the remainder
        : Math.min(pos.qty, pos.originalQty * fraction);
      try {
        const ids = await closeQty(client, live, pos, qtyToClose);
        pos.qty -= qtyToClose;
        changed = true;
        actions.push(`${sym}: TP ${target} hit at ${price}, closed ${qtyToClose.toFixed(6)}`);
        await record("tp_hit",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: qtyToClose, price, leverage: pos.leverage },
          live && !pos.dryRun, true, `take-profit ${target} hit at ${price}`, ids);
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
  }

  if (changed) await savePositions(positions);
  return actions;
}

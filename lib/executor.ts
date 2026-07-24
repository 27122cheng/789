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
import {
  PionexApiError,
  PionexClient,
  ceilToDecimals,
  floorToDecimals,
} from "./pionex";
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

function makeClient(settings: Settings): PionexClient {
  return new PionexClient(
    settings.pionex.apiKey,
    settings.pionex.apiSecret,
    settings.pionex.baseUrl,
    settings.pionex.symbolFormat
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
    return await client.getPrice(client.perpSymbol(symbol));
  } catch {
    return fallback;
  }
}

/** Align signal prices to Pionex's price precision per the user's rule:
 *  entry & stop-loss round UP (無條件進位), take-profits round DOWN (無條件縮減).
 *  If the precision can't be determined, values are left unchanged. */
async function alignPrices(
  client: PionexClient,
  symbol: string,
  p: { entry?: number | null; stopLoss?: number | null; takeProfits?: number[] }
): Promise<{ entry: number | null; stopLoss: number | null; takeProfits: number[] }> {
  const dec = await client.pricePrecision(client.perpSymbol(symbol));
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
  if (last && (Date.now() - last) / 1000 < risk.cooldownSeconds)
    return `cooldown active for ${sym}`;

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
  client: PionexClient,
  live: boolean,
  symbol: string,
  side: "long" | "short",
  sizeUsdt: number,
  entryType: "market" | "limit",
  limitPrice: number | null,
  refPrice: number | null
): Promise<{ qty: number; price: number; orderIds: string[]; note: string }> {
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
    };
  }

  // round quantity DOWN to Pionex's base precision so we never exceed size
  const baseDec = await client.basePrecision(symbol);
  const qtyStr = baseDec == null ? qty.toFixed(6) : floorToDecimals(qty, baseDec).toFixed(baseDec);

  const apiSide = side === "long" ? "BUY" : "SELL";
  let resp: Record<string, any>;
  if (entryType === "limit" && limitPrice) {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "LIMIT",
      size: qtyStr, price: String(limitPrice),
    });
  } else if (apiSide === "BUY") {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "MARKET", amount: sizeUsdt.toFixed(2),
    });
  } else {
    resp = await client.placeOrder({
      symbol: perp, side: apiSide, type: "MARKET", size: qtyStr,
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
  const perp = client.perpSymbol(pos.symbol);
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
        const sizeUsdt = await computeSizeUsdt(settings, signal, client, live, false);
        // align signal prices to Pionex precision: entry/SL up, TP down
        const aligned = await alignPrices(client, sym, {
          entry: signal.entryPrice,
          stopLoss: signal.stopLoss,
          takeProfits: signal.takeProfits,
        });
        const refPrice = await fetchPriceSafe(client, sym, aligned.entry);
        const entryType = settings.trading.orders.entryType;
        const limitPrice =
          entryType === "limit" ? aligned.entry ?? refPrice : null;
        const res = await placeEntry(
          client, live, sym, signal.side, sizeUsdt,
          limitPrice ? entryType : "market", limitPrice, refPrice
        );
        const maxAdds = settings.trading.risk.maxAddsPerPosition;
        const slForRisk = settings.trading.orders.attachStopLoss ? aligned.stopLoss : null;
        const initialRisk =
          slForRisk != null ? Math.abs(res.price - slForRisk) : null;
        const rt = settings.trading.orders.rTakeProfit;
        positions[sym] = {
          symbol: sym,
          side: signal.side,
          leverage,
          entryPrice: res.price,
          qty: res.qty,
          originalQty: res.qty,
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
          entryOrderType: limitPrice ? entryType : "market",
          beMoved: false,
          initialRisk,
          rTargets:
            rt?.enabled && initialRisk
              ? rt.levels.map((l) => ({ r: l.r, closePercent: l.closePercent, done: false }))
              : [],
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
          return; // close signal for a symbol we don't hold - ignore silently
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
        // Silent background handling: cancel exchange orders / drop or close
        // the tracked position, purge the trade's earlier signal & order
        // records, and record nothing new.
        if (live) await client.cancelAllOrders(client.perpSymbol(sym));
        if (pos) {
          if (pos.entryOrderType !== "limit") {
            // market entry already filled -> cancelling the idea means exiting
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
        await record("update_sl",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: newSl, leverage: pos.leverage },
          live, true, `stop-loss moved ${old ?? "none"} -> ${newSl}${signal.stopLossBreakeven ? " (breakeven)" : ""}`);
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
        await record("update_tp",
          { symbol: sym, side: pos.side, sizeUsdt: pos.sizeUsdt, qty: pos.qty, price: pos.takeProfits[0], leverage: pos.leverage },
          live, true, `take-profits set to ${pos.takeProfits.join("/")}`);
        return;
      }
    }
  } catch (err) {
    // PionexApiError.message already carries the "Pionex API error ..." prefix
    const msg = err instanceof PionexApiError
      ? err.message
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
          "market", null, add.level
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
  }

  if (changed) await savePositions(positions);
  return actions;
}

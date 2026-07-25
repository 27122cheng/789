/**
 * Sizing preview: answers "if I set N USDT, what does that actually become on
 * the exchange?" before a signal ever arrives.
 *
 * The venue's order unit and its minimum are properties of the contract, not
 * of the amount you type, so a configured size can silently turn into a bigger
 * (or impossible) order. This reports the real numbers - price, the venue's
 * minimum, and what N USDT would actually place - using the same client and
 * rounding the executor uses. Read-only: nothing is ordered.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { getSettings } from "@/lib/store";
import { OkxClient } from "@/lib/okx";
import { PionexClient } from "@/lib/pionex";
import { ExchangeClient } from "@/lib/exchange";
import { floorToDecimals } from "@/lib/num";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  const url = new URL(req.url);
  const symbol = (url.searchParams.get("symbol") || "BTCUSDT")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  const usdt = Number(url.searchParams.get("usdt") || "0");
  const levParam = Number(url.searchParams.get("lev") || "0");
  if (!symbol || !Number.isFinite(usdt) || usdt <= 0) {
    return NextResponse.json({ error: "請提供幣種與大於 0 的 USDT 金額" }, { status: 400 });
  }

  const settings = await getSettings();
  const client: ExchangeClient =
    settings.exchange === "okx"
      ? new OkxClient(
          settings.okx.apiKey, settings.okx.apiSecret, settings.okx.passphrase,
          settings.okx.baseUrl, settings.okx.tdMode, settings.okx.demo
        )
      : new PionexClient(
          settings.pionex.apiKey, settings.pionex.apiSecret,
          settings.pionex.baseUrl, settings.pionex.symbolFormat
        );

  // the entered amount means margin unless configured otherwise, so the actual
  // position is that amount times the leverage
  const levCfg = settings.trading.leverage;
  const leverage =
    levParam > 0
      ? levParam
      : levCfg.whenUnspecified === "default"
      ? levCfg.default
      : levCfg.max;
  const basis = settings.trading.sizing.basis ?? "margin";
  const notionalUsdt = basis === "margin" ? usdt * Math.max(1, leverage) : usdt;

  const venueSymbol = client.perpSymbol(symbol);
  try {
    const [price, filters] = await Promise.all([
      client.getPrice(venueSymbol),
      client.orderFilters(symbol),
    ]);

    const baseDec = filters.baseDecimals ?? 6;
    const minSize = filters.minSizeMarket ?? filters.minSizeLimit;
    const wantQty = floorToDecimals(notionalUsdt / price, baseDec);

    const lifted = !!(minSize && wantQty < minSize);
    const finalQty = lifted ? minSize! : wantQty;
    const policy = settings.trading.orders.belowMinSize ?? "lift";
    const finalNotional = finalQty * price;
    // order sizes come in fixed increments; on expensive coins one increment
    // is worth several USDT, so the configured amount is rarely reachable
    const step = Math.pow(10, -baseDec);
    const stepNotional = step * price;
    const roundedDown = !lifted && finalNotional < notionalUsdt * 0.98;

    return NextResponse.json({
      exchange: settings.exchange,
      symbol,
      venueSymbol,
      price,
      requestedUsdt: usdt,
      basis,
      leverage,
      // what the entered amount actually becomes as a position
      targetNotionalUsdt: +notionalUsdt.toFixed(4),
      marginUsdt: +(finalQty * price / Math.max(1, leverage)).toFixed(4),
      minSizeBase: minSize,
      minNotionalUsdt: minSize != null ? +(minSize * price).toFixed(4) : null,
      finalQtyBase: finalQty,
      finalNotionalUsdt: +finalNotional.toFixed(4),
      stepBase: step,
      stepNotionalUsdt: +stepNotional.toFixed(4),
      // the amounts actually reachable around what was asked for
      reachableUsdt: [
        +(Math.floor(notionalUsdt / stepNotional) * stepNotional).toFixed(2),
        +((Math.floor(notionalUsdt / stepNotional) + 1) * stepNotional).toFixed(2),
      ].filter((v) => v > 0),
      roundedDown,
      orderUnit: client.describeOrderSize
        ? await client.describeOrderSize(symbol, finalQty).catch(() => null)
        : null,
      lifted,
      policy,
      // what will actually happen with the current setting
      outcome:
        finalQty <= 0
          ? "無法下單（數量為 0）"
          : lifted && policy === "skip"
          ? "會跳過這筆訊號（依設定：低於最低量不交易）"
          : lifted
          ? "會以交易所最低量下單（金額大於你設定的）"
          : roundedDown
          ? `會向下對齊到 ${finalNotional.toFixed(2)} USDT（下單量只能是每階 ` +
            `${stepNotional.toFixed(2)} USDT 的整數倍，不會超過你設定的金額）`
          : "會照設定金額下單",
    });
  } catch (e) {
    return NextResponse.json(
      { error: `查詢失敗：${(e as Error).message}`, symbol, venueSymbol },
      { status: 502 }
    );
  }
}

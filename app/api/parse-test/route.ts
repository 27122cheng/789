/**
 * Parse a pasted message exactly as the webhook would, without executing
 * anything - a safe way to verify the parser's signal-vs-noise judgment.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/auth";
import { isFiltered, parseSignal } from "@/lib/parser";
import { getSettings } from "@/lib/store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const denied = await requireAdmin(req);
  if (denied) return denied;

  let body: { text?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  const text = body.text ?? "";
  const settings = await getSettings();

  if (isFiltered(text, settings.filters.ignoreKeywords)) {
    return NextResponse.json({
      verdict: "filtered",
      reason: "命中忽略關鍵字（新聞/數據/廣告）",
    });
  }

  const signal = parseSignal(
    text,
    { chatId: "test", messageId: 0, timestamp: Date.now() },
    {
      ignoreKeywords: settings.filters.ignoreKeywords,
      extraLongKeywords: settings.filters.extraLongKeywords,
      extraShortKeywords: settings.filters.extraShortKeywords,
    }
  );

  if (!signal) {
    return NextResponse.json({
      verdict: "not_a_signal",
      reason: "找不到交易對，或不像交易信號",
    });
  }

  // mirror the executor's open-guard so the test reflects real behaviour
  const willReject =
    signal.action === "open" &&
    settings.trading.risk.requireEntryAndSl &&
    (signal.entryPrice === null || signal.stopLoss === null);

  return NextResponse.json({
    verdict: signal.action,
    wouldExecute: !willReject,
    rejectReason: willReject
      ? "開倉信號缺少進場價或止損（requireEntryAndSl 已開啟）"
      : null,
    parsed: {
      symbol: signal.symbol,
      side: signal.side,
      leverage: signal.leverage,
      entryPrice: signal.entryPrice,
      entryPriceHigh: signal.entryPriceHigh,
      takeProfits: signal.takeProfits,
      stopLoss: signal.stopLoss,
      stopLossBreakeven: signal.stopLossBreakeven,
      addLevels: signal.addLevels,
      upgrade: signal.upgrade,
      sizeUsdt: signal.sizeUsdt,
    },
    warnings: signal.warnings,
  });
}

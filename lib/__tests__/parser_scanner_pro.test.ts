/**
 * Real-world formats from the 加密掃描 Pro Telegram bot (transcribed from
 * the user's screenshots).
 */
import { describe, expect, it } from "vitest";
import { parseSignal } from "../parser";

const meta = { chatId: "-100999", messageId: 1, timestamp: Date.now() };

const SHORT_TERM_OPEN = `🚨 加密掃描 Pro — 短線單信號
▲ 做多（Long）：ZEC/USDT
⏰ 07/12 下午 11:04
⏱ Kill Zone： 😴 盤整時段
📊 FVG 缺口 $516.885 未回補
🥇 AI 訊號品質：A 級 — 優質訊號（25因子評分 10 分）
⚠️ 配額寬鬆模式建單：今日訊號未達 3 個，門檻暫調 SQ≥8、風控分≥55（寬鬆單表現不佳會自動熔斷）
📶 風控分：69 分

📍 進場： $533
🛑 止損： $526.133 (-1.29%)
🎯 止盈一： $543.301 (+1.93% | R:R 1.5:1)
🚀 止盈二： $553.601 (+3.87% | R:R 3.0:1)

📈 本週預測： ▼ 偏空（信心 85%）
📅 今日預測： ▼ 小幅偏空（信心 62%）

🛡 風控扣分明細
 止損風控扣分 -31 分

#zec #crypto #long`;

const LONG_TERM_OPEN = `🔼 加密掃描 Pro — 長線單升級信號
▼ 做空（Short）：ONE/USDT
⏰ 07/08 下午 07:38
⏱ Kill Zone： 😴 盤整時段
📊 FVG 缺口 $0.001235 未回補
🏆 AI 訊號品質：S 級 — 頂級訊號（24因子評分 15 分）
📶 風控分：64 分

📍 進場： $0.00117914
🛑 止損： $0.00120651 (+2.32%)
🏁 最終止盈： $0.00096014 (-18.57% | R:R 8.0:1)

💰 加倉計劃（2 次）
 🥇 加倉 1： $0.00110614
 🥈 加倉 2： $0.00103314

📈 本週預測： ▼▼ 強勢偏空（信心 92%）
📅 今日預測： ▼ 偏空（信心 88%）

🛡 風控扣分明細
 風險評估扣分 -1 分（中風險 33/100）

⚠️ 中風險提示（33/100）：中風險
 ▸ 建議倉位不超過正常的 70%
 ▸ 此幣種歷史止損模式頻繁，可等更好進場點`;

const SL_ADJUST = `🚀 AI 偵測：盈利 3.2R，建議追蹤止損

💎 XTZ/USDT ▼ 空

📍 進場： $0.2394
🛑 建議止損調整
 ⬇ 下移 0.2394 → 0.237906
 新止損： $0.237906

💰 現價： $0.2299
📊 浮動盈虧：+3.18 R
📉 ATR 波動率：1.30%

🔍 AI 止損位分析（技術 ＋ 籌碼 ＋ 基本面）
 ⚠️ MACD 柱狀轉正，空頭動能減弱 -0.4
 ✅ RSI 54.8 空頭健康區，趨勢延續 +0.3`;

const CANCELLED = `🚫 交易建議已取消
▲ 做多（Long）：ACH/USDT
📋 取消原因：訊號品質下降

#ach #long #取消`;

const FLEW_PAST_TP = `⚡ 未進場已飛越止盈二！

💎 OGN/USDT ▲ 做多

📍 原掛單進場： $0.0172372
🎯 止盈二： $0.0179809
💰 現價： $0.0179809

ℹ️ 價格未回踩進場位，直接突破止盈二，本次掛單已自動取消。
若仍看好方向，可重新評估追多機會。`;

describe("加密掃描 Pro formats", () => {
  it("parses a short-term open signal", () => {
    const s = parseSignal(SHORT_TERM_OPEN, meta)!;
    expect(s.action).toBe("open");
    expect(s.symbol).toBe("ZECUSDT");
    expect(s.side).toBe("long");
    expect(s.entryPrice).toBe(533);
    expect(s.stopLoss).toBe(526.133);
    expect(s.takeProfits).toEqual([543.301, 553.601]);
    expect(s.addLevels).toEqual([]);
  });

  it("parses a long-term open signal with 加倉計劃 levels", () => {
    const s = parseSignal(LONG_TERM_OPEN, meta)!;
    expect(s.action).toBe("open");
    expect(s.symbol).toBe("ONEUSDT");
    expect(s.side).toBe("short");
    expect(s.entryPrice).toBe(0.00117914);
    expect(s.stopLoss).toBe(0.00120651);
    expect(s.takeProfits).toEqual([0.00096014]); // 最終止盈
    expect(s.addLevels).toEqual([0.00110614, 0.00103314]);
  });

  it("parses a stop-loss adjustment (追蹤止損 / 新止損)", () => {
    const s = parseSignal(SL_ADJUST, meta)!;
    expect(s.action).toBe("update_sl");
    expect(s.symbol).toBe("XTZUSDT");
    expect(s.stopLoss).toBe(0.237906);
    expect(s.stopLossBreakeven).toBe(false);
  });

  it("parses 交易建議已取消 as cancel", () => {
    const s = parseSignal(CANCELLED, meta)!;
    expect(s.action).toBe("cancel");
    expect(s.symbol).toBe("ACHUSDT");
  });

  it("parses 未進場已飛越止盈 as cancel", () => {
    const s = parseSignal(FLEW_PAST_TP, meta)!;
    expect(s.action).toBe("cancel");
    expect(s.symbol).toBe("OGNUSDT");
  });

  it("does not misread junk numbers (R:R, 評分, %) as prices", () => {
    const s = parseSignal(SHORT_TERM_OPEN, meta)!;
    // only the two real TPs, not 1.93 / 1.5 / 3.87 / 3.0 from the R:R text
    expect(s.takeProfits).toHaveLength(2);
    expect(s.leverage).toBeNull(); // "R:R 1.5:1" etc. must not become leverage
  });
});

describe("noise rejection (analysis posts must NOT become signals)", () => {
  it("ignores a market-analysis link post that mentions a coin", () => {
    // e.g. the "查看 TRB 詳細分析 →" style rows and daily briefings
    expect(
      parseSignal("🔗 查看 BTCUSDT 詳細分析 →\n📈 本週預測：偏多（信心 70%）", meta)
    ).toBeNull();
  });

  it("ignores a standalone AI 止損位分析 commentary block without a new stop", () => {
    const s = parseSignal(
      `🔍 BTCUSDT AI 止損位分析（技術 ＋ 籌碼 ＋ 基本面）
 ⚠️ MACD 柱狀轉正，空頭動能減弱 -0.4
 ✅ RSI 54.8 空頭健康區，趨勢延續 +0.3
 ✅ ADX 29.2 趨勢有效 +0.2`,
      meta
    );
    // no entry, no explicit 新止損/調整 value, no action -> not tradable
    expect(s).toBeNull();
  });

  it("ignores a daily prediction summary", () => {
    expect(
      parseSignal(
        "📅 今日預測：ETHUSDT ▼ 小幅偏空（信心 62%）\n📊 ATR 波動率：1.30%",
        meta
      )
    ).toBeNull();
  });

  it("still accepts a terse but real directional signal with a price", () => {
    const s = parseSignal("做多 SOLUSDT 進場 150 止損 140", meta)!;
    expect(s.action).toBe("open");
    expect(s.side).toBe("long");
    expect(s.entryPrice).toBe(150);
    expect(s.stopLoss).toBe(140);
  });
});

describe("長線單 加倉確認 (tranche limit order)", () => {
  const msg = `📌 加倉確認 #1｜請掛單 — BTC ▲ 做多

✅ 價格已站上加倉點上方並持續 2 分鐘，確認非假突破

🎯 掛限價單於：$103（回踩此價成交）
🛑 此筆止損：$101.5
📌 主倉進場：$100　主倉止損：$99

📝 成交後主倉止損將往獲利方向推進，屆時另行通知`;

  it("is an add, not a new position, despite the entry+stop wording", () => {
    const sig = parseSignal(msg, meta);
    expect(sig).not.toBeNull();
    expect(sig!.action).toBe("add");
    expect(sig!.symbol).toBe("BTCUSDT");
  });

  it("uses the tranche's limit price and stop, not the main position's", () => {
    const sig = parseSignal(msg, meta)!;
    expect(sig.entryPrice).toBe(103);      // 掛限價單於, not 主倉進場 100
    expect(sig.stopLoss).toBe(101.5);      // 此筆止損, not 主倉止損 99
  });
});

describe("完整加倉通知序列 (four message types)", () => {
  it("➕ 加倉訊號: announced only, must NOT place an order", () => {
    const s = parseSignal(
      `➕ 加倉訊號 #1 — BTC ▲ 做多\n加倉價位：$103\n預計止損：$101.5`,
      meta
    )!;
    expect(s.action).toBe("add_plan");
    expect(s.symbol).toBe("BTCUSDT");
  });

  it("📌 加倉確認｜請掛單: places the tranche order", () => {
    const s = parseSignal(
      `📌 加倉確認 #1｜請掛單 — BTC ▲ 做多\n🎯 掛限價單於：$103\n🛑 此筆止損：$101.5`,
      meta
    )!;
    expect(s.action).toBe("add");
    expect(s.entryPrice).toBe(103);
    expect(s.stopLoss).toBe(101.5);
  });

  it("📈 加倉確認通知: a fill report that moves the stop, not a new order", () => {
    const s = parseSignal(
      `📈 加倉確認通知 #1 — BTC ▲ 做多\n成交價：$103\n🔧 止損上移至：$101.8`,
      meta
    )!;
    expect(s.action).toBe("update_sl");
    expect(s.stopLoss).toBe(101.8);
  });

  it("⏹ 加倉掛單失效: cancels that order only", () => {
    const s = parseSignal(`⏹ 加倉掛單失效 #1 — BTC ▲ 做多\n請撤單`, meta)!;
    expect(s.action).toBe("add_cancel");
    expect(s.symbol).toBe("BTCUSDT");
  });

  it("🔧 止損調整 (3/3 保本位保護) is still an ordinary stop move", () => {
    const s = parseSignal(
      `🔧 止損調整 — BTC ▲ 做多\n保本位保護\n新止損：$100.2`,
      meta
    )!;
    expect(s.action).toBe("update_sl");
    expect(s.stopLoss).toBe(100.2);
  });
});

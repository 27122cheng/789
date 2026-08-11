/**
 * The 快進快出 (scalp) signal format. Its message set differs from 加密掃描 Pro
 * in ways that matter for safety:
 *   - 觸及止盈一 is a MILESTONE, not a close - it announces a partial reduction
 *     and a stop move, and reading it as "close" would flatten the position and
 *     forfeit 止盈二
 *   - the open message describes its own future stop management
 *     (「浮盈達 +0.6R 自動移到保本」), which must not read as a stop move
 *   - a real exit is always labelled 交易結束, even when its reason text
 *     mentions 止盈 or 止損上移
 */
import { describe, expect, it } from "vitest";
import { parseSignal } from "../parser";

const meta = { chatId: "-100123", messageId: 1, timestamp: Date.now() };
const parse = (t: string) => parseSignal(t, meta, {});

const OPEN = `⚡ 快進快出訊號 — ONDO ▼ 做空
📍 進場： $0.3381 (市價)
🛑 止損： $0.340354 (0.6×ATR，機器人學習)
🤖 └D 假突破反轉 38 筆學習 (秒損率 0%)
📦 數量：1597.1606　名目 $540 風險 $3.6 (0.36% 權益)
🎯 止盈一： $0.334719 (1.5R，減倉 60%)
🚀 止盈二： $0.333592 (2R)
🛡 浮盈達 +0.6R 自動移到保本
💸 止損距離 0.667%，來回手續費約 15% 的 R
⏱ 停滯 20 分出場｜最長持有 60 分
⏰ 08/11 下午 10:13
#ondo #scalp #short #自動交易`;

const TP1_HIT = `🎯 快進快出｜觸及止盈一 — CRV ▲ 做多

減倉 60%，止損上移至 $0.265382（鎖 +0.5R）

⏰ 08/11 下午 09:47
#crv #scalp #止盈一`;

const BREAKEVEN = `🛡 快進快出｜移到保本 — CRV ▲ 做多
此後這筆單最差就是不賺不賠，不會再變成虧損。
⏰ 08/11 下午 09:37
#crv #scalp #保本`;

const END_TRAIL = `✅ 快進快出｜交易結束 — 移動停利出場
CRV ▲ 做多
📝 結束原因：觸及止盈一後止損已上移至獲利區，價格回落觸及 $0.267118，鎖住獲利出場
📍 進場 $0.2645 → 出場 $0.267118
📊 損益：+1.34R ≈ +$8.04
⏰ 08/11 下午 09:51
#crv #scalp #交易結束 #獲利`;

const END_STALL = `⚖️ 快進快出｜交易結束 — 停滯換防 LQTY ▲ 做多
📝 結束原因：持有 20 分鐘仍在 ±0.3R 內原地踏步，判定動能已失效，主動平倉換防
📍 進場 $0.2037 → 出場 $0.2041
📊 損益：+0.14R ≈ +$0.84
⏰ 08/11 下午 10:16
#lqty #scalp #交易結束 #獲利`;

describe("快進快出 signal format", () => {
  it("reads the opening signal in full", () => {
    const s = parse(OPEN)!;
    expect(s.action).toBe("open");
    expect(s.symbol).toBe("ONDOUSDT");
    expect(s.side).toBe("short");
    expect(s.entryPrice).toBe(0.3381);
    expect(s.stopLoss).toBe(0.340354);
    expect(s.takeProfits).toEqual([0.334719, 0.333592]);
  });

  it("does not read the open's own stop-management text as a stop move", () => {
    // 「浮盈達 +0.6R 自動移到保本」describes what will happen later
    expect(parse(OPEN)!.action).toBe("open");
    expect(parse(OPEN)!.stopLossBreakeven).toBe(false);
  });

  it("takes the stated share each target closes", () => {
    expect(parse(OPEN)!.takeProfitPercents).toEqual([60, null]);
  });

  it("treats 觸及止盈一 as a stop move, NOT as a close", () => {
    // closing here would flatten the position and give up 止盈二
    const s = parse(TP1_HIT)!;
    expect(s.action).toBe("update_sl");
    expect(s.symbol).toBe("CRVUSDT");
    expect(s.stopLoss).toBe(0.265382);
    expect(s.stopLossBreakeven).toBe(false);
  });

  it("moves the stop to breakeven on 移到保本", () => {
    const s = parse(BREAKEVEN)!;
    expect(s.action).toBe("update_sl");
    expect(s.stopLossBreakeven).toBe(true);
  });

  it("closes on 交易結束, whatever the reason text mentions", () => {
    // this one's reason says 觸及止盈一 AND 止損已上移 - both stop-move wording
    expect(parse(END_TRAIL)!.action).toBe("close");
    expect(parse(END_TRAIL)!.symbol).toBe("CRVUSDT");
    expect(parse(END_STALL)!.action).toBe("close");
    expect(parse(END_STALL)!.symbol).toBe("LQTYUSDT");
  });
});

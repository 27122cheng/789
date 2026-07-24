/**
 * Signal parser: free-form Telegram text -> ParsedSignal.
 *
 * Tuned for the "加密掃描 Pro" style signal bot plus generic formats:
 *
 *   open      開倉:  「▲ 做多（Long）：ZEC/USDT … 進場： $533
 *                     止損： $526.133 (-1.29%) 止盈一： $543.301 …」
 *                     also generic "BTCUSDT LONG 10x Entry: 60000 SL: 59000"
 *             長線單 may carry 加倉計劃 levels:「加倉 1： $0.00110614」
 *   add       加倉:  「BTCUSDT 加倉」 (bare command w/o entry structure)
 *   close     平倉:  「BTCUSDT 平倉」/「close BTCUSDT」/「已止盈離場」
 *   cancel    取消:  「🚫 交易建議已取消 … ACH/USDT」
 *                    「⚡ 未進場已飛越止盈二！… 掛單已自動取消」
 *   update_sl 移動止損:「建議止損調整 … 新止損： $0.237906」
 *                    「BTCUSDT 止損移至保本」
 *   update_tp 修改止盈:「BTCUSDT 止盈改為 62000, 63000」
 *
 * Anything without a recognizable trading pair, or matching a configured
 * ignore keyword (news / data releases / ads), is dropped.
 */
import { ParsedSignal, SignalAction } from "./types";

const QUOTES = ["USDT", "USDC", "BUSD", "USD"] as const;

const LONG_KEYWORDS = [
  "long", "buy", "做多", "开多", "開多", "买多", "買多", "看多",
  "多单", "多單", "多",
];
const SHORT_KEYWORDS = [
  "short", "sell", "做空", "开空", "開空", "卖空", "賣空", "看空",
  "空单", "空單", "空",
];
const CLOSE_KEYWORDS = [
  "close position", "close", "exit", "平仓", "平倉", "全部平仓", "全部平倉",
  "平多", "平空", "离场", "離場", "出场", "出場",
];
const ADD_KEYWORDS = [
  "add position", "add to position", "dca", "加仓", "加倉", "补仓", "補倉",
];
const CANCEL_KEYWORDS = [
  "cancel order", "cancel orders", "cancel", "取消挂单", "取消掛單",
  "取消订单", "取消訂單", "撤单", "撤單", "取消",
  "飞越止盈", "飛越止盈",
];
const BREAKEVEN_KEYWORDS = [
  "breakeven", "break even", "保本", "成本价", "成本價",
  "开仓价", "開倉價",
];
// verbs that mark an SL/TP *modification* rather than a fresh signal
const MOVE_VERBS = [
  "移至", "移到", "移动", "移動", "上移", "下移", "挪到", "挪至",
  "调整", "調整", "调到", "調到", "改为", "改為", "改到", "改成",
  "更新", "move", "moved", "update", "updated", "raise", "lower", "set to",
  "adjust", "trail",
];
// 長線單升級信號: a short-term trade being upgraded to long-term -> update
// the existing position's SL/TP and attach the 加倉計劃 instead of opening anew
const UPGRADE_MARKERS = /長線單升級|长线单升级|升級信號|升级信号|升級為長線|升级为长线/;
// unmistakable "adjust the stop" phrasing used by signal bots
const SL_ADJUST_MARKERS =
  /新止損|新止损|建議止損調整|建议止损调整|追蹤止損|追踪止损|移動止損|移动止损/;
// messages reporting a finished trade (must not be read as a fresh open)
const CLOSED_MARKERS =
  /已平倉|已平仓|已止盈|已止損|已止损|止盈.{0,6}(?:觸及|触及|達成|达成)|(?:觸及|触及|達成|达成).{0,6}止盈|獲利了結|获利了结|獲利離場|获利离场/;

const NUM = /[\d][\d,]*(?:\.\d+)?/;

const SYMBOL_RE = new RegExp(
  `\\b([A-Za-z0-9]{2,15})[\\-/_]?(${QUOTES.join("|")})\\b`
);
const LABELED_SYMBOL_RE = new RegExp(
  `(?:幣種|币种|标的|標的|symbol|pair|coin)\\s*[:：]?\\s*[$#]?([A-Za-z0-9]{2,15})`,
  "i"
);

const FULLWIDTH: Record<string, string> = {
  "：": ":", "，": ",", "／": "/", "－": "-", "％": "%", "、": ",", "～": "~",
};
for (let i = 0; i < 10; i++) FULLWIDTH[String.fromCharCode(0xff10 + i)] = String(i);

function normalize(text: string): string {
  return text.replace(/[：，／－％、～０-９]/g, (c) => FULLWIDTH[c] ?? c);
}

function parseNum(raw: string): number {
  return parseFloat(raw.replace(/,/g, ""));
}

function findKeyword(keywords: string[], lower: string): number {
  let best = -1;
  for (const kw of keywords) {
    const idx = lower.indexOf(kw.toLowerCase());
    if (idx >= 0 && (best === -1 || idx < best)) best = idx;
  }
  return best;
}

export interface ParserOptions {
  ignoreKeywords?: string[];
  extraLongKeywords?: string[];
  extraShortKeywords?: string[];
}

export function extractSymbol(norm: string): string | null {
  const m = SYMBOL_RE.exec(norm);
  if (m) return `${m[1].toUpperCase()}${m[2].toUpperCase()}`;
  const lm = LABELED_SYMBOL_RE.exec(norm);
  if (lm) {
    const base = lm[1].toUpperCase();
    if ((QUOTES as readonly string[]).includes(base)) return null;
    for (const q of QUOTES) {
      if (base.endsWith(q) && base.length > q.length) return base;
    }
    return `${base}USDT`;
  }
  return null;
}

/** True when the message matches a configured noise keyword (news, data
 *  releases, ads ...) and must be dropped even if it mentions a symbol. */
export function isFiltered(text: string, ignoreKeywords: string[]): boolean {
  const lower = text.toLowerCase();
  return ignoreKeywords.some(
    (kw) => kw.trim() && lower.includes(kw.trim().toLowerCase())
  );
}

function extractSide(
  lower: string,
  extraLong: string[],
  extraShort: string[]
): "long" | "short" | null {
  const longIdx = findKeyword([...LONG_KEYWORDS, ...extraLong], lower);
  const shortIdx = findKeyword([...SHORT_KEYWORDS, ...extraShort], lower);
  if (longIdx >= 0 && shortIdx >= 0)
    return longIdx <= shortIdx ? "long" : "short";
  if (longIdx >= 0) return "long";
  if (shortIdx >= 0) return "short";
  return null;
}

function extractLeverage(norm: string): number | null {
  let m = /(\d{1,3})\s*[xX倍]/.exec(norm);
  if (m) return parseInt(m[1], 10);
  m = /(?:杠杆|槓桿|leverage)\s*[:：]?\s*(\d{1,3})/i.exec(norm);
  if (m) return parseInt(m[1], 10);
  return null;
}

function extractEntry(norm: string): { low: number | null; high: number | null } {
  const re = new RegExp(
    `(?:entry|入场价|入場價|入场|入場|进场|進場|开仓价|開倉價|开仓|開倉)` +
      `\\s*[:：]?\\s*\\$?(${NUM.source})(?:\\s*(?:-|~|至|to)\\s*\\$?(${NUM.source}))?`,
    "i"
  );
  const m = re.exec(norm);
  if (!m) return { low: null, high: null };
  return { low: parseNum(m[1]), high: m[2] ? parseNum(m[2]) : null };
}

function extractTakeProfits(norm: string): number[] {
  const values: number[] = [];
  // numbered / named single-value labels: 止盈一 / 止盈2 / 最終止盈 / TP1
  const single = new RegExp(
    `(?:最終止盈|最终止盈|止盈[一二三四五六七八九\\d]|tp\\s*\\d|take\\s*profit\\s*\\d)` +
      `\\s*[:：]?\\s*\\$?(${NUM.source})`,
    "gi"
  );
  let m: RegExpExecArray | null;
  while ((m = single.exec(norm)) !== null) {
    const v = parseNum(m[1]);
    if (!values.includes(v)) values.push(v);
  }
  if (values.length) return values;

  // bare label followed by one or more values: 止盈: 3300, 3400
  const multi =
    /(?:tp|take\s*profit|止盈|目标价|目標價|目标|目標)\s*(?:改为|改為|改到|改成|移至|移到|調整至|调整至|更新为|更新為)?\s*[:：]?\s*\$?([\d.,~\-\s]+?)(?=$|\n|[a-zA-Z一-鿿(（])/gim;
  while ((m = multi.exec(norm)) !== null) {
    for (const token of m[1].trim().split(/[,~\-\s]+/)) {
      if (!token) continue;
      const v = parseFloat(token);
      if (!isNaN(v) && !values.includes(v)) values.push(v);
    }
  }
  return values;
}

function extractStopLoss(norm: string, allowLoose: boolean): number | null {
  // explicit "new stop" label wins: 新止損： $0.237906
  let m = new RegExp(
    `(?:新止損|新止损)\\s*[:：]?\\s*\\$?(${NUM.source})`,
    "i"
  ).exec(norm);
  if (m) return parseNum(m[1]);
  // strict: number right after the label ("SL: 59000" / "止損： $526.133")
  m = new RegExp(
    `(?:\\bsl\\b|stop\\s*loss|止损|止損)\\s*[:：]?\\s*\\$?(${NUM.source})`,
    "i"
  ).exec(norm);
  if (m) return parseNum(m[1]);
  if (allowLoose) {
    // update-style: "止損移至 60000" - a verb sits between label and number
    m = new RegExp(
      `(?:\\bsl\\b|stop\\s*loss|止损|止損)[^\\d\\n]{0,16}\\$?(${NUM.source})`,
      "i"
    ).exec(norm);
    if (m) return parseNum(m[1]);
  }
  return null;
}

function extractSize(norm: string): number | null {
  const m = new RegExp(
    `(?:仓位|倉位|金额|金額|size|amount)?\\s*[:：]?\\s*(${NUM.source})\\s*(?:usdt|u\\b)`,
    "i"
  ).exec(norm);
  if (m) return parseNum(m[1]);
  return null;
}

/** 加倉計劃 price levels:「加倉 1： $0.00110614」/「加仓2: 0.00103314」.
 *  The numeric index + colon are required so a bare "加倉" command or a
 *  "加倉計劃（2 次）" heading never produces a bogus level. */
function extractAddLevels(norm: string): number[] {
  const out: number[] = [];
  const re = new RegExp(`加[倉仓]\\s*\\d\\s*[:：]\\s*\\$?(${NUM.source})`, "g");
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    const v = parseNum(m[1]);
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

export function parseSignal(
  text: string,
  meta: { chatId: string; messageId: number; timestamp: number },
  options: ParserOptions = {}
): ParsedSignal | null {
  if (!text || !text.trim()) return null;

  const norm = normalize(text);
  const lower = norm.toLowerCase();

  const symbol = extractSymbol(norm);
  if (!symbol) return null; // not a trade signal (chatter / news without pair)

  const entry = extractEntry(norm);
  const takeProfits = extractTakeProfits(norm);
  const strictSl = extractStopLoss(norm, false);
  const warnings: string[] = [];

  // ------------------------------------------------ action classification
  let action: SignalAction;
  let breakeven = false;
  const mentionsSl = /止损|止損|\bsl\b|stop\s*loss/i.test(norm);
  const mentionsTp = /止盈|\btp\d*\b|take\s*profit|目标价|目標價/i.test(norm);
  const hasMoveVerb = findKeyword(MOVE_VERBS, lower) >= 0;

  const side = extractSide(
    lower,
    options.extraLongKeywords ?? [],
    options.extraShortKeywords ?? []
  );
  const hasEntry = entry.low !== null;
  const hasSl = strictSl !== null;
  const hasTp = takeProfits.length > 0;
  const hasPriceStructure = hasEntry || hasSl || hasTp;
  // explicit "this is an entry setup" wording used by signal bots
  const entrySetupMarker =
    /短線單|短线单|長線單|长线单|信號|信号|建單|建单|開倉|开仓|進場|进场|entry|做多|做空|\blong\b|\bshort\b/i.test(
      norm
    );

  if (findKeyword(CANCEL_KEYWORDS, lower) >= 0) {
    action = "cancel";
  } else if (SL_ADJUST_MARKERS.test(norm)) {
    action = "update_sl";
  } else if (CLOSED_MARKERS.test(norm)) {
    action = "close";
  } else if (hasEntry && (hasSl || hasTp)) {
    // full signal structure (entry + SL/TP) -> a fresh open, even if the
    // message also mentions 加倉計劃 levels or trailing-stop advice text
    action = "open";
  } else if (findKeyword(ADD_KEYWORDS, lower) >= 0) {
    action = "add";
  } else if (hasMoveVerb && mentionsSl) {
    action = "update_sl";
  } else if (hasMoveVerb && mentionsTp) {
    action = "update_tp";
  } else if (findKeyword(CLOSE_KEYWORDS, lower) >= 0) {
    action = "close";
  } else if (side && hasPriceStructure && entrySetupMarker) {
    // directional + at least one price level + entry wording -> a terse open
    action = "open";
    if (!hasEntry) warnings.push("open signal without an explicit entry price");
  } else {
    // A symbol with no action keyword, no price structure, and no clear
    // entry setup is analysis/commentary/prediction - NOT a tradable signal.
    // Returning null keeps the dashboard's signal log clean and stops noise
    // from being logged as rejected opens.
    return null;
  }

  if (action === "update_sl") {
    breakeven = findKeyword(BREAKEVEN_KEYWORDS, lower) >= 0;
  }
  if (action === "open" && !side) {
    warnings.push("open signal without long/short side");
  }

  const stopLoss =
    action === "update_sl" ? extractStopLoss(norm, true) : strictSl;

  return {
    action,
    symbol,
    side,
    leverage: extractLeverage(norm),
    entryPrice: entry.low,
    entryPriceHigh: entry.high,
    takeProfits,
    stopLoss,
    stopLossBreakeven: breakeven,
    sizeUsdt: extractSize(norm),
    addLevels: action === "open" ? extractAddLevels(norm) : [],
    upgrade: action === "open" && UPGRADE_MARKERS.test(norm),
    rawText: text,
    chatId: meta.chatId,
    messageId: meta.messageId,
    timestamp: meta.timestamp,
    warnings,
  };
}

export function dedupKey(signal: ParsedSignal): string {
  // Dedup by chat + message id ONLY (no content hash): a message that gets
  // edited (view counts, links, status) or re-delivered on reconnect/catch-up
  // must NOT be treated as a new signal, or one signal becomes several trades.
  return `${signal.chatId}:${signal.messageId}`;
}

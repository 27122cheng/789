/**
 * Signal parser: free-form Telegram text -> ParsedSignal.
 *
 * Supported actions:
 *   open      建單/開倉:  "BTCUSDT LONG 10x Entry: 60000 TP1: 61000 SL: 59000"
 *   add       加倉:       "BTCUSDT 加倉" / "ETHUSDT add position 50 USDT"
 *   close     平倉:       "BTCUSDT 平倉" / "close BTCUSDT"
 *   cancel    取消掛單:   "取消 BTCUSDT 掛單" / "cancel BTCUSDT orders"
 *   update_sl 移動止損:   "BTCUSDT 止損移至 60000" / "BTCUSDT 止損移至保本"
 *   update_tp 修改止盈:   "BTCUSDT 止盈改為 62000 63000"
 *
 * Anything without a recognizable trading pair, or matching one of the
 * configured ignore keywords (news / data releases / ads), returns null.
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
  "平多", "平空", "离场", "離場", "出场", "出場", "止盈离场", "止盈離場",
];
const ADD_KEYWORDS = [
  "add position", "add to position", "dca", "加仓", "加倉", "补仓", "補倉",
];
const CANCEL_KEYWORDS = [
  "cancel order", "cancel orders", "cancel", "取消挂单", "取消掛單",
  "取消订单", "取消訂單", "撤单", "撤單", "取消",
];
const BREAKEVEN_KEYWORDS = [
  "breakeven", "break even", "保本", "成本价", "成本價", "入场价", "入場價",
  "开仓价", "開倉價",
];
// verbs that mark an SL/TP *modification* rather than a fresh signal
const MOVE_VERBS = [
  "移至", "移到", "移动", "移動", "上移", "下移", "挪到", "挪至",
  "调整", "調整", "调到", "調到", "改为", "改為", "改到", "改成",
  "更新", "move", "moved", "update", "updated", "raise", "lower", "set to",
  "adjust", "trail",
];

const NUM = /[\d][\d,]*(?:\.\d+)?/;
const NUM_G = new RegExp(NUM.source, "g");

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
      if (base.endsWith(q) && base.length > q.length)
        return base; // already includes quote
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

function classifyAction(lower: string): {
  action: SignalAction | null;
  breakeven: boolean;
} {
  if (findKeyword(CANCEL_KEYWORDS, lower) >= 0)
    return { action: "cancel", breakeven: false };
  if (findKeyword(ADD_KEYWORDS, lower) >= 0)
    return { action: "add", breakeven: false };

  const mentionsSl = /止损|止損|\bsl\b|stop\s*loss/i.test(lower);
  const mentionsTp = /止盈|\btp\d*\b|take\s*profit|目标价|目標價/i.test(lower);
  const hasMoveVerb = findKeyword(MOVE_VERBS, lower) >= 0;
  if (hasMoveVerb && mentionsSl) {
    const breakeven = findKeyword(BREAKEVEN_KEYWORDS, lower) >= 0;
    return { action: "update_sl", breakeven };
  }
  if (hasMoveVerb && mentionsTp) return { action: "update_tp", breakeven: false };

  if (findKeyword(CLOSE_KEYWORDS, lower) >= 0)
    return { action: "close", breakeven: false };

  return { action: "open", breakeven: false };
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
      `\\s*[:：]?\\s*(${NUM.source})(?:\\s*(?:-|~|至|to)\\s*(${NUM.source}))?`,
    "i"
  );
  const m = re.exec(norm);
  if (!m) return { low: null, high: null };
  return { low: parseNum(m[1]), high: m[2] ? parseNum(m[2]) : null };
}

function extractTakeProfits(norm: string): number[] {
  const values: number[] = [];
  const re =
    /(?:tp\d*|take\s*profit\d*|止盈\d*|目标价\d*|目標價\d*|目标\d*|目標\d*)\s*(?:改为|改為|改到|改成|移至|移到|调整至|調整至|更新为|更新為)?\s*[:：]?\s*([\d.,~\-\s]+?)(?=$|\n|[a-zA-Z一-鿿])/gim;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    for (const token of m[1].trim().split(/[,、~\-\s]+/)) {
      if (!token) continue;
      const v = parseFloat(token);
      if (!isNaN(v) && !values.includes(v)) values.push(v);
    }
  }
  return values;
}

function extractStopLoss(norm: string, allowLoose: boolean): number | null {
  // strict: number immediately after the label ("SL: 59000" / "止損 59000")
  let m = new RegExp(
    `(?:\\bsl\\b|stop\\s*loss|止损|止損)\\s*[:：]?\\s*(${NUM.source})`,
    "i"
  ).exec(norm);
  if (m) return parseNum(m[1]);
  if (allowLoose) {
    // update-style: "止損移至 60000" - a move verb sits between label & number
    m = new RegExp(
      `(?:\\bsl\\b|stop\\s*loss|止损|止損)[^\\d\\n]{0,16}(${NUM.source})`,
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

export function parseSignal(
  text: string,
  meta: { chatId: string; messageId: number; timestamp: number },
  options: ParserOptions = {}
): ParsedSignal | null {
  if (!text || !text.trim()) return null;

  const norm = normalize(text);
  const lower = norm.toLowerCase();

  const symbol = extractSymbol(norm);
  if (!symbol) return null; // not a trade signal (chatter, news without pair)

  const { action, breakeven } = classifyAction(lower);
  if (!action) return null;

  const warnings: string[] = [];
  let side: "long" | "short" | null = null;
  if (action === "open" || action === "add") {
    side = extractSide(
      lower,
      options.extraLongKeywords ?? [],
      options.extraShortKeywords ?? []
    );
    if (action === "open" && !side) {
      warnings.push("open signal without long/short side");
    }
  }

  const entry = extractEntry(norm);
  const isUpdate = action === "update_sl" || action === "update_tp";

  return {
    action,
    symbol,
    side,
    leverage: extractLeverage(norm),
    entryPrice: entry.low,
    entryPriceHigh: entry.high,
    takeProfits: extractTakeProfits(norm),
    stopLoss: extractStopLoss(norm, isUpdate),
    stopLossBreakeven: breakeven,
    sizeUsdt: extractSize(norm),
    rawText: text,
    chatId: meta.chatId,
    messageId: meta.messageId,
    timestamp: meta.timestamp,
    warnings,
  };
}

export function dedupKey(signal: ParsedSignal): string {
  // include a content digest so edited messages count as new signals
  let hash = 0;
  for (let i = 0; i < signal.rawText.length; i++) {
    hash = (hash * 31 + signal.rawText.charCodeAt(i)) | 0;
  }
  return `${signal.chatId}:${signal.messageId}:${hash >>> 0}`;
}

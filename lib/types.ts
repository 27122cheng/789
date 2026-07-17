export type SignalAction =
  | "open"       // 建單 / 開倉
  | "add"        // 加倉
  | "close"      // 平倉
  | "cancel"     // 取消掛單
  | "update_sl"  // 移動/修改止損
  | "update_tp"; // 修改止盈

export interface ParsedSignal {
  action: SignalAction;
  symbol: string;               // normalized, e.g. "BTCUSDT"
  side: "long" | "short" | null;
  leverage: number | null;
  entryPrice: number | null;
  entryPriceHigh: number | null;
  takeProfits: number[];
  stopLoss: number | null;
  stopLossBreakeven: boolean;   // "移至保本/成本" style update_sl
  sizeUsdt: number | null;
  addLevels: number[];          // 加倉計劃 price levels from long-term signals
  upgrade: boolean;             // 長線單升級信號: update existing position instead of rejecting
  rawText: string;
  chatId: string;
  messageId: number;
  editedFromId?: number;
  timestamp: number;            // unix ms
  warnings: string[];
}

/** One 加倉計劃 level with its pullback state machine:
 *  price beyond the level for >= armSeconds arms it (virtual limit order);
 *  the add then fills when price pulls back (回踩) to the level. */
export interface PendingAdd {
  level: number;
  armedAt: number | null;  // when price was first seen beyond the level
  armed: boolean;          // stayed beyond long enough -> waiting for pullback
}

export interface Position {
  symbol: string;
  side: "long" | "short";
  leverage: number;
  entryPrice: number;          // average entry
  qty: number;                 // base asset quantity
  originalQty: number;
  sizeUsdt: number;
  stopLoss: number | null;
  takeProfits: number[];       // remaining TP targets
  tpCountOriginal: number;
  pendingAdds: PendingAdd[];   // 加倉計劃 levels not yet filled
  entryOrderType: "market" | "limit";
  beMoved: boolean;            // SL already moved to breakeven after TP1
  orderIds: string[];          // pending entry order ids (limit entries)
  openedAt: number;
  addCount: number;
  dryRun: boolean;
}

export interface OrderRecord {
  at: number;
  action: SignalAction | "tp_hit" | "sl_hit" | "trailing_move" | "upgrade";
  symbol: string;
  side: string | null;
  sizeUsdt: number;
  qty: number;
  price: number | null;
  leverage: number;
  dryRun: boolean;
  success: boolean;
  message: string;
  orderIds: string[];
}

export interface SignalRecord {
  at: number;
  chatId: string;
  messageId: number;
  action: SignalAction | "ignored" | "filtered";
  symbol: string | null;
  side: string | null;
  summary: string;
  rawText: string;
}

/** Raw diagnostic record of a single update hitting the webhook, logged
 *  regardless of whether it was accepted, so the dashboard can explain why
 *  nothing is being detected. */
export interface WebhookEvent {
  at: number;
  updateType: string;         // "message" | "channel_post" | "edited_message" | ...
  chatId: string | null;
  chatTitle: string | null;
  chatType: string | null;    // "private" | "group" | "supergroup" | "channel"
  chatUsername: string | null;
  fromBot: boolean;           // sender is a bot -> normally undeliverable to us
  outcome: "accepted" | "chat_not_allowed" | "empty_text" | "unsupported" | "error";
  detail: string;
  textPreview: string;
}

export interface Settings {
  telegram: {
    botToken: string;
    // chat usernames (without @) or numeric chat ids; empty = reject all
    allowedChats: string[];
    webhookSecret: string;
    reactToEdits: boolean;
  };
  pionex: {
    apiKey: string;
    apiSecret: string;
    baseUrl: string;
  };
  trading: {
    liveTrading: boolean;
    sizing: {
      mode: "fixed_usdt" | "percent_balance" | "signal";
      fixedUsdt: number;
      percentBalance: number;
    };
    addPositionUsdt: number; // 加倉每次的名目 USDT，0 = 與主要 sizing 相同
    // 加倉位掛單前，價格需越過該價位持續的秒數（之後回踩到位才成交）
    addArmSeconds: number;
    leverage: { default: number; max: number };
    risk: {
      symbolWhitelist: string[];
      symbolBlacklist: string[];
      maxOpenPositions: number;
      maxAddsPerPosition: number;
      cooldownSeconds: number;
      maxSignalAgeSeconds: number;
      // reject open signals that carry no entry price or no stop loss
      // (protects against analysis chatter being misread as a signal)
      requireEntryAndSl: boolean;
    };
    orders: {
      entryType: "market" | "limit";
      attachStopLoss: boolean;
      attachTakeProfit: boolean;
    };
    trailing: {
      enabled: boolean;
      activateProfitPercent: number; // 價格獲利 % 達標後啟動
      callbackPercent: number;       // 回撤 % 觸發（SL 跟在最新價後面這個距離）
      // 觸及止盈一後把止損移到進場價附近（多單移到進場價下方一點點，
      // 空單鏡像移到上方），offset 為距離進場價的百分比
      moveToBreakevenOnTp1: boolean;
      breakevenOffsetPercent: number;
    };
  };
  filters: {
    // 訊息包含任一關鍵字即忽略（過濾數據公布、新聞等）
    ignoreKeywords: string[];
    extraLongKeywords: string[];
    extraShortKeywords: string[];
  };
}

export const DEFAULT_SETTINGS: Settings = {
  telegram: {
    botToken: "",
    allowedChats: [],
    webhookSecret: "",
    reactToEdits: true,
  },
  pionex: {
    apiKey: "",
    apiSecret: "",
    baseUrl: "https://api.pionex.com",
  },
  trading: {
    liveTrading: false,
    sizing: { mode: "fixed_usdt", fixedUsdt: 100, percentBalance: 5 },
    addPositionUsdt: 0,
    addArmSeconds: 60,
    leverage: { default: 10, max: 20 },
    risk: {
      symbolWhitelist: [],
      symbolBlacklist: [],
      maxOpenPositions: 5,
      maxAddsPerPosition: 3,
      cooldownSeconds: 30,
      maxSignalAgeSeconds: 120,
      requireEntryAndSl: true,
    },
    orders: {
      entryType: "market",
      attachStopLoss: true,
      attachTakeProfit: true,
    },
    trailing: {
      enabled: false,
      activateProfitPercent: 2,
      callbackPercent: 1,
      moveToBreakevenOnTp1: true,
      breakevenOffsetPercent: 0.2,
    },
  },
  filters: {
    ignoreKeywords: [
      "数据公布", "數據公布", "经济数据", "經濟數據", "非农", "非農",
      "CPI", "PPI", "FOMC", "利率决议", "利率決議",
      "新闻", "新聞", "快讯", "快訊", "空投", "airdrop",
      "广告", "廣告", "推广", "推廣", "注册链接", "註冊連結",
    ],
    extraLongKeywords: [],
    extraShortKeywords: [],
  },
};

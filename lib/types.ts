export type SignalAction =
  | "open"       // 建單 / 開倉
  | "add"        // 加倉確認｜請掛單 -> rest the tranche order
  | "add_plan"   // 加倉訊號 -> announced only; the breakout is NOT confirmed yet
  | "add_cancel" // 加倉掛單失效 -> pull the resting tranche order, keep the position
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
  // 「成交後止損改至 X」on an add: applies only when that tranche FILLS, never
  // before - arming it early could close the position at a level that was not
  // meant to be live yet.
  stopLossAfterFill: number | null;
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
  // A 加倉確認 signal has already confirmed the breakout and asks for a limit
  // order at `level`, so instead of arming a virtual order we rest a REAL one
  // on the exchange and fill the add when it leaves the order book.
  orderId?: string | null;
  qty?: number;            // base quantity submitted with that order
  sizeUsdt?: number;       // notional it represents
  stopLoss?: number | null; // the stop this order was placed with
  // the stop the whole position moves to once this tranche fills
  stopLossAfterFill?: number | null;
  // true when that stop/target rode along on the order itself, so the tranche
  // is already protected and must not be flattened into the main position's
  // levels when it fills
  attached?: boolean;
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
  initialRisk: number | null;  // |entry - stopLoss| at open, for R-multiples
  rTargets: { r: number; closePercent: number; done: boolean }[];
  // While set, the position hasn't been filled yet. Two ways of waiting:
  //   "limit_order" - a REAL limit order rests on Pionex at `target` (orderId
  //     set); it fills at exactly that price, even between monitor polls.
  //   "watch" - no exchange order (dry-run, or Pionex rejected the limit);
  //     the monitor market-enters when price touches `target` (到價進場).
  pendingEntry: {
    target: number;
    dir: "up" | "down";
    mode: "limit_order" | "watch";
    orderId: string | null;
    qty: number;              // size submitted / to submit
  } | null;
  orderIds: string[];          // pending entry order ids (limit entries)
  openedAt: number;
  addCount: number;
  dryRun: boolean;
}

export interface OrderRecord {
  at: number;
  action:
    | SignalAction
    | "tp_hit"
    | "sl_hit"
    | "trailing_move"
    | "upgrade"
    | "stops_synced";   // protective TP/SL (re)placed on the exchange
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
  /** Which venue orders are sent to. Pionex gates perpetual-futures API
   *  trading behind a whitelist (TRADE_TYPE_DENIED for normal accounts);
   *  OKX's swap API is open to regular accounts. */
  exchange: "pionex" | "okx";
  okx: {
    apiKey: string;
    apiSecret: string;
    passphrase: string;        // OKX requires a 3rd credential
    baseUrl: string;
    tdMode: "cross" | "isolated";
    demo: boolean;             // demo (paper) trading endpoint
  };
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
    // How a normalized symbol like "BTCUSDT" maps to Pionex's contract symbol.
    // {base}=BTC, {quote}=USDT. Adjust to match what Pionex actually accepts
    // (discover the real format via the Pionex 探測 tool on the 其他 page).
    // Examples: "{base}_{quote}_PERP", "{base}_{quote}", "{base}{quote}"
    symbolFormat: string;
  };
  trading: {
    liveTrading: boolean;
    sizing: {
      mode: "fixed_usdt" | "percent_balance" | "signal";
      fixedUsdt: number;
      percentBalance: number;
      // What the amount above MEANS:
      //   "margin"   - it is the money committed; the position is
      //                amount x leverage (10 USDT at 20x -> 200 USDT position)
      //   "notional" - it is the position value itself, and leverage only
      //                changes how much margin that ties up
      basis: "margin" | "notional";
    };
    addPositionUsdt: number; // 加倉每次的名目 USDT，0 = 與主要 sizing 相同
    // 加倉位掛單前，價格需越過該價位持續的秒數（之後回踩到位才成交）
    addArmSeconds: number;
    // Whether to judge add timing OURSELVES from the 加倉計劃 levels carried by a
    // 長線單 upgrade signal (watch the level, arm it after addArmSeconds, fill on
    // the pullback). Leave off when the signal provider confirms the breakout
    // itself and sends an explicit 加倉確認｜請掛單 message - otherwise both act
    // on the same level and the position is added to twice.
    autoArmAddLevels: boolean;
    leverage: {
      default: number;
      max: number;
      // Which leverage to use when the signal itself doesn't state one:
      //   "default" - use the default above
      //   "max"     - use the maximum
      whenUnspecified: "default" | "max";
    };
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
      // What to do when the configured position size is below the venue's
      // minimum order size (e.g. 3 USDT on BTC-USDT-SWAP, whose smallest
      // order is 0.01 contracts ≈ 6.4 USDT):
      //   "lift" - raise the order to the minimum (trades, but risks more)
      //   "skip" - drop the signal (never exceeds the configured size)
      belowMinSize: "lift" | "skip";
      // Rest the stop-loss / first take-profit on the EXCHANGE as well, so a
      // position stays protected if this app, Vercel or the cron stops. The
      // monitor still runs and handles the parts an exchange stop cannot
      // express (split TPs, R-multiples, trailing).
      exchangeStops: boolean;
      entryType: "market" | "limit";
      attachStopLoss: boolean;
      attachTakeProfit: boolean;
      // 分批止盈: close an equal share of the position at each TP target
      // (last target closes the remainder). Off = close all at the first TP.
      splitTakeProfit: boolean;
      // R-multiple scale-out: R = |entry - stopLoss| (the trade's risk). When
      // profit reaches `r`×R, close `closePercent`% of the ORIGINAL position.
      // Works off entry+stop, independent of the signal's own TP prices.
      rTakeProfit: {
        enabled: boolean;
        levels: { r: number; closePercent: number }[];
      };
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
  exchange: "okx",
  okx: {
    apiKey: "",
    apiSecret: "",
    passphrase: "",
    baseUrl: "https://www.okx.com",
    tdMode: "cross",
    demo: false,
  },
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
    // Pionex perp futures TRADE symbol = base_quote_PERP on the /uapi/v1
    // endpoints (positionSide=BOTH one-way mode).
    symbolFormat: "{base}_{quote}_PERP",
  },
  trading: {
    liveTrading: false,
    sizing: {
      mode: "fixed_usdt",
      fixedUsdt: 100,
      percentBalance: 5,
      basis: "margin",
    },
    addPositionUsdt: 0,
    addArmSeconds: 60,
    autoArmAddLevels: false,
    leverage: { default: 10, max: 20, whenUnspecified: "max" },
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
      belowMinSize: "lift",
      exchangeStops: true,
      entryType: "market",
      attachStopLoss: true,
      attachTakeProfit: true,
      splitTakeProfit: true,
      rTakeProfit: {
        enabled: false,
        levels: [{ r: 1, closePercent: 50 }],
      },
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

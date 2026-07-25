/**
 * The exchange-independent surface the executor talks to.
 *
 * Everything above this line (signal parsing, sizing, adds, R-multiple
 * scale-out, trailing stops, the monitor loop) is exchange-agnostic and works
 * in BASE-ASSET quantities (e.g. 0.05 BTC). Each client is responsible for
 * translating that into whatever its venue actually wants - notably OKX, whose
 * perpetual orders are denominated in CONTRACTS rather than coins.
 */

/** Trading rules for one symbol, always expressed in BASE-ASSET units. */
export interface OrderFilters {
  baseDecimals: number | null;   // qty decimal places
  quoteDecimals: number | null;  // price decimal places
  minSizeLimit: number | null;   // min order size, limit orders
  minSizeMarket: number | null;  // min order size, market orders
  minNotional: number | null;    // min order value in quote currency
}

export interface PlacedOrder {
  orderId: string | null;
  raw: Record<string, any>;
}

export interface PlaceOrderOpts {
  symbol: string;                 // venue symbol, from perpSymbol()
  side: "BUY" | "SELL";
  type: "MARKET" | "LIMIT";
  size?: string;                  // BASE-ASSET quantity
  price?: string;                 // LIMIT only
  reduceOnly?: boolean;
  clientOrderId?: string;
  /** Protective levels attached to THIS order, so they exist from the moment
   *  it fills without depending on anything else running. */
  attach?: { stopLoss?: number | null; takeProfit?: number | null };
}

/** Thrown when the venue rejected the ATTACHED protective levels specifically,
 *  meaning the order itself was never created and can be retried bare. */
export class AttachRejectedError extends Error {}

export interface ExchangeClient {
  /** Normalized symbol ("BTCUSDT") -> the venue's perp symbol. */
  perpSymbol(symbol: string): string;
  /** Last traded price for a venue symbol. */
  getPrice(venueSymbol: string): Promise<number>;
  /** High/low since `sinceMs` from 1-minute candles; null if unavailable. */
  priceRange(venueSymbol: string, sinceMs: number): Promise<{ high: number; low: number } | null>;
  /** Price decimal places for a normalized symbol. */
  pricePrecision(symbol: string): Promise<number | null>;
  /** Size/price/minimum rules for a normalized symbol, in base units. */
  orderFilters(symbol: string): Promise<OrderFilters>;
  getAvailableUsdt(): Promise<number>;
  getOpenOrders(venueSymbol: string): Promise<any[]>;
  placeOrder(opts: PlaceOrderOpts): Promise<PlacedOrder>;
  cancelOrder(venueSymbol: string, orderId: string): Promise<unknown>;
  cancelAllOrders(venueSymbol: string): Promise<number>;
  /** Venues where leverage is set per instrument rather than per order. */
  setLeverage?(venueSymbol: string, leverage: number): Promise<void>;
  /** Human description of how a base quantity maps to the venue's own order
   *  unit (OKX sells contracts, not coins), for the sizing preview. */
  describeOrderSize?(symbol: string, baseQty: number): Promise<string | null>;

  /** Rest protective stop-loss / take-profit orders ON THE EXCHANGE, so the
   *  position stays protected even if this app stops running. Venues without
   *  support simply omit these and rely on the monitor. */
  placeStopOrders?(opts: {
    symbol: string;                  // venue symbol
    side: "BUY" | "SELL";            // the CLOSING side
    size: string;                    // base-asset quantity the stop protects
    stopLoss?: number | null;
    // one entry per take-profit target, each with the slice it closes
    takeProfits?: { price: number; size: string }[];
  }): Promise<string[]>;
  cancelStopOrders?(venueSymbol: string): Promise<number>;
  /** How many protective orders currently rest on the exchange, so the monitor
   *  can notice an unprotected position and place them. */
  countStopOrders?(venueSymbol: string): Promise<number>;

  /** The positions the exchange actually holds. The exchange is the source of
   *  truth: an order can fill while this app is not running, so the tracker
   *  must be able to reconcile against reality rather than only against the
   *  events it happened to observe. Quantities are in base-asset units. */
  fetchPositions?(): Promise<
    { symbol: string; side: "long" | "short"; qty: number; entryPrice: number }[]
  >;
}

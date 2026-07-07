"""Plain data containers shared across the pipeline: a parsed Telegram
signal, and the result of trying to execute one on Pionex.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import List, Optional


@dataclass
class TradeSignal:
    raw_text: str
    action: str  # "open" | "close"
    symbol: Optional[str] = None          # normalized, e.g. "BTCUSDT"
    side: Optional[str] = None            # "long" | "short" (only for action == "open")
    leverage: Optional[int] = None
    entry_price: Optional[float] = None       # single entry, or low end of a range
    entry_price_high: Optional[float] = None  # high end of a range, if any
    take_profits: List[float] = field(default_factory=list)
    stop_loss: Optional[float] = None
    size_usdt: Optional[float] = None     # explicit notional from the signal, if any
    chat_id: Optional[int] = None
    message_id: Optional[int] = None
    timestamp: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    warnings: List[str] = field(default_factory=list)

    @property
    def is_actionable(self) -> bool:
        if not self.symbol:
            return False
        if self.action == "open":
            return self.side is not None
        if self.action == "close":
            return True
        return False

    @property
    def dedup_key(self) -> str:
        # The text digest lets an *edited* message (same chat/message id,
        # new content) be treated as a fresh signal instead of a duplicate.
        digest = hashlib.md5(self.raw_text.encode("utf-8")).hexdigest()[:12]
        return f"{self.chat_id}:{self.message_id}:{digest}"


@dataclass
class OrderPlan:
    """What we intend to send to Pionex, after sizing/risk checks."""
    symbol: str
    side: str              # "long" | "short"
    action: str            # "open" | "close"
    leverage: int
    size_usdt: float
    order_type: str         # "market" | "limit"
    limit_price: Optional[float] = None
    stop_loss: Optional[float] = None
    take_profits: List[float] = field(default_factory=list)


@dataclass
class RiskCheckResult:
    allowed: bool
    reasons: List[str] = field(default_factory=list)


@dataclass
class OrderResult:
    success: bool
    dry_run: bool
    plan: OrderPlan
    message: str = ""
    raw_response: Optional[dict] = None
    order_ids: List[str] = field(default_factory=list)

"""Gatekeeper that every open-signal must pass before an order is sent.

State it needs (current open positions, today's realized PnL, last order time
per symbol) is supplied by the caller via a RiskContext snapshot, so this
module stays free of I/O and is trivially testable.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Dict, List, Optional

from src.config import RiskConfig
from src.models import RiskCheckResult, TradeSignal


@dataclass
class RiskContext:
    open_positions_total: int = 0
    open_positions_by_symbol: Dict[str, int] = field(default_factory=dict)
    realized_pnl_today_usdt: float = 0.0  # negative when losing
    last_order_time_by_symbol: Dict[str, datetime] = field(default_factory=dict)
    now: Optional[datetime] = None


class RiskManager:
    def __init__(self, cfg: RiskConfig):
        self.cfg = cfg

    def check_open(self, signal: TradeSignal, ctx: RiskContext) -> RiskCheckResult:
        reasons: List[str] = []
        now = ctx.now or datetime.now(timezone.utc)
        symbol = (signal.symbol or "").upper()

        if not signal.is_actionable:
            reasons.append("signal is not actionable (missing symbol or side)")

        wl = [s.upper() for s in self.cfg.symbol_whitelist]
        bl = [s.upper() for s in self.cfg.symbol_blacklist]
        if wl and symbol not in wl:
            reasons.append(f"{symbol} not in symbol whitelist")
        if symbol in bl:
            reasons.append(f"{symbol} is blacklisted")

        if ctx.open_positions_total >= self.cfg.max_open_positions:
            reasons.append(
                f"max_open_positions reached ({ctx.open_positions_total}/{self.cfg.max_open_positions})"
            )

        per_symbol = ctx.open_positions_by_symbol.get(symbol, 0)
        if per_symbol >= self.cfg.max_positions_per_symbol:
            reasons.append(
                f"max_positions_per_symbol reached for {symbol} "
                f"({per_symbol}/{self.cfg.max_positions_per_symbol})"
            )

        if -ctx.realized_pnl_today_usdt >= self.cfg.max_daily_loss_usdt:
            reasons.append(
                f"daily loss limit hit ({ctx.realized_pnl_today_usdt:.2f} USDT today, "
                f"limit {self.cfg.max_daily_loss_usdt})"
            )

        last = ctx.last_order_time_by_symbol.get(symbol)
        if last is not None:
            elapsed = (now - last).total_seconds()
            if elapsed < self.cfg.min_seconds_between_same_symbol:
                reasons.append(
                    f"only {elapsed:.0f}s since last {symbol} order "
                    f"(min {self.cfg.min_seconds_between_same_symbol}s)"
                )

        if signal.timestamp is not None:
            sig_ts = signal.timestamp
            if sig_ts.tzinfo is None:
                sig_ts = sig_ts.replace(tzinfo=timezone.utc)
            age = (now - sig_ts).total_seconds()
            if age > self.cfg.max_signal_age_seconds:
                reasons.append(
                    f"signal is {age:.0f}s old (max {self.cfg.max_signal_age_seconds}s)"
                )

        return RiskCheckResult(allowed=not reasons, reasons=reasons)

    def check_close(self, signal: TradeSignal, ctx: RiskContext) -> RiskCheckResult:
        """Closing an existing position reduces risk, so only sanity checks apply."""
        reasons: List[str] = []
        symbol = (signal.symbol or "").upper()
        if not symbol:
            reasons.append("close signal has no symbol")
        return RiskCheckResult(allowed=not reasons, reasons=reasons)

"""Decides how much USDT notional and what leverage to use for a signal,
based on the position_sizing / leverage sections of the settings file.
"""
from __future__ import annotations

from typing import Callable, Optional

from src.config import LeverageConfig, PositionSizingConfig
from src.models import TradeSignal


class PositionSizer:
    def __init__(
        self,
        sizing: PositionSizingConfig,
        leverage: LeverageConfig,
        balance_fetcher: Optional[Callable[[], float]] = None,
    ):
        """balance_fetcher returns the available futures balance in USDT.
        Required only when mode (or fallback_mode) is percent_balance.
        """
        self.sizing = sizing
        self.leverage_cfg = leverage
        self.balance_fetcher = balance_fetcher

    def size_usdt(self, signal: TradeSignal) -> float:
        mode = self.sizing.mode
        if mode == "signal":
            if signal.size_usdt and signal.size_usdt > 0:
                return signal.size_usdt
            mode = self.sizing.fallback_mode

        if mode == "fixed_usdt":
            return self.sizing.fixed_usdt.amount

        if mode == "percent_balance":
            if self.balance_fetcher is None:
                raise RuntimeError(
                    "percent_balance sizing requires a balance_fetcher"
                )
            balance = self.balance_fetcher()
            if balance <= 0:
                raise RuntimeError(f"available balance is {balance}, cannot size position")
            return balance * self.sizing.percent_balance.percent / 100.0

        raise ValueError(f"unknown sizing mode: {mode}")

    def leverage(self, signal: TradeSignal) -> int:
        lev = signal.leverage or self.leverage_cfg.default
        if lev < 1:
            lev = 1
        return min(lev, self.leverage_cfg.max)

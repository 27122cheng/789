"""Glue between a parsed TradeSignal and Pionex: builds an OrderPlan via the
position sizer, runs it through the risk manager, then either simulates
(dry-run) or actually places the order(s).

Position tracking here is intentionally simple: an in-memory count of
positions this bot itself opened/closed during the current run. It does not
reconcile with positions opened manually on the exchange - treat the risk
limits as bot-scoped, not account-scoped.
"""
from __future__ import annotations

import logging
import uuid
from typing import Dict, Optional

from src.config import AppConfig
from src.models import OrderPlan, OrderResult, TradeSignal
from src.pionex_client import PionexAPIError, PionexClient, to_perp_symbol
from src.position_sizer import PositionSizer
from src.risk_manager import RiskContext, RiskManager
from src.storage import Storage

logger = logging.getLogger(__name__)


class SignalExecutor:
    def __init__(
        self,
        config: AppConfig,
        client: PionexClient,
        sizer: PositionSizer,
        risk: RiskManager,
        storage: Storage,
        live: bool = False,
    ):
        self.config = config
        self.client = client
        self.sizer = sizer
        self.risk = risk
        self.storage = storage
        # Real orders require BOTH the CLI --live flag and LIVE_TRADING=true.
        self.live = live and config.live_trading
        self.realized_pnl_today = 0.0
        self._open_positions: Dict[str, int] = {}

    # ------------------------------------------------------------------ #
    def handle_signal(self, signal: TradeSignal) -> Optional[OrderResult]:
        signal_id = self.storage.record_signal(signal)
        if signal_id is None:
            logger.info("duplicate signal %s ignored", signal.dedup_key)
            return None

        if signal.warnings:
            logger.warning("signal warnings: %s", "; ".join(signal.warnings))

        if not signal.is_actionable:
            logger.info("signal not actionable, skipping: %r", signal.raw_text[:120])
            return None

        if signal.action == "close":
            return self._handle_close(signal, signal_id)
        return self._handle_open(signal, signal_id)

    # ------------------------------------------------------------------ #
    def _risk_context(self) -> RiskContext:
        last_times = {}
        for symbol in self._open_positions:
            t = self.storage.last_order_time(symbol)
            if t is not None:
                last_times[symbol] = t
        return RiskContext(
            open_positions_total=sum(self._open_positions.values()),
            open_positions_by_symbol=dict(self._open_positions),
            realized_pnl_today_usdt=self.realized_pnl_today,
            last_order_time_by_symbol=last_times,
        )

    def _handle_open(self, signal: TradeSignal, signal_id: int) -> Optional[OrderResult]:
        check = self.risk.check_open(signal, self._risk_context())
        if not check.allowed:
            logger.warning("risk check rejected %s: %s", signal.symbol,
                           "; ".join(check.reasons))
            return None

        try:
            size_usdt = self.sizer.size_usdt(signal)
        except Exception as exc:
            logger.error("position sizing failed: %s", exc)
            return None
        leverage = self.sizer.leverage(signal)

        orders_cfg = self.config.trading.orders
        limit_price = None
        order_type = orders_cfg.entry_order_type
        if order_type == "limit":
            limit_price = self._pick_limit_price(signal)
            if limit_price is None:
                logger.info("no entry price in signal; falling back to market order")
                order_type = "market"

        plan = OrderPlan(
            symbol=signal.symbol,
            side=signal.side,
            action="open",
            leverage=leverage,
            size_usdt=size_usdt,
            order_type=order_type,
            limit_price=limit_price,
            stop_loss=signal.stop_loss if orders_cfg.attach_stop_loss else None,
            take_profits=list(signal.take_profits) if orders_cfg.attach_take_profit else [],
        )

        result = self._execute_plan(plan)
        self.storage.record_order(result, signal_id)
        if result.success:
            self._open_positions[plan.symbol] = self._open_positions.get(plan.symbol, 0) + 1
        return result

    def _handle_close(self, signal: TradeSignal, signal_id: int) -> Optional[OrderResult]:
        check = self.risk.check_close(signal, self._risk_context())
        if not check.allowed:
            logger.warning("close rejected: %s", "; ".join(check.reasons))
            return None

        plan = OrderPlan(
            symbol=signal.symbol,
            side=signal.side or "close",
            action="close",
            leverage=0,
            size_usdt=0.0,
            order_type="market",
        )
        result = self._execute_plan(plan)
        self.storage.record_order(result, signal_id)
        if result.success and self._open_positions.get(plan.symbol, 0) > 0:
            self._open_positions[plan.symbol] -= 1
        return result

    # ------------------------------------------------------------------ #
    def _pick_limit_price(self, signal: TradeSignal) -> Optional[float]:
        if signal.entry_price is None:
            return None
        if signal.entry_price_high is None:
            return signal.entry_price
        lo, hi = sorted((signal.entry_price, signal.entry_price_high))
        prefer_best = self.config.trading.orders.limit_price_selection == "best"
        if signal.side == "long":
            # best = fills sooner = higher price for a long entry
            return hi if prefer_best else lo
        return lo if prefer_best else hi

    # ------------------------------------------------------------------ #
    def _execute_plan(self, plan: OrderPlan) -> OrderResult:
        if not self.live:
            logger.info(
                "[DRY-RUN] %s %s %s | %.2f USDT @ %sx | type=%s price=%s SL=%s TP=%s",
                plan.action.upper(), plan.side, plan.symbol, plan.size_usdt,
                plan.leverage, plan.order_type, plan.limit_price,
                plan.stop_loss, plan.take_profits,
            )
            return OrderResult(success=True, dry_run=True, plan=plan,
                               message="dry-run: order simulated, nothing sent")

        try:
            return self._execute_live(plan)
        except PionexAPIError as exc:
            logger.error("Pionex API error: %s", exc)
            return OrderResult(success=False, dry_run=False, plan=plan,
                               message=str(exc), raw_response=exc.payload)
        except Exception as exc:  # network problems etc.
            logger.exception("order execution failed")
            return OrderResult(success=False, dry_run=False, plan=plan,
                               message=str(exc))

    def _execute_live(self, plan: OrderPlan) -> OrderResult:
        perp_symbol = to_perp_symbol(plan.symbol)
        order_ids = []

        if plan.action == "close":
            # Closing = market order in the opposite direction of the open
            # position for its full size. Without position-query support we
            # cannot know the exact size here; surface that honestly.
            return OrderResult(
                success=False, dry_run=False, plan=plan,
                message=(
                    "automatic close is not implemented: fetching the current "
                    "position size requires the Pionex futures position endpoint - "
                    "close the position manually or extend PionexClient"
                ),
            )

        side = "BUY" if plan.side == "long" else "SELL"
        client_oid = uuid.uuid4().hex[:24]

        if plan.order_type == "market":
            if side == "BUY":
                resp = self.client.place_order(
                    symbol=perp_symbol, side=side, order_type="MARKET",
                    amount=f"{plan.size_usdt:.2f}", client_order_id=client_oid,
                )
            else:
                price = self.client.get_price(perp_symbol)
                qty = plan.size_usdt / price
                resp = self.client.place_order(
                    symbol=perp_symbol, side=side, order_type="MARKET",
                    size=f"{qty:.6f}", client_order_id=client_oid,
                )
        else:
            qty = plan.size_usdt / plan.limit_price
            resp = self.client.place_order(
                symbol=perp_symbol, side=side, order_type="LIMIT",
                size=f"{qty:.6f}", price=f"{plan.limit_price}",
                client_order_id=client_oid,
            )

        oid = str((resp.get("data") or {}).get("orderId", ""))
        if oid:
            order_ids.append(oid)

        messages = ["entry order placed"]
        if plan.stop_loss is not None or plan.take_profits:
            messages.append(
                "NOTE: exchange-side SL/TP attachment is not supported by this "
                "client yet - the intended SL/TP levels were logged to the DB; "
                "manage exits manually or extend PionexClient with the futures "
                "TP/SL endpoint"
            )

        return OrderResult(
            success=True, dry_run=False, plan=plan,
            message="; ".join(messages), raw_response=resp, order_ids=order_ids,
        )

"""End-to-end-ish tests of SignalExecutor in dry-run mode (no HTTP), plus a
mocked live-mode order placement.
"""
from unittest.mock import MagicMock

import pytest

from src.config import AppConfig, PionexConfig, TelegramConfig, TradingSettings
from src.executor import SignalExecutor
from src.models import TradeSignal
from src.position_sizer import PositionSizer
from src.risk_manager import RiskManager
from src.storage import Storage


@pytest.fixture
def storage(tmp_path):
    s = Storage(str(tmp_path / "test.db"))
    yield s
    s.close()


def make_config(live_trading=False) -> AppConfig:
    return AppConfig(
        telegram=TelegramConfig(api_id=1, api_hash="h"),
        pionex=PionexConfig(api_key="k", api_secret="s"),
        trading=TradingSettings(),
        live_trading=live_trading,
    )


def make_executor(storage, live_flag=False, live_env=False, client=None):
    config = make_config(live_trading=live_env)
    client = client or MagicMock()
    sizer = PositionSizer(config.trading.position_sizing, config.trading.leverage)
    risk = RiskManager(config.trading.risk)
    return SignalExecutor(
        config=config, client=client, sizer=sizer, risk=risk,
        storage=storage, live=live_flag,
    )


def open_signal(**kw):
    defaults = dict(
        raw_text="BTCUSDT long 10x sl 59000",
        action="open", symbol="BTCUSDT", side="long",
        leverage=10, stop_loss=59000.0,
        chat_id=1, message_id=100,
    )
    defaults.update(kw)
    return TradeSignal(**defaults)


def test_dry_run_never_calls_api(storage):
    client = MagicMock()
    ex = make_executor(storage, live_flag=False, client=client)
    result = ex.handle_signal(open_signal())
    assert result is not None
    assert result.success and result.dry_run
    client.place_order.assert_not_called()
    client.get_price.assert_not_called()


def test_live_flag_without_env_stays_dry(storage):
    client = MagicMock()
    # --live passed but LIVE_TRADING=false -> must stay dry
    ex = make_executor(storage, live_flag=True, live_env=False, client=client)
    result = ex.handle_signal(open_signal())
    assert result.dry_run
    client.place_order.assert_not_called()


def test_live_mode_places_market_buy_with_usdt_amount(storage):
    client = MagicMock()
    client.place_order.return_value = {"result": True, "data": {"orderId": 555}}
    ex = make_executor(storage, live_flag=True, live_env=True, client=client)

    result = ex.handle_signal(open_signal())
    assert result.success and not result.dry_run
    assert result.order_ids == ["555"]

    kwargs = client.place_order.call_args.kwargs
    assert kwargs["symbol"] == "BTC_USDT_PERP"
    assert kwargs["side"] == "BUY"
    assert kwargs["order_type"] == "MARKET"
    assert kwargs["amount"] == "100.00"  # default fixed_usdt amount


def test_live_market_short_uses_price_for_qty(storage):
    client = MagicMock()
    client.get_price.return_value = 50000.0
    client.place_order.return_value = {"result": True, "data": {"orderId": 7}}
    ex = make_executor(storage, live_flag=True, live_env=True, client=client)

    result = ex.handle_signal(open_signal(side="short", message_id=101))
    assert result.success
    kwargs = client.place_order.call_args.kwargs
    assert kwargs["side"] == "SELL"
    assert kwargs["size"] == f"{100/50000:.6f}"


def test_duplicate_signal_ignored(storage):
    ex = make_executor(storage)
    sig = open_signal()
    assert ex.handle_signal(sig) is not None
    assert ex.handle_signal(sig) is None  # same dedup key -> skipped


def test_risk_rejection_returns_none(storage):
    ex = make_executor(storage)
    bad = open_signal(symbol="BTCUSDT", side=None, warnings=["no side"])
    assert ex.handle_signal(bad) is None


def test_open_positions_tracked_and_capped(storage):
    ex = make_executor(storage)
    # default max_positions_per_symbol = 1
    r1 = ex.handle_signal(open_signal(message_id=1))
    assert r1 is not None and r1.success
    r2 = ex.handle_signal(open_signal(message_id=2))
    assert r2 is None  # second BTCUSDT open blocked


def test_close_signal_dry_run(storage):
    ex = make_executor(storage)
    result = ex.handle_signal(
        TradeSignal(raw_text="BTCUSDT 平仓", action="close",
                    symbol="BTCUSDT", chat_id=1, message_id=200)
    )
    assert result is not None
    assert result.success and result.dry_run


def test_orders_and_signals_recorded(storage):
    ex = make_executor(storage)
    ex.handle_signal(open_signal())
    n_signals = storage.conn.execute("SELECT COUNT(*) FROM signals").fetchone()[0]
    n_orders = storage.conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    assert n_signals == 1
    assert n_orders == 1

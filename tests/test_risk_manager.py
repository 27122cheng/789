from datetime import datetime, timedelta, timezone

from src.config import RiskConfig
from src.models import TradeSignal
from src.risk_manager import RiskContext, RiskManager


NOW = datetime(2026, 7, 7, 12, 0, 0, tzinfo=timezone.utc)


def signal(**kw):
    defaults = dict(
        raw_text="x", action="open", symbol="BTCUSDT", side="long",
        timestamp=NOW,
    )
    defaults.update(kw)
    return TradeSignal(**defaults)


def ctx(**kw):
    defaults = dict(now=NOW)
    defaults.update(kw)
    return RiskContext(**defaults)


def test_clean_signal_passes():
    rm = RiskManager(RiskConfig())
    res = rm.check_open(signal(), ctx())
    assert res.allowed, res.reasons


def test_whitelist_blocks_other_symbols():
    rm = RiskManager(RiskConfig(symbol_whitelist=["ETHUSDT"]))
    res = rm.check_open(signal(), ctx())
    assert not res.allowed
    assert any("whitelist" in r for r in res.reasons)


def test_blacklist_blocks():
    rm = RiskManager(RiskConfig(symbol_blacklist=["btcusdt"]))
    res = rm.check_open(signal(), ctx())
    assert not res.allowed


def test_max_open_positions():
    rm = RiskManager(RiskConfig(max_open_positions=2))
    res = rm.check_open(signal(), ctx(open_positions_total=2))
    assert not res.allowed


def test_max_positions_per_symbol():
    rm = RiskManager(RiskConfig(max_positions_per_symbol=1))
    res = rm.check_open(
        signal(), ctx(open_positions_by_symbol={"BTCUSDT": 1})
    )
    assert not res.allowed


def test_daily_loss_limit():
    rm = RiskManager(RiskConfig(max_daily_loss_usdt=100))
    res = rm.check_open(signal(), ctx(realized_pnl_today_usdt=-150.0))
    assert not res.allowed
    assert any("daily loss" in r for r in res.reasons)


def test_same_symbol_cooldown():
    rm = RiskManager(RiskConfig(min_seconds_between_same_symbol=60))
    recent = NOW - timedelta(seconds=10)
    res = rm.check_open(
        signal(), ctx(last_order_time_by_symbol={"BTCUSDT": recent})
    )
    assert not res.allowed

    old = NOW - timedelta(seconds=120)
    res = rm.check_open(
        signal(), ctx(last_order_time_by_symbol={"BTCUSDT": old})
    )
    assert res.allowed


def test_stale_signal_rejected():
    rm = RiskManager(RiskConfig(max_signal_age_seconds=90))
    stale = signal(timestamp=NOW - timedelta(seconds=300))
    res = rm.check_open(stale, ctx())
    assert not res.allowed
    assert any("old" in r for r in res.reasons)


def test_not_actionable_rejected():
    rm = RiskManager(RiskConfig())
    res = rm.check_open(signal(side=None), ctx())
    assert not res.allowed


def test_check_close_only_needs_symbol():
    rm = RiskManager(RiskConfig(max_open_positions=0))  # would block opens
    res = rm.check_close(signal(action="close", side=None), ctx())
    assert res.allowed
    res = rm.check_close(signal(action="close", symbol=None, side=None), ctx())
    assert not res.allowed

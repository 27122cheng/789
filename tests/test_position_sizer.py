import pytest

from src.config import (
    FixedUsdtSizing,
    LeverageConfig,
    PercentBalanceSizing,
    PositionSizingConfig,
)
from src.models import TradeSignal
from src.position_sizer import PositionSizer


def signal(**kw):
    defaults = dict(raw_text="x", action="open", symbol="BTCUSDT", side="long")
    defaults.update(kw)
    return TradeSignal(**defaults)


def test_fixed_usdt_mode():
    sizer = PositionSizer(
        PositionSizingConfig(mode="fixed_usdt", fixed_usdt=FixedUsdtSizing(amount=150)),
        LeverageConfig(),
    )
    assert sizer.size_usdt(signal()) == 150


def test_percent_balance_mode():
    sizer = PositionSizer(
        PositionSizingConfig(
            mode="percent_balance",
            percent_balance=PercentBalanceSizing(percent=10),
        ),
        LeverageConfig(),
        balance_fetcher=lambda: 2000.0,
    )
    assert sizer.size_usdt(signal()) == 200.0


def test_percent_balance_requires_fetcher():
    sizer = PositionSizer(
        PositionSizingConfig(mode="percent_balance"), LeverageConfig()
    )
    with pytest.raises(RuntimeError):
        sizer.size_usdt(signal())


def test_percent_balance_zero_balance_raises():
    sizer = PositionSizer(
        PositionSizingConfig(mode="percent_balance"),
        LeverageConfig(),
        balance_fetcher=lambda: 0.0,
    )
    with pytest.raises(RuntimeError):
        sizer.size_usdt(signal())


def test_signal_mode_uses_signal_size():
    sizer = PositionSizer(
        PositionSizingConfig(mode="signal", fixed_usdt=FixedUsdtSizing(amount=99)),
        LeverageConfig(),
    )
    assert sizer.size_usdt(signal(size_usdt=321.0)) == 321.0


def test_signal_mode_falls_back_when_no_size():
    sizer = PositionSizer(
        PositionSizingConfig(
            mode="signal",
            fixed_usdt=FixedUsdtSizing(amount=99),
            fallback_mode="fixed_usdt",
        ),
        LeverageConfig(),
    )
    assert sizer.size_usdt(signal(size_usdt=None)) == 99


def test_leverage_default_and_cap():
    sizer = PositionSizer(
        PositionSizingConfig(), LeverageConfig(default=10, max=20)
    )
    assert sizer.leverage(signal(leverage=None)) == 10
    assert sizer.leverage(signal(leverage=15)) == 15
    assert sizer.leverage(signal(leverage=125)) == 20
    assert sizer.leverage(signal(leverage=0)) == 10  # falsy -> default

from datetime import datetime, timezone

from src.signal_parser import SignalParser


def make_parser(**kw):
    return SignalParser(**kw)


def test_english_standard_signal():
    p = make_parser()
    s = p.parse(
        "BTCUSDT LONG 10x\nEntry: 60000-60500\nTP1: 61000\nTP2: 62500\nSL: 59000",
        chat_id=1, message_id=42,
    )
    assert s is not None
    assert s.action == "open"
    assert s.symbol == "BTCUSDT"
    assert s.side == "long"
    assert s.leverage == 10
    assert s.entry_price == 60000.0
    assert s.entry_price_high == 60500.0
    assert s.take_profits == [61000.0, 62500.0]
    assert s.stop_loss == 59000.0
    assert s.is_actionable


def test_chinese_signal_fullwidth_punctuation():
    p = make_parser()
    s = p.parse(
        "幣種：ETHUSDT\n方向：做空\n槓桿：20x\n入場價：3200\n止盈：3300，3400\n止損：3100"
    )
    assert s is not None
    assert s.symbol == "ETHUSDT"
    assert s.side == "short"
    assert s.leverage == 20
    assert s.entry_price == 3200.0
    assert s.take_profits == [3300.0, 3400.0]
    assert s.stop_loss == 3100.0


def test_close_signal():
    p = make_parser()
    s = p.parse("BTCUSDT 平仓")
    assert s is not None
    assert s.action == "close"
    assert s.symbol == "BTCUSDT"
    assert s.is_actionable


def test_non_signal_returns_none():
    p = make_parser()
    assert p.parse("gm everyone, market looking spicy today") is None
    assert p.parse("") is None
    assert p.parse("   ") is None


def test_open_without_side_not_actionable():
    p = make_parser()
    s = p.parse("BTCUSDT entry 60000")
    assert s is not None
    assert s.action == "open"
    assert s.side is None
    assert not s.is_actionable
    assert s.warnings


def test_symbol_with_separator():
    p = make_parser()
    s = p.parse("BTC/USDT short 5x sl 70000")
    assert s.symbol == "BTCUSDT"
    assert s.side == "short"
    assert s.leverage == 5


def test_leverage_chinese_bei():
    p = make_parser()
    s = p.parse("ETHUSDT 做多 20倍 入場價 3000")
    assert s.leverage == 20
    assert s.side == "long"
    assert s.entry_price == 3000.0


def test_explicit_size_in_usdt():
    p = make_parser()
    s = p.parse("BTCUSDT long 10x 金额: 250 USDT sl 59000")
    assert s.size_usdt == 250.0


def test_extra_keywords_from_config():
    p = make_parser(extra_long_keywords=["ape in"])
    s = p.parse("ape in BTCUSDT 10x")
    assert s.side == "long"


def test_thousands_separator_in_entry():
    p = make_parser()
    s = p.parse("BTCUSDT LONG entry 60,000 sl 59,500")
    assert s.entry_price == 60000.0
    assert s.stop_loss == 59500.0


def test_dedup_key_changes_when_text_edited():
    p = make_parser()
    s1 = p.parse("BTCUSDT long sl 59000", chat_id=5, message_id=9)
    s2 = p.parse("BTCUSDT long sl 58000", chat_id=5, message_id=9)
    assert s1.dedup_key != s2.dedup_key


def test_timestamp_passthrough():
    p = make_parser()
    ts = datetime(2026, 1, 1, tzinfo=timezone.utc)
    s = p.parse("BTCUSDT long", timestamp=ts)
    assert s.timestamp == ts

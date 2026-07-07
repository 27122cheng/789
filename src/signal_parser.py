"""Turns free-text Telegram messages into TradeSignal objects.

Designed for the common "standard" crypto signal layout, mixing English and
Chinese keywords, e.g.:

    BTCUSDT LONG 10x
    Entry: 60000-60500
    TP1: 61000
    TP2: 62500
    SL: 59000

    幣種：ETHUSDT
    方向：做多
    槓桿：20x
    入場價：3200
    止盈：3300，3400
    止損：3100

The parser is intentionally forgiving: any single field that fails to match
is left as None (or empty list) rather than raising, and callers should check
`TradeSignal.is_actionable` / `warnings` before acting on the result. It never
raises on malformed input - worst case it returns None (message doesn't look
like a signal at all) or a TradeSignal with missing fields plus warnings.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Iterable, List, Optional

from src.models import TradeSignal

_LONG_KEYWORDS = [
    "long", "buy", "多", "做多", "开多", "买多",
    "看多", "多单", "做多单",
]
_SHORT_KEYWORDS = [
    "short", "sell", "空", "做空", "开空", "卖空",
    "看空", "空单", "做空单",
]
_CLOSE_KEYWORDS = [
    "close", "exit", "close position", "平仓", "全部平仓",
    "平多", "平空", "出场", "离场",
]

_QUOTE_ASSETS = ("USDT", "USDC", "BUSD", "USD")

_SYMBOL_RE = re.compile(
    r"\b([A-Za-z0-9]{2,15})[\-/_]?(" + "|".join(_QUOTE_ASSETS) + r")\b"
)
_LABELED_SYMBOL_RE = re.compile(
    r"(?:幣種|标的|标的物|symbol|pair|coin)\s*[:：]\s*\$?([A-Za-z0-9]{2,15})(?:[\-/_]?(?:"
    + "|".join(_QUOTE_ASSETS) + r"))?\b",
    re.IGNORECASE,
)

_NUM = r"[\d][\d,]*(?:\.\d+)?"


def _num_list(text: str) -> List[float]:
    out = []
    for raw in re.findall(_NUM, text):
        try:
            out.append(float(raw.replace(",", "")))
        except ValueError:
            continue
    return out


_FULLWIDTH_MAP = str.maketrans({
    "：": ":", "，": ",", "／": "/", "－": "-", "％": "%",
    "、": ",", "～": "~",
    **{chr(0xFF10 + i): str(i) for i in range(10)},
})


def _normalize(text: str) -> str:
    return text.translate(_FULLWIDTH_MAP)


def _find_first(patterns: Iterable[str], text_lower: str) -> Optional[re.Match]:
    for pat in patterns:
        m = re.search(re.escape(pat.lower()), text_lower)
        if m:
            return m
    return None


class SignalParser:
    def __init__(
        self,
        extra_long_keywords: Optional[List[str]] = None,
        extra_short_keywords: Optional[List[str]] = None,
        extra_close_keywords: Optional[List[str]] = None,
    ):
        self.long_keywords = list(_LONG_KEYWORDS) + list(extra_long_keywords or [])
        self.short_keywords = list(_SHORT_KEYWORDS) + list(extra_short_keywords or [])
        self.close_keywords = list(_CLOSE_KEYWORDS) + list(extra_close_keywords or [])

    def parse(
        self,
        text: str,
        chat_id: Optional[int] = None,
        message_id: Optional[int] = None,
        timestamp: Optional[datetime] = None,
    ) -> Optional[TradeSignal]:
        if not text or not text.strip():
            return None

        norm = _normalize(text)
        lower = norm.lower()

        symbol = self._extract_symbol(norm)
        if not symbol:
            # No recognizable trading pair -> this isn't a signal we can act on.
            return None

        warnings: List[str] = []

        action = "close" if _find_first(self.close_keywords, lower) else "open"

        side = None
        if action == "open":
            side = self._extract_side(lower)
            if side is None:
                warnings.append("could not determine long/short side")

        leverage = self._extract_leverage(norm)
        entry_low, entry_high = self._extract_entry(norm)
        take_profits = self._extract_take_profits(norm)
        stop_loss = self._extract_stop_loss(norm)
        size_usdt = self._extract_size(norm)

        signal = TradeSignal(
            raw_text=text,
            action=action,
            symbol=symbol,
            side=side,
            leverage=leverage,
            entry_price=entry_low,
            entry_price_high=entry_high,
            take_profits=take_profits,
            stop_loss=stop_loss,
            size_usdt=size_usdt,
            chat_id=chat_id,
            message_id=message_id,
            timestamp=timestamp or datetime.now(timezone.utc),
            warnings=warnings,
        )
        return signal

    @staticmethod
    def _extract_symbol(norm: str) -> Optional[str]:
        m = _SYMBOL_RE.search(norm)
        if m:
            base, quote = m.group(1).upper(), m.group(2).upper()
            return f"{base}{quote}"
        m = _LABELED_SYMBOL_RE.search(norm)
        if m:
            base = m.group(1).upper()
            if base in _QUOTE_ASSETS:
                return None
            return f"{base}USDT"
        return None

    def _extract_side(self, lower: str) -> Optional[str]:
        long_m = _find_first(self.long_keywords, lower)
        short_m = _find_first(self.short_keywords, lower)
        if long_m and short_m:
            # Both matched (e.g. a keyword substring collision) - whichever
            # appears first in the text wins.
            return "long" if long_m.start() <= short_m.start() else "short"
        if long_m:
            return "long"
        if short_m:
            return "short"
        return None

    @staticmethod
    def _extract_leverage(norm: str) -> Optional[int]:
        m = re.search(r"(\d{1,3})\s*[xX倍]", norm)
        if m:
            return int(m.group(1))
        m = re.search(
            r"(?:杠杆|leverage)\s*[:：]?\s*(\d{1,3})", norm, re.IGNORECASE
        )
        if m:
            return int(m.group(1))
        return None

    @staticmethod
    def _extract_entry(norm: str):
        m = re.search(
            r"(?:entry|入場价|入場價|进場|开仓价|开仓價)"
            r"\s*[:：]?\s*(" + _NUM + r")(?:\s*(?:-|~|至|to)\s*(" + _NUM + r"))?",
            norm,
            re.IGNORECASE,
        )
        if not m:
            return None, None
        low = float(m.group(1).replace(",", ""))
        high = float(m.group(2).replace(",", "")) if m.group(2) else None
        return low, high

    @staticmethod
    def _extract_take_profits(norm: str) -> List[float]:
        # Note: within a single TP label's value, "," / "、" / "~" / "-" are
        # treated as separators between *multiple* target prices (e.g.
        # "TP: 3300,3400") rather than thousands separators, since signal
        # channels list several TP targets far more often than they use
        # thousands separators inside one price.
        values: List[float] = []
        for m in re.finditer(
            r"(?:tp\d*|take\s*profit\d*|止盈\d*|目标价\d*|目标\d*)"
            r"\s*[:：]?\s*([\d.,~\-\s]+?)(?=$|\n|[a-zA-Z一-鿿])",
            norm,
            re.IGNORECASE | re.MULTILINE,
        ):
            for token in re.split(r"[,、~\-\s]+", m.group(1).strip()):
                if not token:
                    continue
                try:
                    v = float(token)
                except ValueError:
                    continue
                if v not in values:
                    values.append(v)
        return values

    @staticmethod
    def _extract_stop_loss(norm: str) -> Optional[float]:
        m = re.search(
            r"(?:sl|stop\s*loss|止損)\s*[:：]?\s*(" + _NUM + r")",
            norm,
            re.IGNORECASE,
        )
        if m:
            return float(m.group(1).replace(",", ""))
        return None

    @staticmethod
    def _extract_size(norm: str) -> Optional[float]:
        m = re.search(
            r"(?:仓位|金额|size|amount)\s*[:：]?\s*("
            + _NUM
            + r")\s*(?:usdt|u\b)",
            norm,
            re.IGNORECASE,
        )
        if m:
            return float(m.group(1).replace(",", ""))
        return None

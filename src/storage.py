"""SQLite persistence: every received signal and every order attempt is
recorded, both for auditing and to power risk checks (dedup, per-symbol
cooldown, daily PnL if you record fills manually).
"""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

from src.models import OrderResult, TradeSignal

_SCHEMA = """
CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    received_at TEXT NOT NULL,
    chat_id INTEGER,
    message_id INTEGER,
    dedup_key TEXT,
    action TEXT,
    symbol TEXT,
    side TEXT,
    leverage INTEGER,
    entry_price REAL,
    entry_price_high REAL,
    stop_loss REAL,
    take_profits TEXT,
    size_usdt REAL,
    warnings TEXT,
    raw_text TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_dedup ON signals(dedup_key);

CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    signal_id INTEGER REFERENCES signals(id),
    symbol TEXT NOT NULL,
    side TEXT,
    action TEXT,
    leverage INTEGER,
    size_usdt REAL,
    order_type TEXT,
    limit_price REAL,
    stop_loss REAL,
    take_profits TEXT,
    dry_run INTEGER NOT NULL,
    success INTEGER NOT NULL,
    message TEXT,
    order_ids TEXT,
    raw_response TEXT
);
"""


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


class Storage:
    def __init__(self, db_path: str):
        Path(db_path).parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(db_path)
        self.conn.executescript(_SCHEMA)
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def record_signal(self, signal: TradeSignal) -> Optional[int]:
        """Insert the signal; returns its row id, or None if this
        chat_id:message_id was already recorded (duplicate delivery)."""
        try:
            cur = self.conn.execute(
                """INSERT INTO signals
                   (received_at, chat_id, message_id, dedup_key, action, symbol,
                    side, leverage, entry_price, entry_price_high, stop_loss,
                    take_profits, size_usdt, warnings, raw_text)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    _now_iso(), signal.chat_id, signal.message_id,
                    signal.dedup_key, signal.action, signal.symbol,
                    signal.side, signal.leverage, signal.entry_price,
                    signal.entry_price_high, signal.stop_loss,
                    json.dumps(signal.take_profits), signal.size_usdt,
                    json.dumps(signal.warnings), signal.raw_text,
                ),
            )
            self.conn.commit()
            return cur.lastrowid
        except sqlite3.IntegrityError:
            return None

    def record_order(self, result: OrderResult, signal_id: Optional[int]) -> int:
        plan = result.plan
        cur = self.conn.execute(
            """INSERT INTO orders
               (created_at, signal_id, symbol, side, action, leverage,
                size_usdt, order_type, limit_price, stop_loss, take_profits,
                dry_run, success, message, order_ids, raw_response)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                _now_iso(), signal_id, plan.symbol, plan.side, plan.action,
                plan.leverage, plan.size_usdt, plan.order_type,
                plan.limit_price, plan.stop_loss,
                json.dumps(plan.take_profits),
                1 if result.dry_run else 0,
                1 if result.success else 0,
                result.message,
                json.dumps(result.order_ids),
                json.dumps(result.raw_response) if result.raw_response else None,
            ),
        )
        self.conn.commit()
        return cur.lastrowid

    def last_order_time(self, symbol: str) -> Optional[datetime]:
        row = self.conn.execute(
            "SELECT created_at FROM orders WHERE symbol = ? AND success = 1 "
            "ORDER BY id DESC LIMIT 1",
            (symbol,),
        ).fetchone()
        if row is None:
            return None
        return datetime.fromisoformat(row[0])

    def successful_orders_today(self) -> int:
        today = datetime.now(timezone.utc).date().isoformat()
        row = self.conn.execute(
            "SELECT COUNT(*) FROM orders WHERE success = 1 AND dry_run = 0 "
            "AND created_at >= ?",
            (today,),
        ).fetchone()
        return int(row[0])

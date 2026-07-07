"""Telethon-based listener: watches the configured chats/channels and feeds
every new (and optionally edited) message through the signal parser into the
executor.

First run requires an interactive login (phone number + code) to create the
.session file; after that it reconnects automatically.
"""
from __future__ import annotations

import logging
from typing import List, Union

from telethon import TelegramClient, events

from src.config import TelegramConfig
from src.executor import SignalExecutor
from src.signal_parser import SignalParser

logger = logging.getLogger(__name__)


def _normalize_chats(chat_ids: List[str]) -> List[Union[int, str]]:
    out: List[Union[int, str]] = []
    for raw in chat_ids:
        raw = raw.strip()
        if not raw:
            continue
        try:
            out.append(int(raw))
        except ValueError:
            out.append(raw.lstrip("@"))
    return out


class TelegramSignalListener:
    def __init__(
        self,
        cfg: TelegramConfig,
        parser: SignalParser,
        executor: SignalExecutor,
    ):
        self.cfg = cfg
        self.parser = parser
        self.executor = executor
        self.client = TelegramClient(cfg.session_name, cfg.api_id, cfg.api_hash)

    async def _handle(self, event) -> None:
        message = event.message
        text = message.message or ""
        chat_id = event.chat_id
        try:
            signal = self.parser.parse(
                text,
                chat_id=chat_id,
                message_id=message.id,
                timestamp=message.date,
            )
        except Exception:
            logger.exception("parser crashed on message %s:%s", chat_id, message.id)
            return

        if signal is None:
            logger.debug("ignored non-signal message from %s", chat_id)
            return

        logger.info(
            "signal from chat %s: %s %s %s",
            chat_id, signal.action, signal.side, signal.symbol,
        )
        try:
            self.executor.handle_signal(signal)
        except Exception:
            logger.exception("executor failed for message %s:%s", chat_id, message.id)

    def run(self) -> None:
        chats = _normalize_chats(self.cfg.chat_ids)
        if not chats:
            raise SystemExit(
                "TELEGRAM_CHAT_IDS is empty - set at least one channel/group "
                "username or chat id in .env"
            )

        self.client.add_event_handler(
            self._handle, events.NewMessage(chats=chats)
        )
        if self.cfg.react_to_edits:
            self.client.add_event_handler(
                self._handle, events.MessageEdited(chats=chats)
            )

        logger.info("connecting to Telegram; monitoring chats: %s", chats)
        with self.client:
            self.client.run_until_disconnected()

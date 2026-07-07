"""Entry point.

    python -m src.main            # dry-run (default): parse + simulate only
    python -m src.main --live     # real orders, ALSO requires LIVE_TRADING=true in .env

Dry-run is the default on purpose: run it against your signal channel for a
while and inspect the SQLite log before risking real funds.
"""
from __future__ import annotations

import argparse
import logging
import sys

from src.config import load_config
from src.executor import SignalExecutor
from src.pionex_client import PionexClient
from src.position_sizer import PositionSizer
from src.risk_manager import RiskManager
from src.signal_parser import SignalParser
from src.storage import Storage
from src.telegram_listener import TelegramSignalListener


def build_app(args: argparse.Namespace):
    config = load_config(args.env_file)

    if not config.telegram.api_id or not config.telegram.api_hash:
        raise SystemExit("TELEGRAM_API_ID / TELEGRAM_API_HASH missing in .env")

    live = bool(args.live) and config.live_trading
    if args.live and not config.live_trading:
        logging.warning(
            "--live was passed but LIVE_TRADING is not 'true' in .env -> "
            "staying in dry-run mode"
        )
    if live and (not config.pionex.api_key or not config.pionex.api_secret):
        raise SystemExit("live mode requires PIONEX_API_KEY / PIONEX_API_SECRET in .env")

    client = PionexClient(
        api_key=config.pionex.api_key,
        api_secret=config.pionex.api_secret,
        base_url=config.pionex.base_url,
    )
    sizer = PositionSizer(
        sizing=config.trading.position_sizing,
        leverage=config.trading.leverage,
        balance_fetcher=client.get_available_usdt,
    )
    risk = RiskManager(config.trading.risk)
    storage = Storage(config.db_path)
    executor = SignalExecutor(
        config=config, client=client, sizer=sizer,
        risk=risk, storage=storage, live=live,
    )
    parser_cfg = config.trading.parser
    signal_parser = SignalParser(
        extra_long_keywords=parser_cfg.extra_long_keywords,
        extra_short_keywords=parser_cfg.extra_short_keywords,
        extra_close_keywords=parser_cfg.extra_close_keywords,
    )
    listener = TelegramSignalListener(config.telegram, signal_parser, executor)
    return listener, live


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description="Telegram signal -> Pionex futures auto-trader"
    )
    ap.add_argument(
        "--live", action="store_true",
        help="send real orders to Pionex (also requires LIVE_TRADING=true in .env); "
             "default is dry-run/simulation",
    )
    ap.add_argument("--env-file", default=".env", help="path to the .env file")
    ap.add_argument("-v", "--verbose", action="store_true", help="debug logging")
    args = ap.parse_args(argv)

    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )

    listener, live = build_app(args)
    banner = "LIVE TRADING - real orders will be sent" if live else "DRY-RUN - no real orders"
    logging.info("=" * 60)
    logging.info("mode: %s", banner)
    logging.info("=" * 60)

    listener.run()
    return 0


if __name__ == "__main__":
    sys.exit(main())

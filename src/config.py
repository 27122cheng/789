"""Loads and validates configuration from environment variables (.env) and
the YAML settings file (config/settings.yaml). Nothing in here talks to the
network - it only produces validated, typed config objects for the rest of
the app to consume.
"""
from __future__ import annotations

import os
from pathlib import Path
from typing import List, Literal, Optional

import yaml
from dotenv import load_dotenv
from pydantic import BaseModel, Field


class TelegramConfig(BaseModel):
    api_id: int
    api_hash: str
    session_name: str = "telegram_pionex_bot"
    chat_ids: List[str] = Field(default_factory=list)
    react_to_edits: bool = True


class PionexConfig(BaseModel):
    api_key: str
    api_secret: str
    base_url: str = "https://api.pionex.com"


class FixedUsdtSizing(BaseModel):
    amount: float = 100.0


class PercentBalanceSizing(BaseModel):
    percent: float = 5.0


class PositionSizingConfig(BaseModel):
    mode: Literal["fixed_usdt", "percent_balance", "signal"] = "fixed_usdt"
    fixed_usdt: FixedUsdtSizing = Field(default_factory=FixedUsdtSizing)
    percent_balance: PercentBalanceSizing = Field(default_factory=PercentBalanceSizing)
    fallback_mode: Literal["fixed_usdt", "percent_balance"] = "fixed_usdt"


class LeverageConfig(BaseModel):
    default: int = 10
    max: int = 20


class RiskConfig(BaseModel):
    symbol_whitelist: List[str] = Field(default_factory=list)
    symbol_blacklist: List[str] = Field(default_factory=list)
    max_open_positions: int = 5
    max_positions_per_symbol: int = 1
    max_daily_loss_usdt: float = 200.0
    min_seconds_between_same_symbol: int = 30
    max_signal_age_seconds: int = 90


class OrdersConfig(BaseModel):
    entry_order_type: Literal["market", "limit"] = "market"
    limit_price_selection: Literal["best", "worst"] = "best"
    attach_stop_loss: bool = True
    attach_take_profit: bool = True
    split_position_across_take_profits: bool = True


class ParserConfig(BaseModel):
    extra_long_keywords: List[str] = Field(default_factory=list)
    extra_short_keywords: List[str] = Field(default_factory=list)
    extra_close_keywords: List[str] = Field(default_factory=list)


class TradingSettings(BaseModel):
    position_sizing: PositionSizingConfig = Field(default_factory=PositionSizingConfig)
    leverage: LeverageConfig = Field(default_factory=LeverageConfig)
    risk: RiskConfig = Field(default_factory=RiskConfig)
    orders: OrdersConfig = Field(default_factory=OrdersConfig)
    parser: ParserConfig = Field(default_factory=ParserConfig)


class AppConfig(BaseModel):
    telegram: TelegramConfig
    pionex: PionexConfig
    trading: TradingSettings
    live_trading: bool = False
    db_path: str = "data/trading.db"


def _load_yaml_settings(settings_file: Optional[str]):
    """Returns (TradingSettings, telegram_extra_dict_or_None)."""
    if not settings_file:
        return TradingSettings(), None
    path = Path(settings_file)
    if not path.exists():
        return TradingSettings(), None
    with path.open("r", encoding="utf-8") as fh:
        raw = yaml.safe_load(fh) or {}
    telegram_extra = raw.pop("telegram", None)
    settings = TradingSettings.model_validate(raw)
    return settings, telegram_extra


def load_config(env_file: str = ".env") -> AppConfig:
    load_dotenv(env_file, override=False)

    settings_file = os.getenv("SETTINGS_FILE", "config/settings.yaml")
    trading_settings, telegram_extra = _load_yaml_settings(settings_file)

    chat_ids_raw = os.getenv("TELEGRAM_CHAT_IDS", "")
    chat_ids = [c.strip() for c in chat_ids_raw.split(",") if c.strip()]

    telegram_kwargs = dict(
        api_id=int(os.getenv("TELEGRAM_API_ID", "0") or "0"),
        api_hash=os.getenv("TELEGRAM_API_HASH", ""),
        session_name=os.getenv("TELEGRAM_SESSION", "telegram_pionex_bot"),
        chat_ids=chat_ids,
    )
    if isinstance(telegram_extra, dict) and "react_to_edits" in telegram_extra:
        telegram_kwargs["react_to_edits"] = telegram_extra["react_to_edits"]

    return AppConfig(
        telegram=TelegramConfig(**telegram_kwargs),
        pionex=PionexConfig(
            api_key=os.getenv("PIONEX_API_KEY", ""),
            api_secret=os.getenv("PIONEX_API_SECRET", ""),
            base_url=os.getenv("PIONEX_BASE_URL", "https://api.pionex.com"),
        ),
        trading=trading_settings,
        live_trading=os.getenv("LIVE_TRADING", "false").strip().lower() == "true",
        db_path=os.getenv("DB_PATH", "data/trading.db"),
    )

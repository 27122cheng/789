"""Minimal Pionex REST API client with HMAC-SHA256 request signing.

Signing scheme (per Pionex API docs, "Authentication" section):

    1. Add a millisecond `timestamp` to the query parameters.
    2. Sort all query parameters by key (ascending) and join as k1=v1&k2=v2.
    3. Build PATH_URL = <path> + "?" + <sorted query string>.
    4. message = <METHOD upper-cased> + PATH_URL, and for POST/DELETE
       requests append the exact JSON body string.
    5. signature = hex(HMAC_SHA256(api_secret, message))
    6. Send headers: PIONEX-KEY: <api_key>, PIONEX-SIGNATURE: <signature>.

IMPORTANT - endpoint paths
--------------------------
Pionex's public REST API and its perpetual-futures endpoints evolve, and the
docs site could not be reached from the environment this code was written in.
The default paths below follow Pionex's published v1 API layout, but you MUST
verify them (and the futures symbol format, e.g. "BTC_USDT_PERP") against
https://pionex-doc.gitbook.io/apidocs before enabling live trading. All paths
are constructor arguments so they can be corrected without code changes.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlencode

import requests


class PionexAPIError(RuntimeError):
    def __init__(self, message: str, status_code: Optional[int] = None,
                 payload: Optional[dict] = None):
        super().__init__(message)
        self.status_code = status_code
        self.payload = payload or {}


class PionexClient:
    def __init__(
        self,
        api_key: str,
        api_secret: str,
        base_url: str = "https://api.pionex.com",
        timeout: float = 10.0,
        # Endpoint paths - verify against current Pionex docs before live use.
        balances_path: str = "/api/v1/account/balances",
        order_path: str = "/api/v1/trade/order",
        cancel_order_path: str = "/api/v1/trade/order",
        open_orders_path: str = "/api/v1/trade/openOrders",
        tickers_path: str = "/api/v1/market/tickers",
        session: Optional[requests.Session] = None,
    ):
        self.api_key = api_key
        self.api_secret = api_secret
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.balances_path = balances_path
        self.order_path = order_path
        self.cancel_order_path = cancel_order_path
        self.open_orders_path = open_orders_path
        self.tickers_path = tickers_path
        self.session = session or requests.Session()

    # ------------------------------------------------------------------ #
    # signing / transport
    # ------------------------------------------------------------------ #
    def _sign(self, method: str, path: str, params: Dict[str, Any],
              body: Optional[str]) -> str:
        query = urlencode(sorted((k, str(v)) for k, v in params.items()))
        message = method.upper() + path + "?" + query
        if body:
            message += body
        return hmac.new(
            self.api_secret.encode("utf-8"),
            message.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()

    def _request(self, method: str, path: str,
                 params: Optional[Dict[str, Any]] = None,
                 body: Optional[Dict[str, Any]] = None) -> dict:
        params = dict(params or {})
        params["timestamp"] = str(int(time.time() * 1000))
        body_str = json.dumps(body, separators=(",", ":")) if body is not None else None

        signature = self._sign(method, path, params, body_str)
        headers = {
            "PIONEX-KEY": self.api_key,
            "PIONEX-SIGNATURE": signature,
        }
        if body_str is not None:
            headers["Content-Type"] = "application/json"

        url = self.base_url + path
        resp = self.session.request(
            method.upper(), url, params=params, data=body_str,
            headers=headers, timeout=self.timeout,
        )
        try:
            payload = resp.json()
        except ValueError:
            raise PionexAPIError(
                f"non-JSON response (HTTP {resp.status_code}): {resp.text[:300]}",
                status_code=resp.status_code,
            )
        # Pionex wraps responses as {"result": bool, "data": ..., "code": ..., "message": ...}
        if resp.status_code >= 400 or payload.get("result") is False:
            raise PionexAPIError(
                f"Pionex API error (HTTP {resp.status_code}): "
                f"{payload.get('code')} {payload.get('message')}",
                status_code=resp.status_code,
                payload=payload,
            )
        return payload

    # ------------------------------------------------------------------ #
    # public API
    # ------------------------------------------------------------------ #
    def get_balances(self) -> dict:
        return self._request("GET", self.balances_path)

    def get_available_usdt(self) -> float:
        payload = self.get_balances()
        balances = (payload.get("data") or {}).get("balances") or []
        for item in balances:
            if item.get("coin") == "USDT":
                return float(item.get("free", 0))
        return 0.0

    def get_price(self, symbol: str) -> float:
        payload = self._request("GET", self.tickers_path, params={"symbol": symbol})
        tickers = (payload.get("data") or {}).get("tickers") or []
        if not tickers:
            raise PionexAPIError(f"no ticker data for {symbol}", payload=payload)
        return float(tickers[0]["close"])

    def get_open_orders(self, symbol: str) -> List[dict]:
        payload = self._request("GET", self.open_orders_path, params={"symbol": symbol})
        return (payload.get("data") or {}).get("orders") or []

    def place_order(
        self,
        symbol: str,
        side: str,               # "BUY" | "SELL"
        order_type: str,         # "MARKET" | "LIMIT"
        size: Optional[str] = None,    # base-asset quantity (LIMIT & MARKET SELL)
        amount: Optional[str] = None,  # quote-asset amount (MARKET BUY)
        price: Optional[str] = None,   # required for LIMIT
        client_order_id: Optional[str] = None,
    ) -> dict:
        body: Dict[str, Any] = {
            "symbol": symbol,
            "side": side.upper(),
            "type": order_type.upper(),
        }
        if size is not None:
            body["size"] = size
        if amount is not None:
            body["amount"] = amount
        if price is not None:
            body["price"] = price
        if client_order_id:
            body["clientOrderId"] = client_order_id
        return self._request("POST", self.order_path, body=body)

    def cancel_order(self, symbol: str, order_id: str) -> dict:
        return self._request(
            "DELETE", self.cancel_order_path,
            body={"symbol": symbol, "orderId": order_id},
        )


def to_perp_symbol(symbol: str) -> str:
    """Convert a parser-normalized symbol like "BTCUSDT" into Pionex's
    underscore form for perpetual contracts, e.g. "BTC_USDT_PERP".
    Verify the exact futures symbol format against current Pionex docs.
    """
    s = symbol.upper().replace("-", "").replace("/", "").replace("_", "")
    for quote in ("USDT", "USDC", "BUSD", "USD"):
        if s.endswith(quote):
            return f"{s[: -len(quote)]}_{quote}_PERP"
    return f"{s}_USDT_PERP"

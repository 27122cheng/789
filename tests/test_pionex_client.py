import hashlib
import hmac
import json
from urllib.parse import parse_qsl, urlparse

import pytest
import responses

from src.pionex_client import PionexAPIError, PionexClient, to_perp_symbol

API_KEY = "test-key"
API_SECRET = "test-secret"
BASE = "https://api.pionex.test"


def make_client():
    return PionexClient(API_KEY, API_SECRET, base_url=BASE)


def expected_signature(method, path, params, body=None):
    query = "&".join(f"{k}={v}" for k, v in sorted(params))
    message = method.upper() + path + "?" + query
    if body:
        message += body
    return hmac.new(
        API_SECRET.encode(), message.encode(), hashlib.sha256
    ).hexdigest()


@responses.activate
def test_get_request_is_signed():
    responses.add(
        responses.GET, f"{BASE}/api/v1/account/balances",
        json={"result": True, "data": {"balances": [
            {"coin": "USDT", "free": "1234.5", "frozen": "0"}
        ]}},
    )
    client = make_client()
    assert client.get_available_usdt() == 1234.5

    req = responses.calls[0].request
    assert req.headers["PIONEX-KEY"] == API_KEY
    params = parse_qsl(urlparse(req.url).query)
    assert any(k == "timestamp" for k, _ in params)
    assert req.headers["PIONEX-SIGNATURE"] == expected_signature(
        "GET", "/api/v1/account/balances", params
    )


@responses.activate
def test_post_order_signs_body():
    responses.add(
        responses.POST, f"{BASE}/api/v1/trade/order",
        json={"result": True, "data": {"orderId": 987654}},
    )
    client = make_client()
    resp = client.place_order(
        symbol="BTC_USDT_PERP", side="BUY", order_type="MARKET", amount="100.00",
    )
    assert resp["data"]["orderId"] == 987654

    req = responses.calls[0].request
    body = req.body if isinstance(req.body, str) else req.body.decode()
    parsed = json.loads(body)
    assert parsed["symbol"] == "BTC_USDT_PERP"
    assert parsed["side"] == "BUY"
    assert parsed["type"] == "MARKET"
    assert parsed["amount"] == "100.00"

    params = parse_qsl(urlparse(req.url).query)
    assert req.headers["PIONEX-SIGNATURE"] == expected_signature(
        "POST", "/api/v1/trade/order", params, body
    )


@responses.activate
def test_api_level_error_raises():
    responses.add(
        responses.POST, f"{BASE}/api/v1/trade/order",
        json={"result": False, "code": "TRADE_INVALID_SYMBOL",
              "message": "symbol not found"},
    )
    client = make_client()
    with pytest.raises(PionexAPIError) as exc:
        client.place_order(symbol="NOPE", side="BUY",
                           order_type="MARKET", amount="10")
    assert "TRADE_INVALID_SYMBOL" in str(exc.value)


@responses.activate
def test_http_error_raises():
    responses.add(
        responses.GET, f"{BASE}/api/v1/account/balances",
        json={"result": False, "code": "UNAUTHORIZED", "message": "bad key"},
        status=401,
    )
    with pytest.raises(PionexAPIError) as exc:
        make_client().get_balances()
    assert exc.value.status_code == 401


@responses.activate
def test_non_json_response_raises():
    responses.add(
        responses.GET, f"{BASE}/api/v1/account/balances",
        body="<html>gateway error</html>", status=502,
    )
    with pytest.raises(PionexAPIError):
        make_client().get_balances()


@responses.activate
def test_get_price():
    responses.add(
        responses.GET, f"{BASE}/api/v1/market/tickers",
        json={"result": True, "data": {"tickers": [{"close": "60123.4"}]}},
    )
    assert make_client().get_price("BTC_USDT_PERP") == 60123.4


def test_to_perp_symbol():
    assert to_perp_symbol("BTCUSDT") == "BTC_USDT_PERP"
    assert to_perp_symbol("eth-usdt") == "ETH_USDT_PERP"
    assert to_perp_symbol("SOL/USDC") == "SOL_USDC_PERP"
    assert to_perp_symbol("DOGE") == "DOGE_USDT_PERP"

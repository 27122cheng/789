"""
使用者帳號監聽轉發器 (Telethon)
================================

Telegram 的機器人看不到「其他機器人」發的訊息，所以加密掃描 Pro 自動發到頻道
的信號，網站版的 bot 永遠收不到。這個程式改用「你本人的帳號」登入 (MTProto)，
你的帳號看得到頻道裡所有貼文（包括機器人發的），把每則訊息轉發到你已經做好的
Vercel 網站 (/api/ingest) 去解析、下單。

它附一個「瀏覽器登入」頁：打開網頁 → 輸入手機號 → 收到 Telegram 驗證碼 →
輸入驗證碼 → 完成。之後 session 會存檔，重開不用再登入。

需要的環境變數（部署時設定一次）：
  INGEST_URL      你的 Vercel 接收端點，例如 https://789-lovat.vercel.app/api/ingest
  ADMIN_PASSWORD  跟網站登入一樣的管理密碼（預設 123456789）
  WATCH_CHATS     （可留空）要監聽的頻道/群組/機器人，逗號分隔。
                  留空 = 監聽你所有的頻道與群組（不含個人私訊）。
  PORT            網頁埠，預設 8080（雲端主機會自動給）

api_id / api_hash 到 https://my.telegram.org → API development tools 取得，
在登入頁直接輸入即可。
"""
import asyncio
import html
import os

import aiohttp
from aiohttp import web
from telethon import TelegramClient, events
from telethon.errors import SessionPasswordNeededError
from telethon.sessions import StringSession

# Defaults are pre-filled for this project so Koyeb needs ZERO env vars:
# just deploy and log in. Override via env only if your Vercel URL differs.
INGEST_URL = os.getenv("INGEST_URL", "https://789-lovat.vercel.app/api/ingest").strip()
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD", "123456789").strip()
WATCH_CHATS = [c.strip().lstrip("@") for c in os.getenv("WATCH_CHATS", "").split(",") if c.strip()]
PORT = int(os.getenv("PORT") or "8080")  # tolerate an empty PORT env var
# The login (api creds + StringSession) is saved to Vercel KV via the
# companion site, so restarts auto-resume with no env config - log in once,
# forever. SESSION_STRING env still works as a manual override.
SESSION_STRING = os.getenv("SESSION_STRING", "").strip()

# Public Telegram Desktop api_id/api_hash (from the open-source tdesktop
# client). Used as a fallback so a user blocked by my.telegram.org's flaky
# app-creation can still log in with just a phone number. You may supply your
# own via the form if you have them.
DEFAULT_API_ID = int(os.getenv("DEFAULT_API_ID", "2040"))
DEFAULT_API_HASH = os.getenv("DEFAULT_API_HASH", "b18441a1ff607e10a989891a5462e627")
# where to load/save the persisted login (derived from INGEST_URL)
SESSION_URL = INGEST_URL.replace("/api/ingest", "/api/session")

# in-memory login/runtime state
state = {
    "client": None,      # TelegramClient once created
    "phone": None,
    "phone_code_hash": None,
    "api_id": None,
    "api_hash": None,
    "authorized": False,
    "forwarded": 0,
    "last": "",
    "error": "",
    "session_string": "",
}


def make_client(api_id: int, api_hash: str, session_str: str = "") -> TelegramClient:
    return TelegramClient(StringSession(session_str or SESSION_STRING), api_id, api_hash)


async def save_login_to_cloud(api_id: int, api_hash: str, session_str: str) -> None:
    """Persist the login to Vercel KV so restarts auto-resume."""
    headers = {"x-admin-password": ADMIN_PASSWORD, "Content-Type": "application/json"}
    payload = {"apiId": api_id, "apiHash": api_hash, "session": session_str}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(SESSION_URL, json=payload, headers=headers, timeout=20) as r:
                await r.read()
    except Exception:  # noqa: BLE001
        pass


async def load_login_from_cloud():
    """Return (api_id, api_hash, session) saved earlier, or None."""
    headers = {"x-admin-password": ADMIN_PASSWORD}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.get(SESSION_URL, headers=headers, timeout=20) as r:
                data = await r.json()
        if data.get("session") and data.get("apiId") and data.get("apiHash"):
            return int(data["apiId"]), str(data["apiHash"]), str(data["session"])
    except Exception:  # noqa: BLE001
        pass
    return None


async def remember_session(client: TelegramClient, api_id: int, api_hash: str) -> None:
    try:
        s = client.session.save()
        state["session_string"] = s
        await save_login_to_cloud(api_id, api_hash, s)
    except Exception:  # noqa: BLE001
        state["session_string"] = ""


def page(body: str) -> web.Response:
    return web.Response(
        text=f"""<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>帳號監聽登入</title>
<style>
 body{{font-family:-apple-system,"Noto Sans TC",sans-serif;background:#0d1117;color:#e6edf3;
 max-width:520px;margin:0 auto;padding:24px}}
 h1{{font-size:20px}} label{{display:block;color:#8b949e;font-size:13px;margin:12px 0 4px}}
 input{{width:100%;padding:10px;border-radius:6px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font-size:15px}}
 button{{margin-top:16px;background:#58a6ff;color:#06131f;border:0;border-radius:6px;padding:11px 18px;font-size:15px;font-weight:600}}
 .panel{{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:16px;margin-bottom:16px}}
 .ok{{color:#3fb950}} .err{{color:#f85149}} .hint{{color:#8b949e;font-size:13px}}
 code{{background:#0d1117;padding:2px 5px;border-radius:4px}}
</style></head><body>{body}</body></html>""",
        content_type="text/html",
    )


def status_body() -> str:
    watched = ", ".join(WATCH_CHATS) if WATCH_CHATS else "所有頻道與群組"
    err = f'<p class="err">錯誤：{html.escape(state["error"])}</p>' if state["error"] else ""
    persist = """<div class="panel">
  <p class="ok">🔑 登入已自動存到你的 Vercel 資料庫，之後主機重開都會自動保持登入，
  不用再做任何事。</p>
</div>"""
    return f"""<h1>✅ 已登入，監聽中</h1>
<div class="panel">
  <p class="ok">帳號已登入，正在監聽並轉發信號。</p>
  <p class="hint">監聽對象：{html.escape(watched)}</p>
  <p class="hint">已轉發訊息數：{state['forwarded']}</p>
  <p class="hint">最後一則：{html.escape(state['last'][:120]) or '（尚未收到）'}</p>
  <p class="hint">轉發目標：{html.escape(INGEST_URL) or '⚠️ 尚未設定 INGEST_URL'}</p>
  {err}
</div>
{persist}
<div class="panel hint">這個頁面開著或關掉都不影響，程式在背景持續運作。
關掉整個程式（或主機停機）才會停止監聽。</div>"""


def login_body() -> str:
    err = f'<p class="err">錯誤：{html.escape(state["error"])}</p>' if state["error"] else ""
    if state["phone_code_hash"]:
        return f"""<h1>輸入驗證碼</h1>
<div class="panel">
  <p class="hint">Telegram 已把驗證碼傳到你的手機（{html.escape(state['phone'] or '')}），
  在下方輸入。若你的帳號有開兩步驟驗證密碼，會再問一次密碼。</p>
  <form method="post" action="/code">
    <label>驗證碼</label>
    <input name="code" inputmode="numeric" autofocus placeholder="12345">
    <label>兩步驟驗證密碼（沒設就留空）</label>
    <input name="password" type="password" placeholder="沒有就不用填">
    <button type="submit">登入</button>
  </form>
  {err}
</div>"""
    return f"""<h1>登入你的 Telegram 帳號</h1>
<div class="panel">
  <p class="ok">只要填手機號就好！api_id / api_hash 留空會自動用通用預設值，
  不用去 my.telegram.org。</p>
  <p class="hint">手機號要含國碼，台灣是 <code>+886</code> 開頭，
  例如 <code>+886912345678</code>。</p>
  <form method="post" action="/start">
    <label>手機號（含國碼）★必填</label>
    <input name="phone" placeholder="+886912345678" autofocus>
    <label>api_id（可留空）</label>
    <input name="api_id" inputmode="numeric" placeholder="留空用預設">
    <label>api_hash（可留空）</label>
    <input name="api_hash" placeholder="留空用預設">
    <button type="submit">傳送驗證碼</button>
  </form>
  {err}
</div>"""


async def handle_index(request):
    if state["client"] and state["authorized"]:
        return page(status_body())
    return page(login_body())


async def handle_start(request):
    state["error"] = ""
    data = await request.post()
    try:
        api_id_raw = str(data.get("api_id", "")).strip()
        api_hash_raw = str(data.get("api_hash", "")).strip()
        phone = str(data.get("phone", "")).strip()
        # blank api_id/api_hash -> use the public Telegram Desktop credentials
        api_id = int(api_id_raw) if api_id_raw else DEFAULT_API_ID
        api_hash = api_hash_raw if api_hash_raw else DEFAULT_API_HASH
        if not phone:
            raise ValueError("請填手機號（含國碼，例如 +886912345678）")
        client = make_client(api_id, api_hash)
        await client.connect()
        sent = await client.send_code_request(phone)
        state.update(client=client, phone=phone, phone_code_hash=sent.phone_code_hash,
                     api_id=api_id, api_hash=api_hash)
    except Exception as e:  # noqa: BLE001
        state["error"] = str(e)
    raise web.HTTPFound("/")


async def handle_code(request):
    state["error"] = ""
    data = await request.post()
    code = str(data.get("code", "")).strip()
    password = str(data.get("password", "")).strip()
    client: TelegramClient = state["client"]
    try:
        try:
            await client.sign_in(state["phone"], code, phone_code_hash=state["phone_code_hash"])
        except SessionPasswordNeededError:
            if not password:
                state["error"] = "此帳號有兩步驟驗證密碼，請在密碼欄填入後再送出一次。"
                raise web.HTTPFound("/")
            await client.sign_in(password=password)
        state["authorized"] = True
        state["phone_code_hash"] = None
        await remember_session(client, state["api_id"], state["api_hash"])
        await start_watching(client)
    except web.HTTPFound:
        raise
    except Exception as e:  # noqa: BLE001
        state["error"] = str(e)
    raise web.HTTPFound("/")


async def forward_message(text: str, chat_id, message_id, ts_ms):
    if not INGEST_URL:
        state["error"] = "尚未設定 INGEST_URL 環境變數"
        return
    payload = {
        "text": text,
        "chatId": str(chat_id),
        "messageId": int(message_id),
        "timestamp": int(ts_ms),
    }
    headers = {"x-admin-password": ADMIN_PASSWORD, "Content-Type": "application/json"}
    try:
        async with aiohttp.ClientSession() as s:
            async with s.post(INGEST_URL, json=payload, headers=headers, timeout=20) as r:
                await r.read()
    except Exception as e:  # noqa: BLE001
        state["error"] = f"轉發失敗：{e}"


async def start_watching(client: TelegramClient):
    # guard against attaching handlers twice (would forward each message
    # multiple times -> duplicate trades)
    if state.get("watching"):
        return
    state["watching"] = True
    # resolve explicit watch targets, if any
    chats = None
    if WATCH_CHATS:
        resolved = []
        for c in WATCH_CHATS:
            try:
                resolved.append(await client.get_entity(int(c) if c.lstrip("-").isdigit() else c))
            except Exception:  # noqa: BLE001
                pass
        chats = resolved or None

    @client.on(events.NewMessage(chats=chats))
    @client.on(events.MessageEdited(chats=chats))
    async def _handler(event):
        # when watching everything, skip 1-on-1 private chats with real people
        if chats is None and event.is_private and not (
            getattr(event.chat, "bot", False)
        ):
            return
        text = event.message.message or ""
        if not text.strip():
            return
        state["forwarded"] += 1
        state["last"] = text
        ts = int(event.message.date.timestamp() * 1000)
        await forward_message(text, event.chat_id, event.message.id, ts)

    # ensure the client keeps running in the background
    asyncio.create_task(client.run_until_disconnected())


async def try_resume_session():
    """On startup, resume the saved login (from Vercel KV, or SESSION_STRING +
    env creds) so restarts need no re-login."""
    # 1) prefer the login persisted to Vercel KV (zero env config)
    creds = await load_login_from_cloud()
    if creds:
        api_id, api_hash, sess = creds
    else:
        # 2) fall back to env vars
        env_id = os.getenv("TELEGRAM_API_ID", "").strip()
        env_hash = os.getenv("TELEGRAM_API_HASH", "").strip()
        if not (SESSION_STRING and env_id and env_hash):
            return  # not configured yet; user logs in via the web form
        api_id, api_hash, sess = int(env_id), env_hash, SESSION_STRING
    try:
        client = make_client(api_id, api_hash, sess)
        await client.connect()
        if await client.is_user_authorized():
            state.update(client=client, authorized=True, api_id=api_id, api_hash=api_hash)
            await start_watching(client)
    except Exception as e:  # noqa: BLE001
        state["error"] = str(e)


async def main():
    app = web.Application()
    app.add_routes([
        web.get("/", handle_index),
        web.post("/start", handle_start),
        web.post("/code", handle_code),
    ])
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "0.0.0.0", PORT)
    await site.start()
    print(f"listener web UI on http://0.0.0.0:{PORT}")
    await try_resume_session()
    await asyncio.Event().wait()  # run forever


if __name__ == "__main__":
    asyncio.run(main())

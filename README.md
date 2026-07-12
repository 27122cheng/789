# Telegram → Pionex 合約自動交易

監控 Telegram 群組／頻道的交易信號（支援中英文混合格式），自動在 Pionex 執行合約交易。支援的信號動作：

| 動作 | 範例訊息 |
|------|---------|
| 建單（開倉） | `BTCUSDT LONG 10x  Entry: 60000  TP1: 61000  SL: 59000`、`幣種：ETHUSDT 方向：做空 槓桿：20倍 入場價：3200 止盈：3300，3400 止損：3100` |
| 設定止盈止損 | 開倉信號中的 TP / SL / 止盈 / 止損 會自動套用 |
| 移動止損 | `BTCUSDT 止損移至 60000`、`BTCUSDT 止損移至保本`、`move SL to 61000`；另有自動移動止損（trailing stop）可在設定啟用 |
| 修改止盈 | `BTCUSDT 止盈改為 62000, 63000` |
| 加倉 | `BTCUSDT 加倉`、`ETHUSDT add position 50 USDT` |
| 取消掛單 | `取消 BTCUSDT 掛單`、`cancel BTCUSDT orders`、`BTCUSDT 撤單` |
| 平倉 | `BTCUSDT 平倉`、`close BTCUSDT` |

無法辨識交易對的閒聊訊息會自動忽略；含「數據公布、非農、CPI、新聞、廣告」等關鍵字的訊息會被過濾（關鍵字清單可在設定頁自訂）。

本專案包含**兩種部署方式**：

1. **網站版（Vercel）**——Next.js 應用，內建設定頁（填 Telegram 機器人與 Pionex API 密鑰）與儀表板，透過 Telegram Bot webhook 接收訊息。👉 本 README 主要說明這個。
2. **Python 版（自架伺服器）**——`python-bot` 說明見文末，用 Telethon 以個人帳號監聽（不需要把機器人加進群）。程式在 `src/`。

---

## ⚠️ 重要風險聲明

- **合約交易有極高風險，可能損失全部本金。** 本程式僅為工具，不構成投資建議。
- **預設為模擬（dry-run）模式**：只解析、記錄、模擬下單。真實下單需在設定頁勾選「啟用真實下單」。
- **上線前必須核對 Pionex API 端點**：撰寫本程式的環境無法連上 Pionex 文件網站，`lib/pionex.ts`（及 Python 版 `src/pionex_client.py`）的簽名演算法按 Pionex 公開規格實作並有測試驗證，但**合約端點路徑與合約代碼格式（如 `BTC_USDT_PERP`）務必對照 [Pionex 官方 API 文件](https://pionex-doc.gitbook.io/apidocs) 驗證並先小額實測**。
- 止盈／止損／移動止損採**軟性執行**：由監控端點定期比對現價後市價平倉，而不是掛在交易所的條件單。精細度取決於監控頻率（建議每分鐘），極端行情下實際成交價可能比設定值差。
- 風控追蹤的是**本系統自己開的倉位**，不會同步你在交易所手動操作的倉位。

---

## 網站版：部署到 Vercel

### 第 1 步：把 repo 連到 Vercel

1. 到 [vercel.com](https://vercel.com) 登入（可用 GitHub 帳號）。
2. **Add New → Project**，選擇這個 GitHub repo（`27122cheng/789`）匯入。
3. Framework 會自動偵測為 Next.js，不需要改任何建置設定。

### 第 2 步：加入環境變數（Project → Settings → Environment Variables）

| 變數 | 說明 |
|------|------|
| `ADMIN_PASSWORD` | 網站管理密碼（自訂一組強密碼）。沒設定時，設定頁與 API 會拒絕存取，避免密鑰外洩。 |
| `CRON_SECRET` | 監控端點的密鑰（自訂一組隨機字串），排程呼叫時要帶 `Authorization: Bearer <CRON_SECRET>`。 |

### 第 3 步：連接 KV 儲存（必要）

Vercel 是 serverless，記憶體不會保存，設定與倉位狀態需要資料庫：

1. Vercel 專案 → **Storage** → **Create Database** → 選 **Upstash Redis**（Marketplace）。
2. 建立後 Vercel 會自動注入 `KV_REST_API_URL` / `KV_REST_API_TOKEN`（程式也支援 `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`）。
3. 重新部署一次。儀表板若顯示「尚未連接 KV 儲存」警告代表這步沒完成。

### 第 4 步：建立 Telegram 機器人並設定

1. 在 Telegram 找 **@BotFather** → `/newbot` 建立機器人，取得 **bot token**。
2. 對 BotFather 用 `/setprivacy` → 選你的機器人 → **Disable**（否則機器人在群組收不到一般訊息）。
3. 把機器人加入信號**群組**；若是**頻道**則要把機器人設為頻道管理員。
4. 打開你的網站 `https://<你的專案>.vercel.app/settings`，輸入 `ADMIN_PASSWORD` 登入：
   - 填入 **Bot Token** 與**監聽的群組／頻道**（username 或數字 chat id，逗號分隔）
   - 填入 **Pionex API Key / Secret**（Pionex → API 管理建立；只開交易權限、不要開提現）
   - 按「儲存設定」
   - 按「**註冊 Telegram Webhook**」——這會呼叫 Telegram `setWebhook`，之後群組訊息就會即時推送到網站
5. 取得群組數字 id 的方法：把 [@userinfobot](https://t.me/userinfobot) 或 @getidsbot 加進群組，或先填群組 username 即可。

### 第 5 步：設定監控排程（移動止損與軟性 SL/TP 需要）

**注意：專案刻意不用 Vercel 內建 Cron**——免費（Hobby）方案不允許低於每天一次的排程，在 `vercel.json` 宣告每分鐘 Cron 甚至會讓整個部署被拒絕。請用免費的外部排程服務（[cron-job.org](https://cron-job.org)、UptimeRobot 等）每分鐘呼叫：

```
GET https://<你的專案>.vercel.app/api/cron/monitor
Header:  Authorization: Bearer <你的 CRON_SECRET>
```

（若你使用 Vercel Pro，也可以自行在 vercel.json 加回 crons 設定，Vercel 會自動帶上 CRON_SECRET。）

### 第 6 步：驗證後再開真倉

1. 保持「啟用真實下單」**不勾選**，讓信號跑幾天模擬。
2. 在儀表板（`/`）觀察：訊息是否正確解析、過濾是否擋掉了新聞、模擬倉位與 SL/TP 追蹤是否符合預期。
3. 都確認後再到設定頁勾選「⚠️ 啟用真實下單」。

---

## 網站版功能總覽

- **儀表板 `/`**：執行模式（模擬/真實）、目前持倉（均價、數量、SL/TP、加倉次數）、訂單/動作紀錄、每則收到訊息的判定結果（信號/已過濾/非信號）。
- **設定頁 `/settings`**：Telegram 機器人與群組、Pionex API 密鑰（儲存後遮罩顯示）、部位大小（固定 USDT／餘額百分比／依信號）、加倉金額、槓桿預設與上限、進場單類型（市價/限價）、移動止損參數、白/黑名單、最大持倉數、加倉次數上限、冷卻時間、信號時效、忽略關鍵字。
- **API**：
  - `POST /api/telegram/webhook` — Telegram 推送（以 secret token 驗證）
  - `GET/POST /api/settings`、`GET /api/state` — 需 `x-admin-password` 標頭
  - `POST /api/setup-webhook` — 註冊 Telegram webhook
  - `GET /api/cron/monitor` — 監控 tick（trailing stop + 軟性 SL/TP），需 `Authorization: Bearer <CRON_SECRET>`

### 本機開發

```bash
npm install
ADMIN_PASSWORD=dev CRON_SECRET=dev npm run dev   # http://localhost:3000
npm test          # vitest（解析器、簽名、executor 整合測試）
npm run build     # production build
```

---

## Python 版（自架伺服器，Telethon 個人帳號監聽）

適合你有 24 小時開機的機器（VPS、樹莓派）且不想把機器人加進群組的情況。以你的 Telegram 個人帳號登入，可監聽任何你已加入的頻道。

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env                              # 填 Telegram api_id/hash 與 Pionex 密鑰
cp config/settings.example.yaml config/settings.yaml
python -m src.main          # 模擬模式
python -m src.main --live   # 真實下單（另需 .env 中 LIVE_TRADING=true）
python -m pytest tests/ -v  # 測試
```

Telegram API 憑證到 <https://my.telegram.org> → API development tools 建立。詳細設定項見 `config/settings.example.yaml` 內的註解。信號與訂單記錄在 SQLite（預設 `data/trading.db`）。

注意：Python 版目前不含網站版新增的加倉／取消掛單／移動止損動作與軟性 SL/TP 監控；如果你要用這些功能，請部署網站版。

---

## 專案結構

```
app/                       # Next.js（網站版）
  page.tsx                 #   儀表板
  settings/page.tsx        #   設定頁
  api/telegram/webhook/    #   Telegram webhook 接收
  api/settings/            #   設定 CRUD（密鑰遮罩）
  api/state/               #   儀表板資料
  api/setup-webhook/       #   註冊 Telegram webhook
  api/cron/monitor/        #   監控 tick（trailing stop、軟性 SL/TP）
lib/                       # 網站版核心
  parser.ts                #   信號解析（7 種動作 + 噪音過濾）
  pionex.ts                #   Pionex REST 客戶端（HMAC-SHA256）
  executor.ts              #   信號執行 + 倉位追蹤 + 監控
  store.ts                 #   Upstash Redis / 記憶體 KV
  types.ts                 #   型別與預設設定
  __tests__/               #   vitest
src/                       # Python 版（Telethon 常駐監聽）
tests/                     # Python 版 pytest
config/settings.example.yaml
vercel.json                # Vercel Cron 宣告
```

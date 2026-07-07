# Telegram → Pionex 合約自動交易機器人

監控指定的 Telegram 頻道／群組，解析交易信號（支援中英文混合格式），依照設定檔計算部位大小並通過風控檢查後，自動在 Pionex 下永續合約單。

```
Telegram 頻道 ──> 信號解析器 ──> 部位計算 ──> 風控檢查 ──> Pionex 下單
                     │                                        │
                     └────────────── SQLite 記錄 ──────────────┘
```

## ⚠️ 重要風險聲明

- **合約交易有極高風險，可能損失全部本金。** 本程式僅為工具，不構成投資建議；使用者須自行承擔全部交易結果。
- **預設為 dry-run（模擬）模式**：只解析信號、模擬下單並寫入紀錄，不會送出真實訂單。真實下單需要 **同時** 在 `.env` 設 `LIVE_TRADING=true` **且** 啟動時加 `--live` 參數。
- **上線前必須核對 Pionex API 端點**：撰寫本程式的環境無法連上 Pionex 文件網站，`src/pionex_client.py` 中的簽名演算法與端點路徑（`/api/v1/trade/order` 等）依照 Pionex 已公開的 v1 API 規格實作，但**永續合約的端點路徑、合約代碼格式（如 `BTC_USDT_PERP`）、槓桿設定與 TP/SL 掛單方式，務必先對照 [Pionex 官方 API 文件](https://pionex-doc.gitbook.io/apidocs) 驗證並實測小額**。所有路徑都做成 `PionexClient` 建構參數，可直接修正而不用改程式邏輯。
- 目前已知限制（程式會誠實記錄而不是假裝成功）：
  - **交易所端 SL/TP 掛單尚未實作**——信號中的止盈止損價位會寫入資料庫供參考，但不會自動掛到交易所；需自行管理出場或擴充 `PionexClient`。
  - **自動平倉（close 信號）尚未實作**——需要 Pionex 合約持倉查詢端點才能知道平倉數量。
  - **槓桿設定**未通過 API 送出（Pionex 公開 API 未提供對應端點時），實際槓桿以你在 Pionex 帳戶中的設定為準。
  - 風控的持倉計數是**本機器人自身**開的倉位，不會同步你在交易所手動開的倉。

## 安裝

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

## 設定

### 1. Telegram API

1. 到 <https://my.telegram.org> → API development tools，建立應用取得 `api_id` 和 `api_hash`。
2. 這是以**你的使用者帳號**登入（Telethon），所以可以監聽你已加入的任何頻道／群組，不需要把 bot 拉進群。

### 2. Pionex API Key

到 Pionex App／網頁的 API 管理建立 API Key，**只開啟交易權限、不要開啟提現權限**，並妥善保管 secret。

### 3. 環境變數

```bash
cp .env.example .env
# 編輯 .env 填入上面取得的憑證
```

`TELEGRAM_CHAT_IDS` 填要監聽的頻道 username（不含 @）或數字 chat id，逗號分隔，例如：

```
TELEGRAM_CHAT_IDS=mysignalchannel,-1001234567890
```

### 4. 交易參數

```bash
cp config/settings.example.yaml config/settings.yaml
# 編輯 config/settings.yaml
```

可設定：

| 區塊 | 內容 |
|------|------|
| `position_sizing` | 部位大小模式：`fixed_usdt`（每筆固定 USDT）、`percent_balance`（餘額百分比）、`signal`（信號指定金額，無則 fallback） |
| `leverage` | 預設槓桿與槓桿上限（信號要求超過上限會被壓到上限） |
| `risk` | 幣種白名單／黑名單、最大同時持倉數、單幣種持倉上限、每日虧損上限、同幣種下單冷卻秒數、信號最大時效 |
| `orders` | 進場單類型（market/limit）、是否附加 SL/TP、多目標止盈是否分批 |
| `parser` | 為特定頻道補充自訂的多／空／平倉關鍵字 |

## 支援的信號格式

解析器對格式相當寬鬆，中英文、全形半形皆可。範例：

```
BTCUSDT LONG 10x
Entry: 60000-60500
TP1: 61000
TP2: 62500
SL: 59000
```

```
幣種：ETHUSDT
方向：做空
槓桿：20倍
入場價：3200
止盈：3300，3400
止損：3100
```

平倉信號：`BTCUSDT 平仓` / `BTCUSDT close position`。

無法辨識交易對的訊息會被直接忽略；缺少方向（多/空）的開倉信號會被標記為不可執行並跳過。頻道編輯過的訊息會被視為新信號重新解析（可在設定關閉）。

## 執行

```bash
# 模擬模式（預設，建議先跑幾天觀察解析與決策是否正確）
python -m src.main

# 真實下單（需要 .env 中 LIVE_TRADING=true）
python -m src.main --live

# 除錯輸出
python -m src.main -v
```

第一次執行會要求輸入 Telegram 手機號碼與驗證碼登入，之後會存成 `.session` 檔自動重連。

所有收到的信號與下單（含模擬）結果都會寫入 SQLite（預設 `data/trading.db`），可用來稽核：

```bash
sqlite3 data/trading.db 'SELECT received_at, symbol, side, action FROM signals ORDER BY id DESC LIMIT 20;'
sqlite3 data/trading.db 'SELECT created_at, symbol, side, size_usdt, dry_run, success, message FROM orders ORDER BY id DESC LIMIT 20;'
```

## 測試

```bash
python -m pytest tests/ -v
```

測試涵蓋信號解析（中英文格式）、部位計算、風控規則、Pionex 簽名（mock HTTP，不打真實 API）與 executor 的 dry-run／live 行為。

## 專案結構

```
src/
  main.py               # 進入點，--live / --env-file / -v
  config.py             # .env + settings.yaml 載入與驗證 (pydantic)
  telegram_listener.py  # Telethon 監聽器
  signal_parser.py      # 中英文信號解析（regex，可加自訂關鍵字）
  models.py             # TradeSignal / OrderPlan / OrderResult
  position_sizer.py     # 部位大小與槓桿計算
  risk_manager.py       # 下單前風控檢查（純函式，無 I/O）
  executor.py           # 串接：信號 → 風控 → 下單（dry-run / live）
  pionex_client.py      # Pionex REST 客戶端（HMAC-SHA256 簽名）
  storage.py            # SQLite 信號／訂單紀錄
config/
  settings.example.yaml # 交易參數範本
tests/                  # pytest 測試
```

# 帳號監聽轉發器（讀取機器人自動發的信號）

## 為什麼需要它

Telegram 規定「機器人看不到其他機器人發的訊息」，所以加密掃描 Pro 自動發到頻道的
信號，網站版永遠收不到（你自己手動貼的可以，因為那是「人」發的）。

這個小程式改用 **你本人的帳號** 登入，你的帳號看得到頻道裡所有貼文（包括機器人發的），
把每則信號轉發到你已經做好的 Vercel 網站去解析、下單。**網站那邊完全不用改**，
你的設定、Pionex 金鑰、儀表板照舊。

登入只需要在網頁輸入手機號 + 收到的驗證碼，不用打指令。

---

## 你只需要準備一樣東西：api_id / api_hash

到 <https://my.telegram.org> → 用你的 Telegram 登入 → **API development tools** →
建立一個 App（名稱隨便填）→ 記下 **api_id**（一串數字）和 **api_hash**（一串英數）。
登入頁會用到。

---

## 方式一（推薦，不用裝 Python）：雲端主機，全程瀏覽器操作

跟你部署 Vercel 很像：從 GitHub 匯入 → 設環境變數 → 部署 → 開網址登入。
需要一個「支援常駐 + Docker、有公開網址」的主機。推薦 **Koyeb**（有免費方案、
不會自動休眠、可從 GitHub 用 Dockerfile 部署）。Render、Fly.io 亦可。

1. 到 <https://www.koyeb.com> 用 GitHub 登入註冊。
2. **Create Web Service** → **GitHub** → 選這個 repo。
3. 重點設定：
   - **Work directory / Root**：填 `listener`
   - **Builder**：選 **Dockerfile**
   - **Port**：`8080`
4. **Environment variables** 加入：
   - `INGEST_URL` = `https://你的專案.vercel.app/api/ingest`（換成你的 Vercel 網址）
   - `ADMIN_PASSWORD` = 你的網站管理密碼（預設 `123456789`）
   - `WATCH_CHATS`（可留空）= 要監聽的頻道/群組/機器人，逗號分隔；留空 = 所有頻道與群組
5. **Deploy**，完成後打開該服務的公開網址（Koyeb 會給一個 `xxx.koyeb.app`）。
6. 在登入頁輸入 **api_id / api_hash / 手機號** → 傳送驗證碼 → 輸入 Telegram 傳來的
   驗證碼（有兩步驟密碼就一起填）→ 顯示「✅ 已登入，監聽中」。
7. **讓重開機免再登入**：登入成功後頁面會顯示一段 `SESSION_STRING`，把它複製到
   Koyeb 的環境變數（連同 `TELEGRAM_API_ID`、`TELEGRAM_API_HASH` 一起加），
   重新部署一次，之後主機重啟都會自動保持登入。
8. 讓加密掃描 Pro 發一則信號，回 Vercel 儀表板看「收到的訊息」有沒有出現。

---

## 方式二：跑在你自己的電腦（需要 Python；電腦要開著）

只有電腦開機且程式在跑時才接信號，適合先快速驗證。

1. 安裝 Python 3（Windows：python.org 下載，安裝時勾「Add to PATH」）
2. 進 `listener` 資料夾，執行 `pip install -r requirements.txt`
3. 啟動（把網址換成你的）：
   ```bash
   INGEST_URL="https://789-lovat.vercel.app/api/ingest" ADMIN_PASSWORD="123456789" python3 app.py
   ```
   Windows PowerShell 先 `$env:INGEST_URL="..."` 再 `python app.py`。
4. 瀏覽器打開 <http://localhost:8080> 完成登入（同上第 6 步）。

> 小提醒：這是用你本人的帳號自動化，屬個人使用。請勿分享登入後的網址，
> 且 Pionex API 金鑰務必只開交易、不開提現。

---

## 常見問題

- **要監聽哪個對象？** 你可以監聽你的頻道「我的交易信號」，或直接監聽與加密掃描 Pro
  的私訊對話（把它的 username 填進 `WATCH_CHATS`）。留空則自動監聽所有頻道與群組。
- **會不會把我的私人訊息也送出去？** 不會。`WATCH_CHATS` 留空時，程式自動略過
  與真人的一對一私訊，只轉發頻道／群組（和機器人）的訊息。
- **登入一次後還要再登入嗎？** 不用，session 會存檔；除非你登出或刪掉 session 檔。

# SignalDesk — GitHub Pages 乾淨部署清單

> 核心三原則(每次更新都做,就不會再「只更新一半」):
> 1. **整包覆蓋**所有檔案(唯一例外:`config.js`,見下)
> 2. **確認 `sw.js` 版本號有變**(我每次出新版都會 bump,例如 v24 → v25)
> 3. **push 後:等 CDN → Unregister SW → Ctrl+Shift+R**

---

## 一次性設定(只做一次)

**A. Repo 結構**（GitHub Pages 服務的根目錄 = `us-stock/`）

```
your-repo/
└─ us-stock/
   ├─ index.html
   ├─ manifest.json
   ├─ sw.js
   ├─ css/styles.css
   ├─ js/            ← 12 個 .js,整個資料夾
   └─ icons/         ← 3 個 png
```

> `worker/signaldesk-worker.js` **不放這裡也沒關係**——它是部署到 **Cloudflare Worker**,不是 GitHub Pages。可留在 repo 當備份,但 GitHub Pages 不會用它。

**B. GitHub Pages 設定**：repo → Settings → Pages → Source 選你的分支 + 根目錄 → Save。網址會是 `https://<你>.github.io/us-stock/`。

**C. `config.js` 設定一次,之後別亂動**（這是你的個人設定檔）：
```js
WORKER_URL: 'https://stock.marschannewtag.workers.dev',  // ← 一定要填!空的 = 抓不到資料
USE_REAL_DATA: true,
PRICE_MIN: 6,
PRICE_MAX: 666,
DAILY_PRESET: 'composite',
BATCH_GAP_MS: 60000,   // 免費層 8檔/分;買了 Grow 改成 0 秒抓
```

**D. Cloudflare Worker**（跟 GitHub Pages 分開,獨立部署一次）：
Worker 貼好 `signaldesk-worker.js` + 設好三個 secret：`TD_API_KEY`、`TIINGO_KEY`、`FMP_API_KEY`。這個很少要動,只有我改 Worker 時才重貼。

---

## 每次更新的 SOP（照順序做,別跳步）

**1. 解壓我給的新 zip。**

**2. 處理 `config.js`（關鍵!）**
- **預設:不要覆蓋你 repo 裡的 `config.js`**——保住你的 `WORKER_URL`。
- **例外:只有當我明說「這次改了 config」時**(例如改價格帶、preset),你才需要更新 config——這時**手動改那幾行**,別整檔蓋掉(不然 WORKER_URL 會被清空)。

**3. 整包覆蓋其他所有檔案到 repo 的 `us-stock/`**
- `index.html`、`manifest.json`、`sw.js`、`css/`、`icons/`,以及 **`js/` 底下全部 12 個檔**。
- ⚠️ **最容易出錯的地方:`js/` 要整個資料夾覆蓋**。你上次就是漏了 `js/strategy.js`,導致 sw 是新的、邏輯是舊的。**寧可整包重傳,不要挑檔案傳。**

**4. push 到 GitHub**
```
git add -A
git commit -m "update to vXX"
git push
```
（或用 GitHub 網頁把整包拖上去覆蓋。）

**5. 等 GitHub Pages CDN 生效:1~5 分鐘**（不是即時,別急著測)。

**6. 清瀏覽器的舊 Service Worker**
- F12 → Application → Service Workers → **Unregister**
- 然後 **Ctrl+Shift+R**
- ❌ **絕對不要按「Clear site data」**——會清掉你的 16 年歷史 + paper trading 紀錄。

---

## 部署後驗證（30 秒,每次都做）

**驗證一:sw 版本對不對**
F12 → Console：
```js
caches.keys().then(console.log)
```
→ 應顯示最新版本號（例如 `['signaldesk-v25']`)。

**驗證二:實際邏輯有沒有上去（這是你上次的坑）**
新分頁直接開:
```
https://<你>.github.io/us-stock/js/strategy.js
```
Ctrl+F 搜一個「這版才有」的關鍵字（例如某個新函式名),搜得到 = 邏輯真的上去了。
> 只驗 `sw.js` 版本**不夠**——它對了不代表 `js/` 底下的檔也上去了。兩個都要驗。

---

## 症狀對照(出事時查這裡)

| 症狀 | 病因 | 解法 |
|---|---|---|
| `caches.keys()` 是舊版 | sw.js 沒 push 或 CDN 沒生效 | 等幾分鐘 + Unregister + 硬重整 |
| sw 版本對,但行為是舊的 | **`js/` 某些檔沒 push(只更新一半)** | 整個 `js/` 資料夾重新覆蓋 push |
| App 抓不到資料、一片空白 | `config.js` 的 `WORKER_URL` 被清空了 | 把 WORKER_URL 填回去 |
| 選股價格帶沒作用 | `config.js` 的 PRICE_MIN/MAX 被舊檔蓋掉 | 改回 6 / 666 |
| 某些股票 502 | Twelve Data 瞬間失敗(非你的問題) | 按「更新」重試,或忽略 |

---

## 一句話記住

**「js 整包覆蓋、config 別亂動、sw 版本要變、Unregister 一定做。」**
你上次的 bug 就是漏了「js 整包覆蓋」——只要每次都整個 `js/` 資料夾重傳,就不會再發生。

# SignalDesk · 美股板塊輪動訊號 PWA(基礎架構)

每日告訴你「買哪檔、賣哪檔、價格多少」,最多 6 倉,順著當下最熱的板塊選股。
這是**可安裝、可離線的 PWA 骨架**,刻意把資料來源、策略、回測拆成獨立模組,
方便你之後一塊一塊強化。

---

## 一、需求對照(你提的 7 點)

| # | 需求 | 在哪實作 | 現況 |
|---|------|----------|------|
| 1 | 永遠不超過 6 倉 | `strategy.js` `MAX_POSITIONS` + `portfolio.js` `buy()` 硬擋 | ✅ 完成 |
| 2 | 每天更新買哪檔+價格 | `strategy.js` `generateBuys()` → 今日分頁 | ✅ 完成 |
| 3 | 每天更新賣哪倉+價格 | `strategy.js` `generateSells()` → 今日分頁 | ✅ 完成 |
| 4 | 選最熱板塊並從中選股 | `sectors.js` `rankSectors()` → 板塊分頁 | ✅ 完成 |
| 5 | 長期驗證+回測會賺 | `backtest.js` 引擎已就緒 | ⚠️ 引擎完成,**但需餵真實資料** |
| 6 | 接受大回撤、要高報酬 | 參數偏動能(寬停損+移動停利) | ✅ 框架完成,需回測調參 |
| 7 | 先做基本架構,之後強化 | 全模組化、可單獨抽換 | ✅ 這就是本版本 |

> **誠實提醒(以你做 MQL5 的標準你會認同):** 第 5、6 點不是「寫好 App」就成立的。
> 目前回測跑的是**合成假資料**,只證明「整套流程跑得通、邏輯沒 bug」。
> 要真正回答「長期賺不賺、報酬夠不夠高」,必須換上真實歷史日線,切樣本外,
> 再跑你慣用的 Monte Carlo(多年、數百次、曲線全正才接受)。架構已經幫你留好接口。

---

## 二、怎麼跑起來

Service Worker 與 ES Module 不能用 `file://` 直接開,要用一個本地伺服器:

```bash
cd app
python3 -m http.server 8000
# 瀏覽器開 http://localhost:8000
```

手機/桌面瀏覽器選「加入主畫面 / 安裝應用程式」即可當 App 用,可離線開啟。

**部署上線**(免費):直接把 `app/` 整個資料夾丟到 GitHub Pages、Netlify 或 Vercel。
PWA 需要 HTTPS,這三家都自帶。

---

## 三、架構地圖(每塊都能單獨換)

```
app/
├── index.html         UI 殼層 + 底部 4 分頁
├── css/styles.css     交易終端機風格
├── js/
│   ├── data.js        ★資料層:股票池 + MockDataAdapter(換真實 API 改這裡)
│   ├── sectors.js     板塊熱度排名(需求4)
│   ├── strategy.js    ★策略核心:買賣訊號 + 6 倉上限(你最該強化這裡)
│   ├── portfolio.js   持倉管理 + localStorage 儲存
│   ├── backtest.js    回測引擎(需求5)
│   └── app.js         UI 主控,把上面串起來
├── manifest.json      PWA 設定(可安裝)
└── sw.js              Service Worker(離線快取)
```

資料流:`data.js` → `sectors.js`(排板塊)→ `strategy.js`(選股+出場)→ `app.js`(畫面)。
UI 完全不碰策略邏輯,所以你改策略時不會動到畫面,反之亦然。

---

## 四、把假資料換成真實行情(需求 5 的關鍵一步)

打開 `js/data.js`,照 `MockDataAdapter` 的同樣方法做一個新 class:

```js
export class FmpAdapter {
  constructor(apiKey) { this.key = apiKey; }
  async getSectorETFs() { /* 抓 XLK,XLF,...11 檔 ETF 的 1M/3M 報酬 */ }
  async getQuotes()     { /* 抓股票池每檔的價格、均線、報酬 */ }
  async getHistorical(symbol, days) { /* 抓歷史日線,回測用 */ }
}
```

然後在 `app.js` 把 `new MockDataAdapter()` 換成 `new FmpAdapter(你的key)`,UI 一行都不用改。

推薦的美股 API(都有免費額度):**Financial Modeling Prep、Finnhub、Twelve Data、Polygon、Alpha Vantage**。
板塊熱度直接抓 11 檔 SPDR ETF 的報酬率最乾淨,不用自己合成。

> 注意:`getQuotes`/`getHistorical` 改成 `async` 後,`app.js` 裡呼叫處要加 `await`。
> 另外真實 API 請求在 `sw.js` 應改成 network-first(避免吃到舊快取)。

---

## 五、調參數的地方(需求 6:大回撤換高報酬)

全部集中在 `js/strategy.js` 的 `STRATEGY_PARAMS`:

| 參數 | 預設 | 意義 |
|------|------|------|
| `hotSectorCount` | 3 | 幾名內算熱門板塊 |
| `stopLossPct` | -18% | 硬停損(放寬=容忍大回撤) |
| `trailingStopPct` | -12% | 自高點回落多少觸發移動停利(讓獲利奔跑) |
| `sectorExitRank` | 5 | 持倉板塊掉出前幾名就出場 |
| `requireAboveMA20` | true | 買進需站上 20 日均線 |

板塊排名權重在 `js/sectors.js` 的 `SECTOR_WEIGHTS`。

---

## 六、建議的強化順序

1. **接真實資料**(`data.js`)— 沒這步,5/6 都是空談。
2. **回測拉長 + 樣本外 + Monte Carlo**(`backtest.js`)— 套用你 MQL5 那套驗證標準。
3. **訊號邏輯升級**(`strategy.js`)— 加成交量、相對強弱(RS)、波動度過濾、部位加碼。
4. **自動每日更新** — 真實版把「下一日」按鈕換成每天定時抓 API + 推播通知。
5. **交易成本** — 回測加入手續費/滑價,報酬才真實。

需要哪一步,直接跟我說,我們一塊一塊往上疊。

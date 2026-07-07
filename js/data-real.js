// =============================================================
// data-real.js — 真實資料層(Twelve Data,透過你的 Worker)
// -------------------------------------------------------------
// 對外介面跟 MockDataAdapter 完全一樣:
//   getUniverse() / getQuotes() / getSectorETFs() / getHistorical()
// 所以 sectors.js / strategy.js / app.js 都不用改。
//
// 流程:
//   1. ensureLoaded():把 11 檔板塊 ETF + 43 檔股票的日線抓回來,
//      依免費層限制分批(每批 8 檔、間隔 60 秒),抓完存 localStorage。
//   2. 同一天再開 App -> 直接讀 localStorage 快取,不重打 API。
//   3. getQuotes / getSectorETFs 從快取算出跟 mock 一樣的指標欄位。
// =============================================================

import { SECTORS, UNIVERSE } from './data.js';
import { atr } from './indicators.js';

const CACHE_PREFIX = 'td_ohlc_';             // localStorage key 前綴(OHLC 版,舊快取自動失效重抓)
const todayKey = () => CACHE_PREFIX + new Date().toISOString().slice(0, 10);

// 要抓的全部代號 = 11 板塊 ETF + 43 股票 + SPY(市場水位趨勢腿用)
const ALL_SYMBOLS = [...SECTORS.map((s) => s.etf), ...UNIVERSE.map((u) => u.symbol), 'SPY'];

export class RealDataAdapter {
  constructor(config) {
    this.cfg = config;
    this.series = {};          // { SYMBOL: number[] }  收盤價(舊->新)
    this.loaded = false;
  }

  // ---- 從 localStorage 載入今天的快取(有的話)----
  _loadCache() {
    try {
      const raw = localStorage.getItem(todayKey());
      if (raw) { this.series = JSON.parse(raw); return true; }
    } catch (e) { /* ignore */ }
    return false;
  }

  _saveCache() {
    try { localStorage.setItem(todayKey(), JSON.stringify(this.series)); } catch (e) { /* quota */ }
    // 順手清掉舊日期的快取,避免塞爆 localStorage
    try {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith(CACHE_PREFIX) && k !== todayKey()) localStorage.removeItem(k);
      }
    } catch (e) { /* ignore */ }
  }

  // ---- 確保資料就緒;onProgress(done, total, phase) 用來更新進度條 ----
  async ensureLoaded(onProgress) {
    if (this.loaded) return;
    if (!this.cfg.WORKER_URL) {
      throw new Error('尚未設定 WORKER_URL(請先部署 Worker,再填到 config.js)');
    }

    // 先吃快取,只補還沒有的代號
    this._loadCache();
    const missing = ALL_SYMBOLS.filter((s) => !this.series[s] || this.series[s].length === 0);

    if (missing.length === 0) { this.loaded = true; return; }

    const { BATCH_SIZE, BATCH_GAP_MS, OUTPUT_SIZE, WORKER_URL } = this.cfg;
    let done = ALL_SYMBOLS.length - missing.length;

    for (let i = 0; i < missing.length; i += BATCH_SIZE) {
      const batch = missing.slice(i, i + BATCH_SIZE);
      const u = `${WORKER_URL.replace(/\/$/, '')}/timeseries`
        + `?symbols=${encodeURIComponent(batch.join(','))}&outputsize=${OUTPUT_SIZE}`;

      const resp = await fetch(u);
      const data = await resp.json();
      if (data.error) {
        throw new Error(`資料讀取失敗:${data.message || data.error}${data.code ? ' (code ' + data.code + ')' : ''}`);
      }

      for (const sym of batch) {
        const values = (data[sym] && data[sym].values) || [];
        // order=ASC:舊->新;存 OHLC(ATR 需要 high/low)
        this.series[sym] = values
          .map((v) => ({ h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close) }))
          .filter((b) => !isNaN(b.c) && !isNaN(b.h) && !isNaN(b.l));
      }
      this._saveCache();

      done += batch.length;
      if (onProgress) onProgress(done, ALL_SYMBOLS.length, 'loading');

      // 還有下一批 -> 等節流時間(免費層每分鐘 8 檔)
      if (i + BATCH_SIZE < missing.length && BATCH_GAP_MS > 0) {
        if (onProgress) onProgress(done, ALL_SYMBOLS.length, 'waiting');
        await sleep(BATCH_GAP_MS);
      }
    }
    this.loaded = true;
  }

  // ---- 從 OHLC 序列算出指標(含 ATR)----
  _metrics(bars) {
    const closes = bars.map((b) => b.c);
    const last = closes[closes.length - 1];
    const prev = closes[closes.length - 2] ?? last;
    const ma = (k) => {
      const s = closes.slice(-k);
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    const ret = (k) => {
      const past = closes[closes.length - 1 - k];
      return past ? (last - past) / past : 0;
    };
    const ma20 = ma(20), ma50 = ma(50);
    const a = atr(bars, 14);
    return {
      price: last, prevClose: prev, changePct: (last - prev) / prev,
      ma20, ma50,
      relMA20: (last - ma20) / ma20, relMA50: (last - ma50) / ma50,
      ret1m: ret(21), ret3m: ret(63),
      atr: a, atrPct: a ? a / last : null,
    };
  }

  // ===== 對外介面(跟 MockDataAdapter 相同)=====
  getUniverse() { return UNIVERSE; }

  async getQuotes() {
    await this.ensureLoaded();
    return UNIVERSE
      .filter((u) => this.series[u.symbol] && this.series[u.symbol].length >= 63)
      .map((u) => ({ symbol: u.symbol, name: u.name, etf: u.etf, ...this._metrics(this.series[u.symbol]) }));
  }

  async getSectorETFs() {
    await this.ensureLoaded();
    return SECTORS
      .filter((s) => this.series[s.etf] && this.series[s.etf].length >= 63)
      .map((s) => {
        const m = this._metrics(this.series[s.etf]);
        return { etf: s.etf, name: s.name, ret1m: m.ret1m, ret3m: m.ret3m, relMA50: m.relMA50 };
      });
  }

  async getHistorical(symbol, days = 252) {
    await this.ensureLoaded();
    // 回傳收盤價陣列(回測用)
    return (this.series[symbol] || []).map((b) => b.c).slice(-days);
  }

  // 強制重抓:清掉今天的快取,下次 ensureLoaded 會重新拉
  forceRefresh() {
    try { localStorage.removeItem(todayKey()); } catch (e) { /* ignore */ }
    this.series = {};
    this.loaded = false;
    this._vixTried = false;
  }

  // ---- 市場水位資料:SPY(必有)+ VIX(盡力,免費層可能沒有)----
  async getMarketSeries() {
    await this.ensureLoaded();
    const vix = await this._ensureVix();
    const spy = (this.series['SPY'] || []).map((b) => b.c); // market.js 只需要收盤
    return { spy, vix };
  }

  // VIX 盡力抓一次;免費層抓不到就靜默回 null,由 market.js 改用替代波動
  async _ensureVix() {
    if (this.series['VIX'] && this.series['VIX'].length) return this.series['VIX'];
    if (this._vixTried) return null;
    this._vixTried = true;
    try {
      const u = `${this.cfg.WORKER_URL.replace(/\/$/, '')}/timeseries?symbols=VIX&outputsize=${this.cfg.OUTPUT_SIZE}`;
      const r = await fetch(u);
      const d = await r.json();
      if (!d.error && d.VIX && d.VIX.values && d.VIX.values.length) {
        this.series['VIX'] = d.VIX.values.map((v) => parseFloat(v.close)).filter((n) => !isNaN(n));
        this._saveCache();
        return this.series['VIX'];
      }
    } catch (e) { /* VIX 免費層可能沒有,退回替代方案 */ }
    return null;
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

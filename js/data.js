// =============================================================
// data.js — 資料層 (Data Layer)
// -------------------------------------------------------------
// 這一層把「資料從哪裡來」跟「策略怎麼用資料」完全隔開。
// 想換成真實行情，只要實作 DataAdapter 介面，UI / 策略全部不用動。
//
// DataAdapter 介面 (你之後要接真實 API 就照這個實作):
//   getUniverse()                -> Symbol[]   股票池(含所屬板塊)
//   getQuotes()                  -> Quote[]    今日所有標的的快照
//   getSectorETFs()              -> SectorETF[] 11 個 SPDR 板塊 ETF 的表現
//   getHistorical(symbol, days)  -> Bar[]      回測用歷史日線
//   advanceDay()                 -> void       (僅模擬器需要) 推進到下一個交易日
// =============================================================

// ---- 11 個 SPDR 板塊 ETF (美股板塊輪動的標準分類) ----
export const SECTORS = [
  { etf: 'XLK', name: '科技 Technology' },
  { etf: 'XLF', name: '金融 Financials' },
  { etf: 'XLE', name: '能源 Energy' },
  { etf: 'XLV', name: '醫療 Health Care' },
  { etf: 'XLY', name: '非必需消費 Consumer Disc.' },
  { etf: 'XLP', name: '必需消費 Consumer Staples' },
  { etf: 'XLI', name: '工業 Industrials' },
  { etf: 'XLB', name: '原物料 Materials' },
  { etf: 'XLRE', name: '不動產 Real Estate' },
  { etf: 'XLU', name: '公用事業 Utilities' },
  { etf: 'XLC', name: '通訊 Communication' },
];

// ---- 股票池: 各板塊代表性大型權值股 (流動性高，方便起步) ----
// 之後你可以改成「抓該板塊 ETF 的前 N 大成分股」自動產生。
export const UNIVERSE = [
  // XLK
  { symbol: 'AAPL', name: 'Apple', etf: 'XLK' },
  { symbol: 'MSFT', name: 'Microsoft', etf: 'XLK' },
  { symbol: 'NVDA', name: 'Nvidia', etf: 'XLK' },
  { symbol: 'AVGO', name: 'Broadcom', etf: 'XLK' },
  { symbol: 'AMD', name: 'AMD', etf: 'XLK' },
  { symbol: 'CRM', name: 'Salesforce', etf: 'XLK' },
  // XLF
  { symbol: 'JPM', name: 'JPMorgan', etf: 'XLF' },
  { symbol: 'BAC', name: 'Bank of America', etf: 'XLF' },
  { symbol: 'GS', name: 'Goldman Sachs', etf: 'XLF' },
  { symbol: 'V', name: 'Visa', etf: 'XLF' },
  { symbol: 'MA', name: 'Mastercard', etf: 'XLF' },
  // XLE
  { symbol: 'XOM', name: 'Exxon Mobil', etf: 'XLE' },
  { symbol: 'CVX', name: 'Chevron', etf: 'XLE' },
  { symbol: 'COP', name: 'ConocoPhillips', etf: 'XLE' },
  { symbol: 'SLB', name: 'Schlumberger', etf: 'XLE' },
  // XLV
  { symbol: 'LLY', name: 'Eli Lilly', etf: 'XLV' },
  { symbol: 'UNH', name: 'UnitedHealth', etf: 'XLV' },
  { symbol: 'JNJ', name: 'Johnson & Johnson', etf: 'XLV' },
  { symbol: 'MRK', name: 'Merck', etf: 'XLV' },
  // XLY
  { symbol: 'AMZN', name: 'Amazon', etf: 'XLY' },
  { symbol: 'TSLA', name: 'Tesla', etf: 'XLY' },
  { symbol: 'HD', name: 'Home Depot', etf: 'XLY' },
  { symbol: 'MCD', name: 'McDonald\u2019s', etf: 'XLY' },
  // XLP
  { symbol: 'PG', name: 'Procter & Gamble', etf: 'XLP' },
  { symbol: 'KO', name: 'Coca-Cola', etf: 'XLP' },
  { symbol: 'COST', name: 'Costco', etf: 'XLP' },
  { symbol: 'WMT', name: 'Walmart', etf: 'XLP' },
  // XLI
  { symbol: 'CAT', name: 'Caterpillar', etf: 'XLI' },
  { symbol: 'GE', name: 'GE Aerospace', etf: 'XLI' },
  { symbol: 'BA', name: 'Boeing', etf: 'XLI' },
  { symbol: 'UBER', name: 'Uber', etf: 'XLI' },
  // XLB
  { symbol: 'LIN', name: 'Linde', etf: 'XLB' },
  { symbol: 'FCX', name: 'Freeport-McMoRan', etf: 'XLB' },
  { symbol: 'NEM', name: 'Newmont', etf: 'XLB' },
  // XLRE
  { symbol: 'PLD', name: 'Prologis', etf: 'XLRE' },
  { symbol: 'AMT', name: 'American Tower', etf: 'XLRE' },
  { symbol: 'O', name: 'Realty Income', etf: 'XLRE' },
  // XLU
  { symbol: 'NEE', name: 'NextEra Energy', etf: 'XLU' },
  { symbol: 'SO', name: 'Southern Co', etf: 'XLU' },
  { symbol: 'DUK', name: 'Duke Energy', etf: 'XLU' },
  // XLC
  { symbol: 'GOOGL', name: 'Alphabet', etf: 'XLC' },
  { symbol: 'META', name: 'Meta', etf: 'XLC' },
  { symbol: 'NFLX', name: 'Netflix', etf: 'XLC' },
  { symbol: 'DIS', name: 'Disney', etf: 'XLC' },
];

// -------------------------------------------------------------
// 可重現的亂數 (mulberry32) — 同一個 seed 永遠產生同一組資料，
// 方便你 debug。換真實資料後這段就用不到了。
// -------------------------------------------------------------
function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// =============================================================
// MockDataAdapter — 內建模擬資料來源 (預設使用)
// 用幾何布朗運動 + 板塊週期性「題材輪動」產生看起來合理的行情，
// 讓整套流程(板塊熱度→選股→買賣訊號→回測)在沒接 API 時就能跑。
// =============================================================
export class MockDataAdapter {
  constructor(seed = 20260630) {
    this.rng = mulberry32(seed);
    this.day = 0;
    this._initState();
  }

  _initState() {
    // 每個板塊一個「題材強度」相位，會隨時間輪動 -> 製造板塊熱度變化
    this.sectorPhase = {};
    SECTORS.forEach((s, i) => {
      this.sectorPhase[s.etf] = {
        phase: this.rng() * Math.PI * 2,
        speed: 0.04 + this.rng() * 0.05,
        amp: 0.6 + this.rng() * 0.8,
      };
    });
    // 每檔股票一條價格序列 (含一段歷史，供回測 / 均線使用)
    this.series = {};
    UNIVERSE.forEach((u) => {
      const start = 40 + this.rng() * 360;
      this.series[u.symbol] = this._genPath(u, start, 260); // ~1 年歷史
    });
  }

  _sectorDrift(etf, t) {
    const p = this.sectorPhase[etf];
    // 板塊整體趨勢: 慢速正弦 -> 模擬資金在板塊間輪動
    return Math.sin(p.phase + t * p.speed) * p.amp * 0.0015;
  }

  _genPath(u, start, n) {
    const bars = [];
    let price = start;
    for (let t = 0; t < n; t++) {
      const drift = this._sectorDrift(u.etf, t);
      const vol = 0.012 + this.rng() * 0.02;          // 個股波動
      const shock = (this.rng() - 0.5) * 2 * vol;
      price = Math.max(1, price * (1 + drift + shock));
      bars.push(price);
    }
    return bars;
  }

  // ---- 工具: 從價格序列算出衍生指標 ----
  _metrics(bars) {
    const last = bars[bars.length - 1];
    const prev = bars[bars.length - 2] ?? last;
    const ma = (k) => {
      const slice = bars.slice(-k);
      return slice.reduce((a, b) => a + b, 0) / slice.length;
    };
    const ret = (k) => {
      const past = bars[bars.length - 1 - k];
      return past ? (last - past) / past : 0;
    };
    const ma20 = ma(20), ma50 = ma(50);
    return {
      price: last,
      prevClose: prev,
      changePct: (last - prev) / prev,
      ma20, ma50,
      relMA20: (last - ma20) / ma20,
      relMA50: (last - ma50) / ma50,
      ret1m: ret(21),   // 約 1 個月 (21 交易日)
      ret3m: ret(63),   // 約 3 個月
    };
  }

  // ===== DataAdapter 介面實作 =====
  getUniverse() { return UNIVERSE; }

  getQuotes() {
    return UNIVERSE.map((u) => {
      const m = this._metrics(this.series[u.symbol]);
      return { symbol: u.symbol, name: u.name, etf: u.etf, ...m };
    });
  }

  getSectorETFs() {
    // 用該板塊所有成分股的平均表現代表 ETF (起步用；之後可直接抓 ETF 行情)
    return SECTORS.map((s) => {
      const members = UNIVERSE.filter((u) => u.etf === s.etf)
        .map((u) => this._metrics(this.series[u.symbol]));
      const avg = (f) => members.reduce((a, m) => a + m[f], 0) / members.length;
      return {
        etf: s.etf, name: s.name,
        ret1m: avg('ret1m'), ret3m: avg('ret3m'), relMA50: avg('relMA50'),
      };
    });
  }

  getHistorical(symbol, days = 252) {
    const bars = this.series[symbol] || [];
    return bars.slice(-days);
  }

  // 模擬「過一天」: 每檔股票走一步。真實版本不需要這個。
  advanceDay() {
    this.day++;
    UNIVERSE.forEach((u) => {
      const bars = this.series[u.symbol];
      const drift = this._sectorDrift(u.etf, 260 + this.day);
      const vol = 0.012 + this.rng() * 0.02;
      const shock = (this.rng() - 0.5) * 2 * vol;
      const last = bars[bars.length - 1];
      bars.push(Math.max(1, last * (1 + drift + shock)));
      if (bars.length > 400) bars.shift();
    });
  }
}

// -------------------------------------------------------------
// 之後要接真實資料，就建一個新 class 實作同樣的方法，例如:
//
// export class FmpAdapter {
//   constructor(apiKey){ this.key = apiKey; }
//   async getSectorETFs(){ /* fetch FMP /quote/XLK,XLF,... */ }
//   async getQuotes(){ ... }
//   async getHistorical(symbol, days){ ... }
// }
//
// 推薦的免費 / 平價美股 API: Financial Modeling Prep、Finnhub、
// Twelve Data、Polygon、Alpha Vantage。板塊熱度直接抓上面 11 檔
// SPDR ETF 的報酬率即可，最乾淨。
// -------------------------------------------------------------

// =============================================================
// indicators.js — 技術指標(給資料層算衍生數據用)
// =============================================================

// ATR (Average True Range) — Wilder 平滑,跟 TradingView 預設一致。
// 輸入: bars = [{h, l, c}, ...] (舊 -> 新)
// 回傳: 最新的 ATR 絕對值;資料不足回 null。
export function atr(bars, period = 14) {
  if (!bars || bars.length < period + 1) return null;

  // 逐日 True Range = max(當日高低差, |高−昨收|, |低−昨收|)
  const tr = [];
  for (let i = 1; i < bars.length; i++) {
    const h = bars[i].h, l = bars[i].l, pc = bars[i - 1].c;
    tr.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }

  // Wilder RMA:前 period 個 TR 取簡單平均當種子,之後遞迴平滑
  let a = tr.slice(0, period).reduce((x, y) => x + y, 0) / period;
  for (let i = period; i < tr.length; i++) {
    a = (a * (period - 1) + tr[i]) / period;
  }
  return a;
}

// 從 OHLC(V) bars 算出 Minervini 趨勢範本所需的完整指標。
// 需 >=200 根(要算 MA200 / 52週高低);不足回 null。bars: {h,l,c,v}
export function quoteMetrics(bars) {
  if (!bars || bars.length < 200) return null;
  const closes = bars.map((b) => b.c);
  const highs = bars.map((b) => b.h);
  const lows = bars.map((b) => b.l);
  const vols = bars.map((b) => b.v || 0);
  const n = closes.length, last = closes[n - 1], prev = closes[n - 2] ?? last;
  const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
  const ma = (k) => mean(closes.slice(-Math.min(k, n)));
  const ret = (k) => { const p = closes[n - 1 - k]; return p ? (last - p) / p : 0; };

  const ma20 = ma(20), ma50 = ma(50), ma150 = ma(150), ma200 = ma(200);
  // MA200 一個月前(判斷 MA200 是否上升)
  const ma200_1mo = n >= 221 ? mean(closes.slice(n - 221, n - 21)) : ma200;

  const win = Math.min(252, n);
  const high52 = Math.max(...highs.slice(-win));
  const low52 = Math.min(...lows.slice(-win));

  const a = atr(bars, 14), atr10 = atr(bars, 10), atr50 = atr(bars, 50);
  const hasVol = vols.some((v) => v > 0);
  const vol10 = mean(vols.slice(-10)), vol50 = mean(vols.slice(-50)), avgVol30 = mean(vols.slice(-30));

  return {
    price: last, prevClose: prev,
    ma20, ma50, ma150, ma200, ma200_1mo,
    relMA20: (last - ma20) / ma20, relMA50: (last - ma50) / ma50,
    ret1m: ret(21), ret3m: ret(63), ret6m: ret(126),
    high52, low52,
    pctFrom52wHigh: (last - high52) / high52,     // 負值 = 低於高點多少
    pctAbove52wLow: (last - low52) / low52,
    atr: a, atrPct: a ? a / last : null,
    avgVol30: hasVol ? avgVol30 : null,
    // VCP 收縮啟發式:近期波動 + 量能雙雙萎縮
    vcpContracting: (atr10 != null && atr50 != null && atr10 < atr50) && (hasVol ? vol10 < vol50 : true),
  };
}

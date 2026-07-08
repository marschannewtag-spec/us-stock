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

// 從 OHLC bars 算出一檔的完整指標(候選驗證器用;需 >=63 根,不足回 null)
export function quoteMetrics(bars) {
  if (!bars || bars.length < 63) return null;
  const closes = bars.map((b) => b.c);
  const last = closes[closes.length - 1];
  const prev = closes[closes.length - 2] ?? last;
  const ma = (k) => { const s = closes.slice(-k); return s.reduce((x, y) => x + y, 0) / s.length; };
  const ret = (k) => { const p = closes[closes.length - 1 - k]; return p ? (last - p) / p : 0; };
  const ma20 = ma(20), ma50 = ma(50);
  const a = atr(bars, 14);
  return {
    price: last, prevClose: prev, ma20, ma50,
    relMA20: (last - ma20) / ma20, relMA50: (last - ma50) / ma50,
    ret1m: ret(21), ret3m: ret(63),
    atr: a, atrPct: a ? a / last : null,
  };
}

// =============================================================
// backtest.js — 回測引擎 (需求 5: 長期驗證是否賺錢)
// -------------------------------------------------------------
// 一個事件驅動的回測器: 拿歷史日線，每天跑一次「板塊排名 -> 選股 ->
// 買賣訊號 -> 更新持倉」，產出權益曲線與關鍵績效指標。
//
// ⚠️ 重要: 目前餵進去的是「合成資料 (synthetic)」，只是用來驗證
//    整套流程跑得通、邏輯沒 bug。它【不能】證明策略真的會賺錢。
//    要回答需求 5/6，你必須:
//      1. 把 getHistorical 換成真實歷史日線 (含已下市標的，避免生存者偏差)
//      2. 切出樣本外 (out-of-sample) 期間
//      3. 跑你慣用的那套 Monte Carlo (多年、數百次、所有曲線為正才接受)
//
// 介面: runBacktest({ priceMatrix, dates, params }) -> Result
//   priceMatrix: { [symbol]: number[] }  每檔股票的歷史收盤價(對齊長度)
//   dates:       string[]                對應的日期
// =============================================================

import { UNIVERSE, SECTORS } from './data.js';
import { rankSectors } from './sectors.js';
import { generateBuys, generateSells, MAX_POSITIONS, STRATEGY_PARAMS } from './strategy.js';

// 從 priceMatrix 在第 t 天切出策略需要的 quotes / sectorETFs
function snapshotAt(priceMatrix, t) {
  const metricsOf = (bars) => {
    const last = bars[t];
    const ma = (k) => {
      const s = bars.slice(Math.max(0, t - k + 1), t + 1);
      return s.reduce((a, b) => a + b, 0) / s.length;
    };
    const ret = (k) => (t - k >= 0 ? (last - bars[t - k]) / bars[t - k] : 0);
    const ma20 = ma(20), ma50 = ma(50);
    return {
      price: last, ma20, ma50,
      relMA20: (last - ma20) / ma20, relMA50: (last - ma50) / ma50,
      ret1m: ret(21), ret3m: ret(63),
    };
  };

  const quotes = UNIVERSE.map((u) => ({
    symbol: u.symbol, name: u.name, etf: u.etf, ...metricsOf(priceMatrix[u.symbol]),
  }));

  const sectorETFs = SECTORS.map((s) => {
    const mem = quotes.filter((q) => q.etf === s.etf);
    const avg = (f) => mem.reduce((a, m) => a + m[f], 0) / mem.length;
    return { etf: s.etf, name: s.name, ret1m: avg('ret1m'), ret3m: avg('ret3m'), relMA50: avg('relMA50') };
  });

  return { quotes, sectorETFs };
}

export function runBacktest({ priceMatrix, dates, params = STRATEGY_PARAMS, rebalanceEvery = 5 }) {
  // 回測目前為全進全出(不含分批階梯);階梯 + OHLC 停損會在 Monte Carlo 步驟一起整合。
  params = { ...params, enableProfitLadder: false };
  let positions = [];           // 回測用持倉
  const equity = [];            // 權益曲線 (等權重，初始 1.0)
  let nav = 1.0;
  const trades = [];

  const start = 63;             // 前 63 天當暖身 (要有 3M 報酬)
  const N = dates.length;

  for (let t = start; t < N; t++) {
    // 1) 更新持倉現價與最高價、計算當日權益變動
    let dayRet = 0;
    for (const p of positions) {
      const px = priceMatrix[p.symbol][t];
      const prev = priceMatrix[p.symbol][t - 1];
      dayRet += ((px - prev) / prev) / MAX_POSITIONS; // 等權重，空倉部位視為現金
      p.peakPrice = Math.max(p.peakPrice, px);
    }
    nav *= (1 + dayRet);
    equity.push({ date: dates[t], nav });

    // 2) 每隔 rebalanceEvery 天才換倉 (降低過度交易)
    if ((t - start) % rebalanceEvery !== 0) continue;

    const { quotes, sectorETFs } = snapshotAt(priceMatrix, t);
    const ranked = rankSectors(sectorETFs, params.hotSectorCount);
    const quoteBy = Object.fromEntries(quotes.map((q) => [q.symbol, q]));

    // 3) 先出場
    const sells = generateSells(
      positions.map((p) => ({ ...p, lastPrice: quoteBy[p.symbol]?.price })),
      quotes, ranked, params,
    );
    for (const s of sells) {
      const i = positions.findIndex((p) => p.symbol === s.symbol);
      if (i >= 0) {
        const p = positions[i];
        trades.push({ symbol: p.symbol, pnlPct: (s.price - p.entryPrice) / p.entryPrice });
        positions.splice(i, 1);
      }
    }

    // 4) 再進場 (補到滿 6 倉)
    const buys = generateBuys(quotes, ranked, positions, params);
    for (const b of buys) {
      positions.push({ symbol: b.symbol, etf: b.etf, entryPrice: b.price, peakPrice: b.price });
    }
  }

  return { equity, metrics: computeMetrics(equity, trades), trades };
}

// ---- 績效指標 ----
export function computeMetrics(equity, trades) {
  if (equity.length < 2) return null;
  const navs = equity.map((e) => e.nav);
  const totalReturn = navs[navs.length - 1] / navs[0] - 1;
  const years = equity.length / 252;
  const cagr = Math.pow(navs[navs.length - 1] / navs[0], 1 / years) - 1;

  // 最大回撤 (需求 6: 你接受大回撤，但要看清楚到底多大)
  let peak = navs[0], maxDD = 0;
  for (const v of navs) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v / peak - 1);
  }

  // 日報酬 -> 年化夏普
  const rets = [];
  for (let i = 1; i < navs.length; i++) rets.push(navs[i] / navs[i - 1] - 1);
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length) || 1e-9;
  const sharpe = (mean / sd) * Math.sqrt(252);

  const wins = trades.filter((t) => t.pnlPct > 0).length;
  return {
    totalReturn, cagr, maxDD, sharpe,
    trades: trades.length,
    winRate: trades.length ? wins / trades.length : 0,
    calmar: maxDD !== 0 ? cagr / Math.abs(maxDD) : 0, // 報酬/回撤比 -> 衡量需求6的效率
  };
}

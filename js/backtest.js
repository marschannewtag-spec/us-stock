// =============================================================
// backtest.js — 績效指標(computeMetrics)
// -------------------------------------------------------------
// 早期的「合成資料回測器」已移除(接了真實 16 年資料 + 六姿態
// Monte Carlo 後不再需要)。此檔現在只保留績效指標計算,供
// backtest-real.js(真實回測)與 Monte Carlo 使用。
// =============================================================

// ---- 績效指標:總報酬 / CAGR / 最大回撤 / 夏普 / 勝率 / Calmar ----
export function computeMetrics(equity, trades) {
  if (equity.length < 2) return null;
  const navs = equity.map((e) => e.nav);
  const totalReturn = navs[navs.length - 1] / navs[0] - 1;
  const years = equity.length / 252;
  const cagr = Math.pow(navs[navs.length - 1] / navs[0], 1 / years) - 1;

  let peak = navs[0], maxDD = 0;
  for (const v of navs) {
    peak = Math.max(peak, v);
    maxDD = Math.min(maxDD, v / peak - 1);
  }

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
    calmar: maxDD !== 0 ? cagr / Math.abs(maxDD) : 0,
  };
}

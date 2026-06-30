// =============================================================
// strategy.js — 策略核心 (需求 1/2/3: 最多 6 倉、每日買進/賣出訊號)
// -------------------------------------------------------------
// 這是整個系統最該被你「強化」的地方。目前是一個可解釋的動能策略骨架:
//
//   買進 (BUY):  只在熱門板塊中選股，挑站上 MA20、動能最強、尚未持有的標的，
//                直到補滿到 MAX_POSITIONS 倉為止。
//   賣出 (SELL): 對現有持倉檢查 4 個出場條件 (停損 / 板塊退燒 / 動能轉弱 /
//                移動停利)，命中任一就出場。
//
// 需求 6「接受大回撤但要高報酬」-> 預設停損放寬、停利改用移動停利讓獲利奔跑。
// 所有參數集中在 STRATEGY_PARAMS，方便你日後最佳化 / 跑 Monte Carlo。
// =============================================================

export const MAX_POSITIONS = 6;

export const STRATEGY_PARAMS = {
  hotSectorCount: 3,        // 視為「熱門」的板塊數
  sectorExitRank: 5,        // 持倉板塊掉出前幾名就出場 (退燒)
  minStockScore: 0.0,       // 候選股的最低動能門檻 (>0 = 淨正動能)
  requireAboveMA20: true,   // 買進需站上 20 日均線
  stopLossPct: -0.18,       // 硬停損 -18% (放寬，容忍大回撤)
  trailingStopPct: -0.12,   // 從持倉最高點回落 12% 觸發移動停利
  momentumBreakBuffer: -0.03, // 收盤跌破 MA20 超過 3% 視為動能轉弱
};

// 個股動能分數 (買進排序用)
function stockScore(q) {
  return 0.5 * q.ret1m + 0.3 * q.ret3m + 0.2 * q.relMA20;
}

// ---- 產生今日買進清單 (需求 2) ----
// 輸入: quotes(全標的快照), rankedSectors(已排名板塊), positions(現有持倉)
// 輸出: BuySignal[]  { symbol, name, etf, sectorName, price, score, reasons[] }
export function generateBuys(quotes, rankedSectors, positions, params = STRATEGY_PARAMS) {
  const hotETFs = new Set(rankedSectors.filter((s) => s.hot).map((s) => s.etf));
  const sectorName = Object.fromEntries(rankedSectors.map((s) => [s.etf, s.name]));
  const held = new Set(positions.map((p) => p.symbol));
  const slotsLeft = MAX_POSITIONS - positions.length;
  if (slotsLeft <= 0) return []; // 需求 1: 滿 6 倉就不再買

  const candidates = quotes
    .filter((q) => hotETFs.has(q.etf))            // 只買熱門板塊
    .filter((q) => !held.has(q.symbol))           // 還沒持有
    .filter((q) => !params.requireAboveMA20 || q.price > q.ma20) // 站上 MA20
    .map((q) => ({
      symbol: q.symbol, name: q.name, etf: q.etf,
      sectorName: sectorName[q.etf],
      price: q.price,
      score: stockScore(q),
      reasons: buildBuyReasons(q, sectorName[q.etf]),
    }))
    .filter((c) => c.score >= params.minStockScore)
    .sort((a, b) => b.score - a.score);

  return candidates.slice(0, slotsLeft); // 只補到滿 6 倉
}

function buildBuyReasons(q, secName) {
  const r = [];
  r.push(`熱門板塊 ${secName}`);
  if (q.ret1m > 0) r.push(`1M 動能 +${(q.ret1m * 100).toFixed(1)}%`);
  if (q.price > q.ma20) r.push('站上 MA20');
  if (q.price > q.ma50) r.push('站上 MA50');
  return r;
}

// ---- 產生今日賣出清單 (需求 3) ----
// 輸入: positions(現有持倉，含 peakPrice), quotes(快照), rankedSectors
// 輸出: SellSignal[] { symbol, price, pnlPct, reasons[] }
export function generateSells(positions, quotes, rankedSectors, params = STRATEGY_PARAMS) {
  const quoteBy = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
  const rankBy = Object.fromEntries(rankedSectors.map((s) => [s.etf, s.rank]));
  const sells = [];

  for (const pos of positions) {
    const q = quoteBy[pos.symbol];
    if (!q) continue;
    const price = q.price;
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;
    const peak = Math.max(pos.peakPrice ?? pos.entryPrice, price);
    const fromPeak = (price - peak) / peak;
    const reasons = [];

    if (pnlPct <= params.stopLossPct) reasons.push(`硬停損 ${(pnlPct * 100).toFixed(1)}%`);
    if (fromPeak <= params.trailingStopPct) reasons.push(`移動停利 (自高點 ${(fromPeak * 100).toFixed(1)}%)`);
    if ((rankBy[pos.etf] ?? 99) > params.sectorExitRank) reasons.push('板塊退燒');
    if (q.relMA20 <= params.momentumBreakBuffer) reasons.push('跌破 MA20，動能轉弱');

    if (reasons.length > 0) {
      sells.push({ symbol: pos.symbol, name: pos.name, price, pnlPct, reasons });
    }
  }
  return sells;
}

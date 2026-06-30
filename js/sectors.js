// =============================================================
// sectors.js — 板塊熱度 (需求 4: 選出目前市場最熱的板塊)
// -------------------------------------------------------------
// 把 11 個板塊 ETF 用「動能分數」排名，分數高的就是當下資金最熱的板塊。
// 之後選股只會從「熱門板塊」裡挑 -> 強迫策略順著板塊輪動走。
// =============================================================

// 動能分數權重 (可調)。預設偏重短中期動能，符合「板塊輪動」抓題材的邏輯。
export const SECTOR_WEIGHTS = {
  ret1m: 0.5,   // 1 個月報酬
  ret3m: 0.3,   // 3 個月報酬
  relMA50: 0.2, // 價格相對 50 日均線的位置 (站上多遠)
};

// 把一組數值做 z-score 標準化，避免某個指標尺度太大蓋過其他指標
function zscore(arr) {
  const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
  const sd = Math.sqrt(arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length) || 1;
  return arr.map((x) => (x - mean) / sd);
}

// 回傳排名後的板塊清單，最熱的在最前面
// 每個元素: { etf, name, ret1m, ret3m, relMA50, score, rank, hot }
export function rankSectors(sectorETFs, hotCount = 3) {
  const z1 = zscore(sectorETFs.map((s) => s.ret1m));
  const z3 = zscore(sectorETFs.map((s) => s.ret3m));
  const zm = zscore(sectorETFs.map((s) => s.relMA50));

  const scored = sectorETFs.map((s, i) => ({
    ...s,
    score:
      SECTOR_WEIGHTS.ret1m * z1[i] +
      SECTOR_WEIGHTS.ret3m * z3[i] +
      SECTOR_WEIGHTS.relMA50 * zm[i],
  }));

  scored.sort((a, b) => b.score - a.score);
  scored.forEach((s, i) => {
    s.rank = i + 1;
    s.hot = i < hotCount; // 前 N 名 = 熱門板塊
  });
  return scored;
}

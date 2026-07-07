// =============================================================
// presets.js — 六個「風險姿態」preset(需求 2)
// -------------------------------------------------------------
// 這不是六種「方法」,是同一台動能引擎的六組參數。對映的是每個
// 人設「可被引擎表達的姿態」,不是他們的選擇權/宏觀/多資產本體。
// 只給回測比較用;日常操作固定用「綜合」。
// =============================================================

import { STRATEGY_PARAMS } from './strategy.js';
import { MARKET_PARAMS } from './market.js';

function preset(label, overrides, blockOnDefensiveLegs) {
  return {
    label,
    params: { ...STRATEGY_PARAMS, ...overrides },
    market: { ...MARKET_PARAMS, blockOnDefensiveLegs },
  };
}

export const PRESETS = {
  // 嚴選、集中 3 倉、停損停利最寬(讓右側趨勢跑)、市場防禦最高
  marcus: preset('Marcus Jin',
    { minStockScore: 0.18, maxPositions: 3, hotSectorCount: 2, atrStopMult: 3.5, trailingStopPct: -0.18, sectorExitRank: 4, reentryCooldownDays: 10 }, 1),
  // 門檻鬆、滿倉長抱、中庸停損停利、少防禦、低冷卻
  uncle: preset('大叔美股筆記',
    { minStockScore: 0.10, maxPositions: 6, hotSectorCount: 4, atrStopMult: 2.5, trailingStopPct: -0.12, sectorExitRank: 6, reentryCooldownDays: 3 }, 2),
  // 停損最緊、停利最快收、板塊退燒快出(勝率型)
  gooptions: preset('GoOptions',
    { minStockScore: 0.15, maxPositions: 5, hotSectorCount: 3, atrStopMult: 1.8, trailingStopPct: -0.08, sectorExitRank: 4, reentryCooldownDays: 5 }, 1),
  // ≈ 大叔但略嚴,長抱成長
  bilaal: preset('Bilaal Dhalech',
    { minStockScore: 0.11, maxPositions: 6, hotSectorCount: 4, atrStopMult: 2.8, trailingStopPct: -0.13, sectorExitRank: 6, reentryCooldownDays: 3 }, 2),
  // 板塊輪動最快、集中 4 倉、防禦偏高(現金紀律)
  amber: preset('Amber 姐姐',
    { minStockScore: 0.14, maxPositions: 4, hotSectorCount: 3, atrStopMult: 2.2, trailingStopPct: -0.10, sectorExitRank: 3, reentryCooldownDays: 3 }, 1),
  // 均衡預設 = 你日常在用的那組
  composite: preset('綜合',
    { minStockScore: 0.13, maxPositions: 6, hotSectorCount: 3, atrStopMult: 2.5, trailingStopPct: -0.12, sectorExitRank: 5, reentryCooldownDays: 5 }, 1),
};

export const PRESET_ORDER = ['marcus', 'uncle', 'gooptions', 'bilaal', 'amber', 'composite'];

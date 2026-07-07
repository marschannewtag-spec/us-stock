// =============================================================
// market.js — AI 水位 (需求 3: 市場估值/風險過高就不進場)
// -------------------------------------------------------------
// 這是「市場層級的總開關」,獨立於個股選股(strategy.js)。
// 移植你 Cash-Weight Gauge 的精神:兩條腿的「聯集(union)」——
// 只要任一條說防禦,就進入防禦、當日暫停進場。
//
//   趨勢腿:  SPY 收盤 vs 12M(252 日)均線。跌破 -> 防禦。
//   風險腿:  VIX 高於門檻 -> 防禦。
//            (免費層抓不到 VIX 時,自動用 SPY 的 20 日「已實現波動」替代。)
//
// ⚠️ 誠實界定:這是「風險體制(risk regime)」偵測,不是真估值。
//   它抓的是「下跌 + 高波動」的危險期,擋不掉「很貴但很平靜」的市場
//   (那需要 CAPE,免費層沒有)。要真估值,之後把這函式換成你原版 gauge 即可。
// =============================================================

export const MARKET_PARAMS = {
  smaWindow: 252,             // 趨勢腿:SPY 相對 12M 均線
  vixThreshold: 22,           // VIX 高於此 -> 風險腿防禦
  realizedVolWindow: 20,      // 無 VIX 時,SPY 已實現波動的視窗
  realizedVolThreshold: 0.22, // 年化波動 22% 以上 -> 防禦
  blockOnDefensiveLegs: 1,    // 幾條腿防禦就暫停進場 (1 = 聯集/任一;2 = 需兩條都防禦)
};

// 回傳市場水位判斷
// { available, riskOn, cashWeight(0/50/100), spyVsSma, volValue, volSource,
//   trendDefensive, volDefensive, reasons[] }
export function computeMarketGate(spy, vix, params = MARKET_PARAMS) {
  if (!spy || spy.length < 30) return { available: false };

  // ── 趨勢腿 ──
  const last = spy[spy.length - 1];
  const w = Math.min(params.smaWindow, spy.length);
  const sma = spy.slice(-w).reduce((a, b) => a + b, 0) / w;
  const spyVsSma = (last - sma) / sma;
  const trendDefensive = last < sma;

  // ── 風險腿:優先用真 VIX,沒有就用 SPY 已實現波動替代 ──
  let volValue, volSource, volDefensive;
  if (vix && vix.length > 0) {
    volValue = vix[vix.length - 1];
    volSource = 'VIX';
    volDefensive = volValue > params.vixThreshold;
  } else {
    volValue = realizedVol(spy, params.realizedVolWindow);
    volSource = 'RV'; // SPY 已實現波動(替代)
    volDefensive = volValue > params.realizedVolThreshold;
  }

  const defensiveLegs = (trendDefensive ? 1 : 0) + (volDefensive ? 1 : 0);
  const riskOn = defensiveLegs < params.blockOnDefensiveLegs;
  const cashWeight = defensiveLegs === 0 ? 0 : (defensiveLegs === 1 ? 50 : 100);

  const reasons = [];
  if (trendDefensive) reasons.push(`SPY 跌破 12M 均線 (${(spyVsSma * 100).toFixed(1)}%)`);
  if (volDefensive) {
    reasons.push(volSource === 'VIX'
      ? `VIX ${volValue.toFixed(1)} 高於 ${params.vixThreshold}`
      : `已實現波動 ${(volValue * 100).toFixed(0)}% 高於 ${(params.realizedVolThreshold * 100).toFixed(0)}%`);
  }

  return {
    available: true, riskOn, cashWeight, spyVsSma, sma, last,
    volValue, volSource, trendDefensive, volDefensive, reasons,
  };
}

// SPY 年化已實現波動 (log 報酬標準差 × √252)
function realizedVol(closes, n) {
  const rets = [];
  const start = Math.max(1, closes.length - n);
  for (let i = start; i < closes.length; i++) rets.push(Math.log(closes[i] / closes[i - 1]));
  if (rets.length < 2) return 0;
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
  const varr = rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length;
  return Math.sqrt(varr) * Math.sqrt(252);
}

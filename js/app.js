// =============================================================
// app.js — UI 主控 (把所有模組串起來、渲染畫面、處理互動)
// -------------------------------------------------------------
// 只負責「呈現 + 互動」。任何策略/資料的真正邏輯都在各自模組裡。
// =============================================================

import { MockDataAdapter, SECTORS, UNIVERSE } from './data.js';
import { RealDataAdapter } from './data-real.js';
import { config } from './config.js';
import { rankSectors } from './sectors.js';
import { generateBuys, generateSells, buyDiagnostic, computeStops, verifyCandidate, verifyTrendTemplate, MAX_POSITIONS, STRATEGY_PARAMS } from './strategy.js';
import { quoteMetrics } from './indicators.js';
import { Portfolio } from './portfolio.js';
import { computeMarketGate, MARKET_PARAMS } from './market.js';
import { putBars, getBars, putMeta, getMeta, clearAll } from './histdb.js';
import { runRealBacktest } from './backtest-real.js';
import { PRESETS, PRESET_ORDER } from './presets.js';

// 依 config 選資料來源:真實(Twelve Data / Worker)或模擬
const adapter = config.USE_REAL_DATA ? new RealDataAdapter(config) : new MockDataAdapter();
const portfolio = new Portfolio();

// 日常「今日」分頁採用的姿態 preset(單一來源,改 config.DAILY_PRESET 即可切換)
const DAILY = PRESETS[config.DAILY_PRESET] || PRESETS.composite;
const DP = DAILY.params;                       // 日常策略參數
const DM = DAILY.market;                        // 日常市場水位參數
const DAILY_MAX = DP.maxPositions ?? MAX_POSITIONS;

let state = {
  tab: 'today',
  date: new Date(),
  quotes: [], ranked: [], buys: [], sells: [],
  loading: false, loadMsg: '',
  candInput: '',
};
let exploreRunning = false;
let exploreProgress = '';
let exploreResults = null;

// ---- 每天重新計算: 報價 -> 板塊排名 -> 買賣訊號 ----
async function compute() {
  state.quotes = await adapter.getQuotes();
  portfolio.mark(state.quotes);
  state.ranked = rankSectors(await adapter.getSectorETFs(), DP.hotSectorCount);
  logSectorLeader(state.ranked[0] ? state.ranked[0].etf : null);

  // 不重複:算出還在冷卻期(近 N 天賣掉)的代號,買進時排除
  const recentlySold = recentlySoldSymbols(DP.reentryCooldownDays);

  state.buys = generateBuys(tradeable(state.quotes), state.ranked, portfolio.positions, DP, recentlySold);
  state.sells = generateSells(portfolio.positions, state.quotes, state.ranked, DP);

  // 若今天沒補滿,算一下「差在哪」給使用者看(證明是門檻在把關)
  state.buyDiag = buyDiagnostic(tradeable(state.quotes), state.ranked, portfolio.positions, DP, recentlySold);

  // AI 水位:市場層級總開關(防禦時暫停進場)
  const mkt = await adapter.getMarketSeries();
  state.market = computeMarketGate(mkt.spy, mkt.vix, DM);
}

// 只保留價格帶內的股票(config.PRICE_MIN ~ PRICE_MAX,下單/部位大小限制)
function tradeable(quotes) {
  const lo = config.PRICE_MIN ?? 0, hi = config.PRICE_MAX ?? Infinity;
  return quotes.filter((q) => q.price >= lo && q.price <= hi);
}

// 從已實現紀錄找出近 N 天賣出的代號(冷卻期,避免買→賣→馬上再買的來回洗)
function recentlySoldSymbols(days) {
  const cutoff = Date.now() - days * 86400000;
  return (portfolio.cashLog || [])
    .filter((c) => c.exitDate && new Date(c.exitDate).getTime() >= cutoff)
    .map((c) => c.symbol);
}

// ---- 格式化小工具 ----
const pct = (x, d = 1) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(d)}%`;
const cls = (x) => (x >= 0 ? 'up' : 'down');
const money = (x) => `$${x.toFixed(2)}`;

// =============================================================
// 各分頁渲染
// =============================================================
function renderToday() {
  const s = portfolio.stats();
  const slots = DAILY_MAX - portfolio.positions.length;
  const blocked = state.market && state.market.available && !state.market.riskOn;

  return `
    <section class="summary">
      <div class="summary-row">
        <div class="metric"><span class="metric-label">持倉</span>
          <span class="metric-val mono">${s.open}<span class="slash">/${DAILY_MAX}</span></span></div>
        <div class="metric"><span class="metric-label">未實現均報酬</span>
          <span class="metric-val mono ${cls(s.unrealAvgPct)}">${pct(s.unrealAvgPct)}</span></div>
        <div class="metric"><span class="metric-label">已實現累計</span>
          <span class="metric-val mono ${cls(s.realizedSumPct)}">${pct(s.realizedSumPct)}</span></div>
      </div>
    </section>

    ${marketBanner()}

    <h2 class="block-head"><span class="dot buy"></span>今日精選買進
      <span class="head-note">${
        blocked ? '市場防禦中' : (slots <= 0 ? '已滿倉' : `精選 ${state.buys.length} 檔 · 空位 ${slots}`)
      }</span></h2>
    ${blocked
      ? (state.buys.length
        ? `<p class="empty">市場水位偏高，以下標的雖通過選股門檻，<strong>今日暫停進場</strong>（觀察名單）：</p>
           ${state.buys.map((b) => buyCard(b, true)).join('')}`
        : `<p class="empty">市場防禦中，且今天也沒有通過門檻的標的。<strong>空手。</strong></p>`)
      : `${state.buys.map((b) => buyCard(b, false)).join('')}${buyFooter(slots)}`
    }

    <h2 class="block-head"><span class="dot sell"></span>今日賣出訊號</h2>
    ${state.sells.length === 0
      ? `<p class="empty">現有持倉皆未觸發出場條件，續抱。</p>`
      : state.sells.map(sellCard).join('')}
  `;
}

// AI 水位橫幅
function marketBanner() {
  const m = state.market;
  if (!m || !m.available) return '';
  const statusCls = m.riskOn ? 'riskon' : 'riskoff';
  const label = m.riskOn ? '進場許可' : '防禦 · 暫停進場';
  const volLabel = m.volSource === 'VIX'
    ? `VIX ${m.volValue.toFixed(1)}`
    : `已實現波動 ${(m.volValue * 100).toFixed(0)}%`;
  return `
    <section class="market ${statusCls}">
      <div class="market-head">
        <span class="market-title">◈ AI 水位</span>
        <span class="market-status">${label}</span>
        <span class="market-cash mono">現金 ${m.cashWeight}%</span>
      </div>
      <div class="market-legs">
        <span class="leg ${m.trendDefensive ? 'bad' : 'good'}">趨勢 SPY vs 12M ${m.spyVsSma >= 0 ? '+' : ''}${(m.spyVsSma * 100).toFixed(1)}%</span>
        <span class="leg ${m.volDefensive ? 'bad' : 'good'}">波動 ${volLabel}</span>
      </div>
      ${m.reasons.length ? `<div class="market-reasons">${m.reasons.map((r) => `<span class="tag warn">${r}</span>`).join('')}</div>` : ''}
    </section>`;
}

// 買進區塊下方:說明「為什麼今天只有這幾檔 / 一檔都沒有」——證明是門檻在把關
function buyFooter(slots) {
  if (slots <= 0) {
    return state.buys.length === 0 ? `<p class="empty">已達 6 倉上限，今天不進場。</p>` : '';
  }
  const diag = state.buyDiag && state.buyDiag.topRejected;
  if (state.buys.length === 0) {
    return `<p class="empty">今天沒有通過品質門檻的標的，<strong>空手觀望</strong>（不硬湊）。${
      diag ? `<br>最接近的是 ${diag.symbol}，卡在:${diag.failedOn}。` : ''
    }</p>`;
  }
  // 有推薦、但沒補滿:也說明一下
  return `<p class="empty" style="margin-top:2px">只推「夠強」的，其餘空位寧可留著。${
    diag ? `下一個候選 ${diag.symbol} 卡在:${diag.failedOn}。` : ''
  }</p>`;
}

function buyCard(b, blocked = false) {
  const stopLine = `<div class="levels mono">進場 約$${b.entry.toFixed(2)}　·　停損 $${b.stopPrice.toFixed(2)} (${pct(b.stopPct)})</div>`;
  return `
    <div class="card signal${blocked ? ' dim' : ''}">
      <div class="card-main">
        <div class="ticker mono">${b.symbol}</div>
        <div class="card-sub">${b.name} · ${b.sectorName}</div>
        <div class="reasons">${b.reasons.map((r) => `<span class="tag">${r}</span>`).join('')}</div>
        ${stopLine}
      </div>
      <div class="card-side">
        <div class="price mono">${money(b.price)}</div>
        <div class="score">動能 ${b.score.toFixed(2)}</div>
        ${blocked
          ? `<button class="btn ghost" disabled>觀察中</button>`
          : `<button class="btn buy" data-buy="${b.symbol}">買進</button>`}
      </div>
    </div>`;
}

function sellCard(s) {
  const partial = s.fraction != null && s.fraction < 1;
  return `
    <div class="card signal">
      <div class="card-main">
        <div class="ticker mono">${s.symbol}</div>
        <div class="card-sub">${s.name}</div>
        <div class="reasons">${s.reasons.map((r) => `<span class="tag warn">${r}</span>`).join('')}</div>
      </div>
      <div class="card-side">
        <div class="price mono">${money(s.price)}</div>
        <div class="score ${cls(s.pnlPct)}">${pct(s.pnlPct)}</div>
        <button class="btn ${partial ? 'ghost' : 'sell'}" data-sell="${s.symbol}">${partial ? '減碼' : '賣出'}</button>
      </div>
    </div>`;
}

function renderPortfolio() {
  if (portfolio.positions.length === 0) {
    return `<p class="empty big">目前空倉。到「今日」分頁依買進訊號建倉，最多 6 檔。</p>`;
  }
  const quoteBy = Object.fromEntries(state.quotes.map((q) => [q.symbol, q]));
  return `
    <h2 class="block-head">現有持倉 <span class="head-note">${portfolio.positions.length}/${DAILY_MAX}</span></h2>
    ${portfolio.positions.map((p) => {
      const q = quoteBy[p.symbol];
      const last = q ? q.price : (p.lastPrice ?? p.entryPrice);
      const pnl = (last - p.entryPrice) / p.entryPrice;
      const secName = SECTORS.find((x) => x.etf === p.etf)?.name || p.etf;
      const { hardStop, trailStop, effStop } = computeStops(p, DP);
      const maRef = q ? `MA20 $${q.ma20.toFixed(2)} · MA50 $${q.ma50.toFixed(2)}` : '';
      return `
        <div class="card pos">
          <div class="card-main">
            <div class="ticker mono">${p.symbol}</div>
            <div class="card-sub">${p.name} · ${secName} · 進場 ${p.entryDate} @ $${p.entryPrice.toFixed(2)}${
              (p.size ?? 1) < 0.999 ? ` · <span class="down">剩 ${Math.round((p.size ?? 1) * 100)}%</span>` : ''
            }</div>
            <div class="levels mono">
              停損 $${hardStop.toFixed(2)}　·　移動停利 $${trailStop.toFixed(2)}
              <span class="eff">實際觸發 $${effStop.toFixed(2)}</span>
            </div>
            ${maRef ? `<div class="levels mono muted">${maRef}</div>` : ''}
          </div>
          <div class="card-side">
            <div class="price mono">${money(last)}</div>
            <div class="score ${cls(pnl)}">${pct(pnl)}</div>
            <button class="btn ghost" data-sell="${p.symbol}">平倉</button>
          </div>
        </div>`;
    }).join('')}`;
}

function renderSectors() {
  const max = Math.max(...state.ranked.map((s) => Math.abs(s.score)), 1);
  return `
    <h2 class="block-head">板塊熱度排名 <span class="head-note">前 ${DP.hotSectorCount} 名才選股</span></h2>
    <p class="hint">分數 = 0.5·1M報酬 + 0.3·3M報酬 + 0.2·相對MA50 (標準化後)</p>
    <div class="heat">
      ${state.ranked.map((s) => {
        const w = Math.max(4, (Math.abs(s.score) / max) * 100);
        return `
          <div class="heat-row ${s.hot ? 'hot' : ''}">
            <div class="heat-rank mono">${String(s.rank).padStart(2, '0')}</div>
            <div class="heat-etf mono">${s.etf}</div>
            <div class="heat-name">${s.name}</div>
            <div class="heat-bar-wrap">
              <div class="heat-bar ${cls(s.score)}" style="width:${w}%"></div>
            </div>
            <div class="heat-vals mono ${cls(s.ret1m)}">${pct(s.ret1m)}</div>
          </div>`;
      }).join('')}
    </div>`;
}

let realBtResult = null;  // 真實 16 年回測(綜合)
let realBtRunning = false;
let mcRunning = false;    // 六姿態 Monte Carlo
let mcProgress = '';
let mcResults = null;
let mcError = null;
let histMeta = null;      // 長歷史載入狀態
let histLoading = false;
let histProgress = '';
let spySanity = null;     // SPY 長歷史抽樣(驗證用)
function renderPerf() {
  const p = portfolio.perf();
  const s = portfolio.stats();
  if (p.trades === 0) {
    return `<h2 class="block-head">績效 · 資金曲線 <span class="head-note">百分比複利,起點 100</span></h2>
      <p class="empty big">尚無平倉紀錄。<br>到「今日」買進、之後平倉,這裡就會畫出你的資金成長曲線與交易明細。</p>`;
  }
  const nav = p.equity[p.equity.length - 1].nav;
  const g = (label, val, c = '') => `<div class="bt-metric"><span>${label}</span><b class="mono ${c}">${val}</b></div>`;
  return `
    <h2 class="block-head">資金曲線 <span class="head-note">起點 100 · 現在 ${nav.toFixed(1)}</span></h2>
    ${equitySVG(p.equity)}
    <div class="bt-grid">
      ${g('總報酬', pct(p.totalReturn), cls(p.totalReturn))}
      ${g('最大回撤', pct(p.maxDD), 'down')}
      ${g('交易次數', p.trades)}
      ${g('勝率', pct(p.winRate, 0))}
      ${g('平均獲利', pct(p.avgWin), 'up')}
      ${g('平均虧損', pct(p.avgLoss), 'down')}
      ${g('賺賠比', p.payoff.toFixed(2))}
      ${g('獲利因子', p.profitFactor.toFixed(2))}
    </div>
    ${s.open > 0 ? `<p class="hint" style="margin-top:12px">另有 ${s.open} 筆未平倉,未實現均報酬 ${pct(s.unrealAvgPct)}(不計入上方曲線)。</p>` : ''}

    <h2 class="block-head">交易紀錄 <span class="head-note">最新在上</span></h2>
    ${[...portfolio.cashLog].reverse().map(tradeRow).join('')}
  `;
}

// ---- 市場環境戳記(Minervini 心法:記錄「這筆交易是在什麼市場環境下做的」)----
function currentMarketEnv() {
  const m = state.market || {};
  const water = !m.available ? 'NA' : (m.riskOn ? 'ON' : 'DEF');
  const top = state.ranked && state.ranked[0];
  return {
    water,
    top: top ? top.etf : null,
    topName: top ? top.name : null,
    rot: rotationInfo(),
  };
}

// 每日記錄「當天最強板塊」,供輪動速度計算
function logSectorLeader(etf) {
  if (!etf) return;
  const today = new Date().toISOString().slice(0, 10);
  let log;
  try { log = JSON.parse(localStorage.getItem('sd_sector_log') || '[]'); } catch (e) { log = []; }
  if (log.length && log[log.length - 1].date === today) log[log.length - 1].etf = etf;
  else log.push({ date: today, etf });
  if (log.length > 15) log = log.slice(-15);
  try { localStorage.setItem('sd_sector_log', JSON.stringify(log)); } catch (e) { /* ignore */ }
}

// 輪動速度:近 5 個記錄日裡,板塊龍頭出現過幾種(換得越多 = 越像沒主線的震盪盤)
function rotationInfo() {
  let log;
  try { log = JSON.parse(localStorage.getItem('sd_sector_log') || '[]'); } catch (e) { return null; }
  const recent = log.slice(-5);
  if (recent.length < 3) return null; // 資料還不夠
  return { distinct: new Set(recent.map((x) => x.etf)).size, window: recent.length };
}

const WATER_LABEL = { ON: '進場許可', DEF: '防禦', NA: '—' };
function envStamp(env) {
  if (!env) return '';
  const parts = [`環境:${WATER_LABEL[env.water] || '—'}`];
  if (env.topName) parts.push(`龍頭 ${env.topName}`);
  if (env.rot) parts.push(`輪動 ${env.rot.distinct}/${env.rot.window}`);
  return `<span class="trade-env">${parts.join('　·　')}</span>`;
}

function tradeRow(c) {
  const win = c.pnlPct >= 0;
  return `
    <div class="trade ${win ? 'win' : 'loss'}">
      <div class="trade-main">
        <span class="ticker mono">${c.symbol}</span>
        <span class="trade-sub mono">$${c.entryPrice.toFixed(2)} → $${c.exitPrice.toFixed(2)}</span>
        <span class="trade-meta">${c.partial ? `減碼 ${Math.round((c.fraction ?? 1) * 100)}% · ` : ''}${c.reason || ''} · 持有 ${c.holdingDays ?? '?'} 天 · ${c.exitDate}</span>
        ${envStamp(c.entryEnv)}
      </div>
      <div class="trade-pnl mono ${cls(c.pnlPct)}">${pct(c.pnlPct)}</div>
    </div>`;
}

function renderBacktest() {
  return `
    <h2 class="block-head">長歷史資料 <span class="head-note">Stooq · ${config.HISTORY_YEARS || 16} 年 · 回測用</span></h2>
    <div class="warn-box">這份長歷史只給回測/驗證用,跟你每天的即時選股完全分開,存在瀏覽器 IndexedDB。
      <br>⚠️ universe 是「今天的贏家」,長歷史解決「樣本太短」,但<strong>解決不了生存者偏差</strong>——絕對報酬會偏樂觀,相對排名才可信。</div>
    ${histSection()}

    <h2 class="block-head">真實回測 <span class="head-note">綜合 preset · 16 年 · Calmar ${realBtResult ? realBtResult.metrics.calmar.toFixed(2) : '—'}</span></h2>
    <div class="warn-box">用上方載入的真實 16 年日線跑「綜合」preset:隔日開盤進場、OHLC 真 ATR 停損、市場水位過濾。
      <br>這是<strong>單一 preset</strong> 的驗證。下一步(B)會六姿態一起跑 + Monte Carlo,以 Calmar 排名。</div>
    ${!histMeta
      ? `<p class="empty">請先在上方「載入 16 年長歷史」,才能跑真實回測。</p>`
      : realBtRunning
        ? `<div class="loading" style="padding:32px"><div class="spinner"></div><p class="load-msg">回測 16 年中…</p></div>`
        : `${realBtResult ? backtestMetrics(realBtResult) : ''}
           <button class="btn ghost wide" id="run-real-bt">▶ 用真實 16 年資料回測(綜合)</button>`}

    <h2 class="block-head">六姿態比較 <span class="head-note">Monte Carlo 300 次 · Calmar 排名</span></h2>
    <div class="warn-box">六個 preset 各跑 16 年真實回測,再各做 300 次 block bootstrap(把日報酬打散重組),看績效換個順序還站不站得住。
      <br>看<strong>相對排名</strong>就好,絕對數字仍被生存者偏差灌水。<strong>Calmar 最差 5%</strong> 是壓力測試下的下限。</div>
    ${mcSection()}`;
}

function mcSection() {
  if (!histMeta) return `<p class="empty">請先載入長歷史。</p>`;
  if (mcRunning) {
    return `<div class="loading" style="padding:32px"><div class="spinner"></div><p class="load-msg">${mcProgress}</p></div>`;
  }
  if (mcError) return `<p class="empty">${mcError}</p><button class="btn buy wide" id="run-mc">▶ 重試</button>`;
  if (!mcResults) {
    return `<p class="empty">六姿態一起跑 + Monte Carlo(手機約 20~40 秒,中途會卡一下屬正常)。</p>
      <button class="btn buy wide" id="run-mc">▶ 跑六姿態 + Monte Carlo (300 次)</button>`;
  }
  const rows = mcResults.map((r, i) => {
    const win = i === 0;
    return `<tr class="${win ? 'mc-win' : ''}">
      <td class="mono">${i + 1}</td>
      <td>${r.label}${win ? ' 🏆' : ''}</td>
      <td class="mono">${r.mc.calmar.median.toFixed(2)}</td>
      <td class="mono down">${r.mc.calmar.p5.toFixed(2)}</td>
      <td class="mono up">${(r.mc.cagr.median * 100).toFixed(0)}%</td>
      <td class="mono down">${(r.mc.maxdd.median * 100).toFixed(0)}%</td>
      <td class="mono">${r.single.trades}</td>
    </tr>`;
  }).join('');
  return `
    <div class="mc-table-wrap"><table class="mc-table">
      <thead><tr>
        <th>#</th><th>姿態</th><th>Calmar<br>中位</th><th>Calmar<br>最差5%</th><th>CAGR<br>中位</th><th>MaxDD<br>中位</th><th>交易</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
    <p class="hint" style="margin-top:12px">冠軍 <strong>${mcResults[0].label}</strong>:Calmar 中位 ${mcResults[0].mc.calmar.median.toFixed(2)}、
    最差 5% 仍有 ${mcResults[0].mc.calmar.p5.toFixed(2)}。這是「風險調整後 + 耐操度」都最好的姿態。</p>
    <button class="btn ghost wide" id="run-mc" style="margin-top:12px">↻ 重跑</button>`;
}

function histSection() {
  if (histLoading) {
    return `<div class="loading" style="padding:32px 24px">
      <div class="spinner"></div><p class="load-msg">${histProgress}</p></div>`;
  }
  if (histMeta) {
    const ok = histMeta.symbols.length;
    const failed = histMeta.failed || [];
    return `
      <div class="bt-grid">
        <div class="bt-metric"><span>已載入</span><b class="mono">${ok} 檔</b></div>
        <div class="bt-metric"><span>載入日期</span><b class="mono">${(histMeta.loadedAt || '').slice(0, 10)}</b></div>
      </div>
      ${spySanity ? `<p class="hint" style="margin-top:12px">SPY 抽樣驗證:${spySanity.n} 根日線 · ${spySanity.from} ~ ${spySanity.to}</p>${equitySVGfromCloses(spySanity.closes)}` : ''}
      ${failed.length ? `<p class="empty">這幾檔 Stooq 沒回資料(限流或代號不符):${failed.join(', ')}。可再按重新載入補抓。</p>` : `<p class="hint">全部載入成功 ✓</p>`}
      <button class="btn ghost wide" id="reload-hist">↻ 重新載入長歷史</button>`;
  }
  return `<p class="empty">尚未載入。按下方一次把 ${config.HISTORY_YEARS || 16} 年日線拉回來(約 1~2 分鐘)。</p>
    <button class="btn buy wide" id="load-hist">▶ 載入 ${config.HISTORY_YEARS || 16} 年長歷史</button>`;
}

// 用一組收盤價畫線(SPY 抽樣驗證),跟 equitySVG 同風格
function equitySVGfromCloses(closes) {
  const w = 320, h = 90, n = closes.length;
  const min = Math.min(...closes), max = Math.max(...closes);
  const x = (i) => (i / (n - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min || 1)) * h;
  const d = closes.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  return `<svg class="equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="var(--heat)" stroke-width="1.5"/></svg>`;
}

function backtestMetrics(res) {
  const m = res.metrics;
  const g = (label, val, c = '') => `<div class="bt-metric"><span>${label}</span><b class="mono ${c}">${val}</b></div>`;
  return `
    ${equitySVG(res.equity)}
    <div class="bt-grid">
      ${g('總報酬', pct(m.totalReturn), cls(m.totalReturn))}
      ${g('年化 (CAGR)', pct(m.cagr), cls(m.cagr))}
      ${g('最大回撤', pct(m.maxDD), 'down')}
      ${g('夏普', m.sharpe.toFixed(2))}
      ${g('Calmar(報酬/回撤)', m.calmar.toFixed(2))}
      ${g('交易次數', m.trades)}
      ${g('勝率', pct(m.winRate, 0))}
    </div>`;
}

function equitySVG(equity) {
  const navs = equity.map((e) => e.nav);
  const w = 320, h = 90, n = navs.length;
  const min = Math.min(...navs), max = Math.max(...navs);
  const x = (i) => (i / (n - 1)) * w;
  const y = (v) => h - ((v - min) / (max - min || 1)) * h;
  const d = navs.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const up = navs[n - 1] >= navs[0];
  return `<svg class="equity" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <path d="${d}" fill="none" stroke="var(--${up ? 'buy' : 'sell'})" stroke-width="1.5"/>
  </svg>`;
}

// =============================================================
// 主渲染 + 事件
// =============================================================
// ---- 探索:候選驗證器 ----
function renderExplore() {
  const wl = getWatchlist();
  const picksN = state.buys.length, holdN = portfolio.positions.length;
  return `
    <h2 class="block-head">候選驗證器 <span class="head-note">Minervini 趨勢範本 · 硬驗證</span></h2>
    <div class="warn-box">貼代號、<strong>或整段貼文文字</strong>(自動抓 $代號/#代號),或用下方按鈕帶入。用真實資料跑完整 <strong>Minervini 趨勢範本</strong>:多頭排列(價>MA50>MA150>MA200)、距52週高≤25%、相對強度、流動性。這是嚴格的高標準篩,通過的才是 Stage 2 強勢股。</div>
    <div class="quick-fill">
      <button class="btn ghost sm" id="fill-picks">驗證今日精選${picksN ? ` (${picksN})` : ''}</button>
      <button class="btn ghost sm" id="fill-holdings">驗證持倉${holdN ? ` (${holdN})` : ''}</button>
    </div>
    <button class="btn buy wide" id="fetch-movers" style="margin-bottom:12px">▶ 抓今日熱門漲幅榜 → 自動驗證前 12</button>
    <textarea id="cand-input" class="cand-input" placeholder="貼代號或整段貼文,例:&#10;NVDA, AMZN, MU&#10;或「Micron #MU is testing its 50 day EMA…」">${escapeHtml(state.candInput || '')}</textarea>
    <button class="btn buy wide" id="verify-btn">▶ 驗證候選</button>
    ${wl.length ? `<div class="wl"><span class="wl-label">自訂觀察名單</span>${wl.map((s) => `<span class="wl-chip mono">${s}<button data-unwatch="${s}">×</button></span>`).join('')}<button class="btn ghost sm" id="reverify-watch" style="margin-left:auto">↻ 全部重驗 (${wl.length})</button></div>` : ''}
    ${exploreRunning ? `<div class="loading" style="padding:24px"><div class="spinner"></div><p class="load-msg">${exploreProgress}</p></div>` : ''}
    ${exploreResults ? renderExploreResults() : ''}`;
}

function renderExploreResults() {
  const passN = exploreResults.filter((r) => r.pass).length;
  return `
    <h2 class="block-head">驗證結果 <span class="head-note">${passN}/${exploreResults.length} 通過</span></h2>
    ${exploreResults.map((r) => {
      if (r.insufficient) {
        return `<div class="card"><div class="card-main"><div class="ticker mono">${r.symbol}</div>
          <div class="card-sub">資料不足(需 ≥200 日線算 MA200/52週高低)或代號無效</div></div></div>`;
      }
      const badge = r.pass ? `<span class="verdict pass">通過</span>` : `<span class="verdict fail">未通過</span>`;
      const mc = r.marketCap != null ? `　·　市值 $${(r.marketCap / 1e9).toFixed(1)}B` : '';
      const info = `<div class="levels mono muted">VCP ${r.vcp ? '收縮中 ✓' : '—'}　·　距52週高 ${pct(r.pctFrom52wHigh)}　·　RS ${pct(r.rsVsSpy)}${mc}</div>`;
      return `
        <div class="card ${r.pass ? '' : 'dim'}">
          <div class="card-main">
            <div class="ticker mono">${r.symbol} ${badge}</div>
            <div class="reasons">${r.checks.map((c) => `<span class="tag ${c.ok ? 'okc' : 'nok'}">${c.ok ? '✓' : '✗'} ${c.label}</span>`).join('')}</div>
            ${info}
            ${r.pass ? `<div class="levels mono">進場 約$${r.entry.toFixed(2)}　·　停損 $${r.stopPrice.toFixed(2)} (${pct(r.stopPct)})</div>` : ''}
          </div>
          <div class="card-side">
            <div class="price mono">$${r.price.toFixed(2)}</div>
            <div class="score">動能 ${r.score.toFixed(2)}</div>
            ${r.pass ? `<button class="btn ghost" data-watch="${r.symbol}">★ 觀察</button>` : ''}
          </div>
        </div>`;
    }).join('')}`;
}

function getWatchlist() { try { return JSON.parse(localStorage.getItem('sd_watchlist') || '[]'); } catch (e) { return []; } }
function saveWatch(s) { const w = getWatchlist(); if (!w.includes(s)) { w.push(s); localStorage.setItem('sd_watchlist', JSON.stringify(w)); } render(); }
function removeWatch(s) { localStorage.setItem('sd_watchlist', JSON.stringify(getWatchlist().filter((x) => x !== s))); render(); }
function escapeHtml(s) { return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }

const views = { today: renderToday, portfolio: renderPortfolio, sectors: renderSectors, explore: renderExplore, perf: renderPerf, backtest: renderBacktest };

function render() {
  const view = document.getElementById('view');
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === state.tab));
  document.getElementById('date-label').textContent = config.USE_REAL_DATA
    ? '即時' : state.date.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });

  if (state.error) {
    view.innerHTML = `<div class="warn-box" style="margin-top:24px">
      <strong>讀取失敗</strong><br>${state.error}
      <br><br>檢查:① config.js 的 WORKER_URL 是否填對 ② Worker 是否設好 TD_API_KEY secret
      ③ Twelve Data 額度是否用盡。</div>
      <button class="btn buy wide" id="retry">重試</button>`;
    document.getElementById('retry').onclick = () => { state.error = null; loadData(); };
    return;
  }
  if (state.loading) { renderLoading(); return; }

  view.innerHTML = views[state.tab]();
  bindViewEvents();
}

function renderLoading() {
  document.getElementById('view').innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <p class="load-msg">${state.loadMsg || '讀取中…'}</p>
    </div>`;
}

function bindViewEvents() {
  document.querySelectorAll('[data-buy]').forEach((el) =>
    el.onclick = async () => {
      const q = state.quotes.find((x) => x.symbol === el.dataset.buy);
      const stopPrice = q.atr
        ? q.price - q.atr * DP.atrStopMult
        : q.price * (1 + DP.stopLossPct);
      const r = portfolio.buy({ symbol: q.symbol, name: q.name, etf: q.etf, price: q.price, stopPrice, atr: q.atr, entryEnv: currentMarketEnv() });
      if (!r.ok) toast(r.msg); else toast(`已買進 ${q.symbol}`);
      await compute(); render();
    });
  document.querySelectorAll('[data-sell]').forEach((el) =>
    el.onclick = async () => {
      const q = state.quotes.find((x) => x.symbol === el.dataset.sell);
      const sig = state.sells.find((x) => x.symbol === el.dataset.sell);
      const env = currentMarketEnv();
      let r;
      if (sig && sig.fraction != null && sig.fraction < 1) {
        // 階梯停利:部分減碼
        r = portfolio.sellPartial(el.dataset.sell, q.price, sig.fraction, sig.reasons.join(' / '), sig.ladderIdx, env);
        if (r.ok) toast(`已減碼 ${el.dataset.sell} ${(sig.fraction * 100).toFixed(0)}% (${pct(r.pnlPct)})`);
      } else {
        // 全平(停損/破線/手動)
        const reason = sig ? sig.reasons.join(' / ') : '手動平倉';
        r = portfolio.sell(el.dataset.sell, q.price, reason, env);
        if (r.ok) toast(`已平倉 ${el.dataset.sell} (${pct(r.pnlPct)})`);
      }
      await compute(); render();
    });
  const loadHist = document.getElementById('load-hist');
  if (loadHist) loadHist.onclick = () => loadHistory();
  const reloadHist = document.getElementById('reload-hist');
  if (reloadHist) reloadHist.onclick = () => loadHistory();
  const runReal = document.getElementById('run-real-bt');
  if (runReal) runReal.onclick = async () => {
    realBtRunning = true; render();
    realBtResult = await runRealBacktestFromDB('composite');
    realBtRunning = false; render();
  };
  const runMc = document.getElementById('run-mc');
  if (runMc) runMc.onclick = () => runAllPresetsMC();
  const verifyBtn = document.getElementById('verify-btn');
  if (verifyBtn) verifyBtn.onclick = () => verifyCandidates();
  const fillPicks = document.getElementById('fill-picks');
  if (fillPicks) fillPicks.onclick = () => {
    const t = state.buys.map((b) => b.symbol);
    if (!t.length) { toast('今日沒有精選(空手或市場防禦)'); return; }
    verifyCandidates(t);
  };
  const fillHold = document.getElementById('fill-holdings');
  if (fillHold) fillHold.onclick = () => {
    const t = portfolio.positions.map((p) => p.symbol);
    if (!t.length) { toast('目前無持倉'); return; }
    verifyCandidates(t);
  };
  const fillWatch = document.getElementById('reverify-watch');
  if (fillWatch) fillWatch.onclick = () => {
    const t = getWatchlist();
    if (!t.length) { toast('觀察名單是空的'); return; }
    verifyCandidates(t);
  };
  document.querySelectorAll('[data-watch]').forEach((el) => el.onclick = () => saveWatch(el.dataset.watch));
  document.querySelectorAll('[data-unwatch]').forEach((el) => el.onclick = () => removeWatch(el.dataset.unwatch));
  const fetchMoversBtn = document.getElementById('fetch-movers');
  if (fetchMoversBtn) fetchMoversBtn.onclick = async () => {
    try {
      toast('抓取今日熱門漲幅榜(FMP)…');
      const movers = await fetchMovers('gainers');
      if (!movers.length) { toast('沒抓到熱門(檢查 Worker 的 FMP_API_KEY)'); return; }
      const clean = filterMovers(movers);
      if (!clean.length) { toast(`抓到 ${movers.length} 檔,但都是水餃股/槓桿ETF,已全濾掉`); return; }
      const top = clean.slice(0, 12).map((m) => m.symbol);
      toast(`抓到 ${movers.length} 檔 → 濾掉垃圾剩 ${clean.length} → 驗證前 ${top.length}…`);
      await verifyCandidates(top);
    } catch (e) { toast('熱門榜失敗:' + (e.message || e)); }
  };
}

// 抓 FMP 市值(透過 Worker),回 {SYM: marketCap}
async function fetchMarketCaps(tickers) {
  try {
    const u = `${config.WORKER_URL.replace(/\/$/, '')}/marketcap?symbols=${encodeURIComponent(tickers.join(','))}`;
    const r = await fetch(u);
    const d = await r.json();
    return d.marketCaps || {};
  } catch (e) { return {}; }
}

// 抓 FMP 熱門漲幅榜(透過 Worker),回 [{symbol,name,price,changePct}]
async function fetchMovers(type = 'gainers') {
  const u = `${config.WORKER_URL.replace(/\/$/, '')}/movers?type=${type}`;
  const r = await fetch(u);
  const d = await r.json();
  if (d.error) throw new Error(d.error);
  return d.movers || [];
}

// 前置過濾:濾掉水餃股、槓桿/反向 ETF、SPAC/認股權/單位(留下像樣的正常股票)
// 門檻可調:MIN_PRICE 是「像樣股價」下限。
function filterMovers(movers, minPrice = 10) {
  const JUNK = /(\b(2x|3x|daily|leverage|leveraged|direxion|proshares|granite|inverse|etf|etn|bull|bear)\b)|(\b(rights?|warrants?|units?)\b)|(acquisition corp)/i;
  return movers.filter((m) =>
    (m.price || 0) >= minPrice &&              // 去水餃股
    !JUNK.test(m.name || '') &&                // 去槓桿/反向 ETF、SPAC、認股權
    /^[A-Z]{1,5}$/.test(m.symbol || '')        // 只留正常股票代號
  );
}

// 抓任意代號的日線(候選驗證器用),回 {SYM: bars[]}
async function fetchCandidates(tickers) {
  const barsBySym = {};
  const BATCH = config.BATCH_SIZE || 8, GAP = config.BATCH_GAP_MS || 0;
  for (let i = 0; i < tickers.length; i += BATCH) {
    const batch = tickers.slice(i, i + BATCH);
    exploreProgress = `讀取 ${batch.join(', ')} …`; render();
    const u = `${config.WORKER_URL.replace(/\/$/, '')}/timeseries?symbols=${encodeURIComponent(batch.join(','))}&outputsize=${config.OUTPUT_SIZE}`;
    const r = await fetch(u);
    const d = await r.json();
    if (d.error) throw new Error(d.message || d.error);
    for (const s of batch) {
      const node = d[s] || d[s.toUpperCase()];
      const values = (node && node.values) || [];
      barsBySym[s] = values
        .map((v) => ({ h: parseFloat(v.high), l: parseFloat(v.low), c: parseFloat(v.close), v: parseFloat(v.volume) }))
        .filter((b) => !isNaN(b.c) && !isNaN(b.h) && !isNaN(b.l));
    }
    if (i + BATCH < tickers.length && GAP > 0) { exploreProgress = '等待額度重置…'; render(); await sleep(GAP); }
  }
  return barsBySym;
}

async function verifyCandidates(explicit) {
  let tickers;
  if (explicit && explicit.length) {
    tickers = [...new Set(explicit.map((t) => t.toUpperCase()))].slice(0, 24);
    state.candInput = tickers.join(', ');
  } else {
    const el = document.getElementById('cand-input');
    const raw = el ? el.value : '';
    state.candInput = raw;
    tickers = extractTickers(raw).slice(0, 24);
  }
  if (!tickers.length) { toast('沒抓到代號(試試貼含 $XXX 或 #XXX 的文字)'); return; }
  if (!config.WORKER_URL) { toast('尚未設定 Worker 網址'); return; }
  exploreRunning = true; exploreResults = null; render();
  try {
    // 取 SPY 6 個月報酬,供相對強度(RS)比較
    let spyRet6m = 0;
    try {
      const mkt = await adapter.getMarketSeries();
      const spy = mkt.spy || [];
      if (spy.length > 126) spyRet6m = (spy[spy.length - 1] - spy[spy.length - 1 - 126]) / spy[spy.length - 1 - 126];
    } catch (e) { /* 無 SPY 時 RS 用 0 基準 */ }

    const bars = await fetchCandidates(tickers);
    const caps = await fetchMarketCaps(tickers);   // FMP 免費市值
    const results = tickers.map((t) => {
      const m = quoteMetrics(bars[t]);
      if (!m) return { symbol: t, insufficient: true };
      const v = verifyTrendTemplate({ symbol: t, ...m, marketCap: caps[t] }, { spyRet6m }, DP);
      return { symbol: t, price: m.price, ...v };
    });
    results.sort((a, b) => (b.pass ? 1 : 0) - (a.pass ? 1 : 0) || (b.score ?? -9) - (a.score ?? -9));
    exploreResults = results;
  } catch (e) {
    toast('讀取失敗:' + (e.message || e));
  }
  exploreRunning = false; render();
}

// 從任意貼文文字抽出股票代號:優先 $代號 / #代號;沒有才退回大寫詞(去雜訊)
function extractTickers(text) {
  const tagged = [...text.matchAll(/[$#]([A-Za-z]{1,5})\b/g)].map((m) => m[1].toUpperCase());
  if (tagged.length) return [...new Set(tagged)];
  const STOP = new Set(['A','I','THE','AND','OR','IS','IT','ITS','TO','OF','IN','ON','AT','FOR','DAY','EMA','SMA','MA','RSI','ATR','IPO','CEO','CFO','ETF','AI','USD','US','EU','UK','NEW','BUY','SELL','HOLD','LOG','PE','PB','EPS','YOY','QOQ','YTD','ATH','ATL','Q1','Q2','Q3','Q4','FY','GDP','CPI','FED','ROE','ROI']);
  const toks = [...text.matchAll(/\b([A-Z]{1,5})\b/g)].map((m) => m[1]).filter((t) => !STOP.has(t));
  return [...new Set(toks)];
}

// 從 IndexedDB 一次讀齊所有 bars
async function loadAllBarsFromDB() {
  const symbols = [...UNIVERSE.map((u) => u.symbol), 'SPY'];
  const barsBySymbol = {};
  for (const s of symbols) {
    const b = await getBars(s);
    if (b && b.length) barsBySymbol[s] = b;
  }
  return barsBySymbol;
}

// 從 IndexedDB 讀真實長歷史,跑指定 preset 的回測
async function runRealBacktestFromDB(presetKey) {
  const barsBySymbol = await loadAllBarsFromDB();
  if (!barsBySymbol['SPY']) return null;
  const P = PRESETS[presetKey];
  return runRealBacktest({ barsBySymbol, params: P.params, market: P.market });
}

// 六姿態 + Monte Carlo
async function runAllPresetsMC() {
  mcRunning = true; mcError = null; mcResults = null; mcProgress = '讀取歷史資料…'; render();
  await sleep(30);
  const barsBySymbol = await loadAllBarsFromDB();
  if (!barsBySymbol['SPY']) { mcRunning = false; mcError = '找不到 SPY 歷史,請先載入長歷史。'; render(); return; }

  const results = [];
  for (const key of PRESET_ORDER) {
    mcProgress = `回測 + Monte Carlo:${PRESETS[key].label} … (${results.length + 1}/6)`;
    render();
    await sleep(30); // 讓進度先畫出來,再進重運算
    const P = PRESETS[key];
    const bt = runRealBacktest({ barsBySymbol, params: P.params, market: P.market });
    const mc = monteCarlo(bt.dailyReturns, 300, 20);
    results.push({ key, label: P.label, single: bt.metrics, mc });
    await sleep(0);
  }
  // 以 Calmar 中位數排名
  results.sort((a, b) => (b.mc?.calmar.median ?? -99) - (a.mc?.calmar.median ?? -99));
  mcResults = results; mcRunning = false; render();
}

// block bootstrap:把日報酬打散成長度相同的區塊重組,跑 runs 次,回各指標分佈
function monteCarlo(rets, runs = 300, blockSize = 20) {
  const n = rets.length;
  if (n < blockSize * 3) return { calmar: { median: 0, p5: 0 }, cagr: { median: 0, p5: 0 }, maxdd: { median: 0, worst: 0 }, sharpe: { median: 0 } };
  const nBlocks = Math.ceil(n / blockSize);
  const calmars = [], cagrs = [], maxdds = [], sharpes = [];
  for (let r = 0; r < runs; r++) {
    const series = [];
    for (let b = 0; b < nBlocks; b++) {
      const start = Math.floor(Math.random() * (n - blockSize));
      for (let k = 0; k < blockSize; k++) series.push(rets[start + k]);
    }
    series.length = n;
    let nav = 1, peak = 1, maxDD = 0, sum = 0;
    for (const x of series) { nav *= (1 + x); peak = Math.max(peak, nav); maxDD = Math.min(maxDD, nav / peak - 1); sum += x; }
    const years = n / 252;
    const cagr = Math.pow(Math.max(nav, 1e-9), 1 / years) - 1;
    const mean = sum / n;
    let v = 0; for (const x of series) v += (x - mean) ** 2;
    const sd = Math.sqrt(v / n) || 1e-9;
    cagrs.push(cagr); maxdds.push(maxDD);
    sharpes.push(mean / sd * Math.sqrt(252));
    calmars.push(maxDD !== 0 ? cagr / Math.abs(maxDD) : 0);
  }
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor(p * (s.length - 1))]; };
  return {
    calmar: { median: q(calmars, 0.5), p5: q(calmars, 0.05) },
    cagr: { median: q(cagrs, 0.5), p5: q(cagrs, 0.05) },
    maxdd: { median: q(maxdds, 0.5), worst: q(maxdds, 0.05) },
    sharpe: { median: q(sharpes, 0.5) },
  };
}

// ---- 載入長歷史(Stooq via Worker)存 IndexedDB ----
async function loadHistory() {
  histLoading = true; histProgress = '準備載入…'; render();
  const symbols = [...UNIVERSE.map((u) => u.symbol), 'SPY'];
  const failed = [];
  let done = 0;
  for (const sym of symbols) {
    histProgress = `讀取 ${sym} … (${done}/${symbols.length})`;
    render();
    try {
      const u = `${config.WORKER_URL.replace(/\/$/, '')}/history?symbol=${sym}&years=${config.HISTORY_YEARS || 16}`;
      const r = await fetch(u);
      const d = await r.json();
      if (d.bars && d.bars.length > 200) await putBars(sym, d.bars);
      else failed.push(sym);
    } catch (e) { failed.push(sym); }
    done++;
    await sleep(1200); // 對 Stooq 客氣,避免限流
  }
  histMeta = {
    loadedAt: new Date().toISOString(),
    symbols: symbols.filter((s) => !failed.includes(s)),
    failed, years: config.HISTORY_YEARS,
  };
  await putMeta(histMeta);
  await buildSpySanity();
  histLoading = false; render();
}

async function buildSpySanity() {
  try {
    const bars = await getBars('SPY');
    if (bars && bars.length) {
      const step = Math.max(1, Math.floor(bars.length / 300));
      const closes = bars.filter((_, i) => i % step === 0).map((b) => b.c);
      spySanity = { n: bars.length, from: bars[0].d, to: bars[bars.length - 1].d, closes };
    }
  } catch (e) { /* ignore */ }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// 簡易 toast
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---- 啟動 ----
async function init() {
  // 分頁切換
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.onclick = () => { state.tab = b.dataset.tab; render(); });

  const btn = document.getElementById('next-day');
  if (config.USE_REAL_DATA) {
    // 真實模式:按鈕 = 強制重抓今天的最新股價
    btn.textContent = '↻ 更新';
    btn.onclick = () => {
      if (adapter.forceRefresh) adapter.forceRefresh();
      toast('重新讀取最新股價…');
      loadData();
    };
  } else {
    // 模擬模式:按鈕 = 推進到下一個交易日
    btn.onclick = async () => {
      adapter.advanceDay();
      state.date = new Date(state.date.getTime() + 86400000);
      await compute(); render();
      toast('已更新到下一交易日');
    };
  }

  await loadData();

  // 還原長歷史載入狀態(不阻塞畫面)
  getMeta().then(async (m) => {
    if (m) { histMeta = m; await buildSpySanity(); if (state.tab === 'backtest') render(); }
  }).catch(() => {});
}

// 讀資料(含進度)+ 計算 + 渲染
async function loadData() {
  try {
    state.error = null;
    state.loading = true; state.loadMsg = '準備讀取…'; render();

    if (adapter.ensureLoaded) {
      await adapter.ensureLoaded((done, total, phase) => {
        state.loadMsg = phase === 'waiting'
          ? `已讀取 ${done}/${total} 檔 · 等待額度重置(免費層每分鐘 8 檔)…`
          : `讀取真實股價 ${done}/${total} 檔…`;
        renderLoading();
      });
    }
    await compute();
    state.loading = false;
    render();
  } catch (e) {
    state.loading = false;
    state.error = e.message || String(e);
    render();
  }
}

document.addEventListener('DOMContentLoaded', init);

// 註冊 Service Worker (PWA 離線能力)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

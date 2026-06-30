// =============================================================
// app.js — UI 主控 (把所有模組串起來、渲染畫面、處理互動)
// -------------------------------------------------------------
// 只負責「呈現 + 互動」。任何策略/資料的真正邏輯都在各自模組裡。
// =============================================================

import { MockDataAdapter, SECTORS, UNIVERSE } from './data.js';
import { rankSectors } from './sectors.js';
import { generateBuys, generateSells, MAX_POSITIONS, STRATEGY_PARAMS } from './strategy.js';
import { Portfolio } from './portfolio.js';
import { runBacktest } from './backtest.js';

const adapter = new MockDataAdapter();   // ← 之後換成真實 API adapter
const portfolio = new Portfolio();

let state = {
  tab: 'today',
  date: new Date(),
  quotes: [], ranked: [], buys: [], sells: [],
};

// ---- 每天重新計算: 報價 -> 板塊排名 -> 買賣訊號 ----
function compute() {
  state.quotes = adapter.getQuotes();
  portfolio.mark(state.quotes);
  state.ranked = rankSectors(adapter.getSectorETFs(), STRATEGY_PARAMS.hotSectorCount);
  state.buys = generateBuys(state.quotes, state.ranked, portfolio.positions);
  state.sells = generateSells(portfolio.positions, state.quotes, state.ranked);
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
  const slots = MAX_POSITIONS - portfolio.positions.length;

  return `
    <section class="summary">
      <div class="summary-row">
        <div class="metric"><span class="metric-label">持倉</span>
          <span class="metric-val mono">${s.open}<span class="slash">/${MAX_POSITIONS}</span></span></div>
        <div class="metric"><span class="metric-label">未實現均報酬</span>
          <span class="metric-val mono ${cls(s.unrealAvgPct)}">${pct(s.unrealAvgPct)}</span></div>
        <div class="metric"><span class="metric-label">已實現累計</span>
          <span class="metric-val mono ${cls(s.realizedSumPct)}">${pct(s.realizedSumPct)}</span></div>
      </div>
    </section>

    <h2 class="block-head"><span class="dot buy"></span>今日買進訊號
      <span class="head-note">${slots > 0 ? `還可進 ${slots} 倉` : '已滿倉'}</span></h2>
    ${state.buys.length === 0
      ? `<p class="empty">${slots <= 0 ? '已達 6 倉上限，今天不進場。' : '熱門板塊中沒有符合條件的標的，今天觀望。'}</p>`
      : state.buys.map(buyCard).join('')}

    <h2 class="block-head"><span class="dot sell"></span>今日賣出訊號</h2>
    ${state.sells.length === 0
      ? `<p class="empty">現有持倉皆未觸發出場條件，續抱。</p>`
      : state.sells.map(sellCard).join('')}
  `;
}

function buyCard(b) {
  return `
    <div class="card signal">
      <div class="card-main">
        <div class="ticker mono">${b.symbol}</div>
        <div class="card-sub">${b.name} · ${b.sectorName}</div>
        <div class="reasons">${b.reasons.map((r) => `<span class="tag">${r}</span>`).join('')}</div>
      </div>
      <div class="card-side">
        <div class="price mono">${money(b.price)}</div>
        <div class="score">動能 ${b.score.toFixed(2)}</div>
        <button class="btn buy" data-buy="${b.symbol}">買進</button>
      </div>
    </div>`;
}

function sellCard(s) {
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
        <button class="btn sell" data-sell="${s.symbol}">賣出</button>
      </div>
    </div>`;
}

function renderPortfolio() {
  if (portfolio.positions.length === 0) {
    return `<p class="empty big">目前空倉。到「今日」分頁依買進訊號建倉，最多 6 檔。</p>`;
  }
  return `
    <h2 class="block-head">現有持倉 <span class="head-note">${portfolio.positions.length}/${MAX_POSITIONS}</span></h2>
    ${portfolio.positions.map((p) => {
      const last = p.lastPrice ?? p.entryPrice;
      const pnl = (last - p.entryPrice) / p.entryPrice;
      const secName = SECTORS.find((x) => x.etf === p.etf)?.name || p.etf;
      return `
        <div class="card pos">
          <div class="card-main">
            <div class="ticker mono">${p.symbol}</div>
            <div class="card-sub">${p.name} · ${secName} · 進場 ${p.entryDate}</div>
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
    <h2 class="block-head">板塊熱度排名 <span class="head-note">前 ${STRATEGY_PARAMS.hotSectorCount} 名才選股</span></h2>
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

let backtestResult = null;
function renderBacktest() {
  const body = backtestResult ? backtestMetrics(backtestResult) : `
    <p class="empty big">尚未回測。按下方按鈕，用內建<strong>合成資料</strong>跑一次完整策略流程。</p>`;
  return `
    <h2 class="block-head">回測 <span class="head-note">合成資料 · 僅驗證流程</span></h2>
    <div class="warn-box">⚠️ 這裡跑的是模擬出來的假行情，只證明「策略邏輯沒 bug、跑得動」。
      要回答「長期是否賺錢 / 高報酬」，請把 <code>data.js</code> 的歷史資料換成真實日線，再跑你的 Monte Carlo。</div>
    ${body}
    <button class="btn buy wide" id="run-bt">▶ 用合成資料跑回測</button>`;
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
const views = { today: renderToday, portfolio: renderPortfolio, sectors: renderSectors, backtest: renderBacktest };

function render() {
  document.getElementById('view').innerHTML = views[state.tab]();
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === state.tab));
  document.getElementById('date-label').textContent =
    state.date.toLocaleDateString('zh-TW', { month: 'long', day: 'numeric', weekday: 'short' });
  bindViewEvents();
}

function bindViewEvents() {
  document.querySelectorAll('[data-buy]').forEach((el) =>
    el.onclick = () => {
      const q = state.quotes.find((x) => x.symbol === el.dataset.buy);
      const r = portfolio.buy({ symbol: q.symbol, name: q.name, etf: q.etf, price: q.price });
      if (!r.ok) toast(r.msg); else toast(`已買進 ${q.symbol}`);
      compute(); render();
    });
  document.querySelectorAll('[data-sell]').forEach((el) =>
    el.onclick = () => {
      const q = state.quotes.find((x) => x.symbol === el.dataset.sell);
      const r = portfolio.sell(el.dataset.sell, q.price);
      if (r.ok) toast(`已平倉 ${el.dataset.sell} (${pct(r.pnlPct)})`);
      compute(); render();
    });
  const runBt = document.getElementById('run-bt');
  if (runBt) runBt.onclick = () => { backtestResult = buildAndRunBacktest(); render(); };
}

// 用 adapter 的歷史資料組 priceMatrix 給回測引擎 (之後換真實資料即可)
function buildAndRunBacktest() {
  const days = 252 * 3; // 3 年
  const priceMatrix = {};
  // 為了有足夠長度，臨時用一個新的模擬器產生較長的歷史
  const sim = new MockDataAdapter(987654);
  for (let i = 0; i < days; i++) sim.advanceDay();
  UNIVERSE.forEach((u) => { priceMatrix[u.symbol] = sim.getHistorical(u.symbol, days); });
  const dates = Array.from({ length: priceMatrix[UNIVERSE[0].symbol].length },
    (_, i) => `D${i}`);
  return runBacktest({ priceMatrix, dates });
}

// 簡易 toast
let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg; t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
}

// ---- 啟動 ----
function init() {
  // 分頁切換
  document.querySelectorAll('.tabbar button').forEach((b) =>
    b.onclick = () => { state.tab = b.dataset.tab; render(); });
  // 模擬「下一個交易日」(真實版改成每天自動抓 API)
  document.getElementById('next-day').onclick = () => {
    adapter.advanceDay();
    state.date = new Date(state.date.getTime() + 86400000);
    compute(); render();
    toast('已更新到下一交易日');
  };
  compute();
  render();
}

document.addEventListener('DOMContentLoaded', init);

// 註冊 Service Worker (PWA 離線能力)
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () =>
    navigator.serviceWorker.register('./sw.js').catch(() => {}));
}

// =============================================================
// app.js — UI 主控 (把所有模組串起來、渲染畫面、處理互動)
// -------------------------------------------------------------
// 只負責「呈現 + 互動」。任何策略/資料的真正邏輯都在各自模組裡。
// =============================================================

import { MockDataAdapter, SECTORS, UNIVERSE } from './data.js';
import { RealDataAdapter } from './data-real.js';
import { config } from './config.js';
import { rankSectors } from './sectors.js';
import { generateBuys, generateSells, buyDiagnostic, computeStops, MAX_POSITIONS, STRATEGY_PARAMS } from './strategy.js';
import { Portfolio } from './portfolio.js';
import { computeMarketGate, MARKET_PARAMS } from './market.js';
import { putBars, getBars, putMeta, getMeta, clearAll } from './histdb.js';
import { runBacktest } from './backtest.js';

// 依 config 選資料來源:真實(Twelve Data / Worker)或模擬
const adapter = config.USE_REAL_DATA ? new RealDataAdapter(config) : new MockDataAdapter();
const portfolio = new Portfolio();

let state = {
  tab: 'today',
  date: new Date(),
  quotes: [], ranked: [], buys: [], sells: [],
  loading: false, loadMsg: '',
};

// ---- 每天重新計算: 報價 -> 板塊排名 -> 買賣訊號 ----
async function compute() {
  state.quotes = await adapter.getQuotes();
  portfolio.mark(state.quotes);
  state.ranked = rankSectors(await adapter.getSectorETFs(), STRATEGY_PARAMS.hotSectorCount);

  // 不重複:算出還在冷卻期(近 N 天賣掉)的代號,買進時排除
  const recentlySold = recentlySoldSymbols(STRATEGY_PARAMS.reentryCooldownDays);

  state.buys = generateBuys(state.quotes, state.ranked, portfolio.positions, STRATEGY_PARAMS, recentlySold);
  state.sells = generateSells(portfolio.positions, state.quotes, state.ranked);

  // 若今天沒補滿,算一下「差在哪」給使用者看(證明是門檻在把關)
  state.buyDiag = buyDiagnostic(state.quotes, state.ranked, portfolio.positions, STRATEGY_PARAMS, recentlySold);

  // AI 水位:市場層級總開關(防禦時暫停進場)
  const mkt = await adapter.getMarketSeries();
  state.market = computeMarketGate(mkt.spy, mkt.vix, MARKET_PARAMS);
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
  const slots = MAX_POSITIONS - portfolio.positions.length;
  const blocked = state.market && state.market.available && !state.market.riskOn;

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
    <h2 class="block-head">現有持倉 <span class="head-note">${portfolio.positions.length}/${MAX_POSITIONS}</span></h2>
    ${portfolio.positions.map((p) => {
      const q = quoteBy[p.symbol];
      const last = q ? q.price : (p.lastPrice ?? p.entryPrice);
      const pnl = (last - p.entryPrice) / p.entryPrice;
      const secName = SECTORS.find((x) => x.etf === p.etf)?.name || p.etf;
      const { hardStop, trailStop, effStop } = computeStops(p, STRATEGY_PARAMS);
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

function tradeRow(c) {
  const win = c.pnlPct >= 0;
  return `
    <div class="trade ${win ? 'win' : 'loss'}">
      <div class="trade-main">
        <span class="ticker mono">${c.symbol}</span>
        <span class="trade-sub mono">$${c.entryPrice.toFixed(2)} → $${c.exitPrice.toFixed(2)}</span>
        <span class="trade-meta">${c.partial ? `減碼 ${Math.round((c.fraction ?? 1) * 100)}% · ` : ''}${c.reason || ''} · 持有 ${c.holdingDays ?? '?'} 天 · ${c.exitDate}</span>
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

    <h2 class="block-head">合成資料回測 <span class="head-note">流程驗證(舊)</span></h2>
    <div class="warn-box">下面是<strong>合成假資料</strong>,只證明引擎沒 bug。真正的「六姿態 + Monte Carlo」會用上面那份真實長歷史,是下一步。</div>
    ${backtestResult ? backtestMetrics(backtestResult) : ''}
    <button class="btn ghost wide" id="run-bt">▶ 用合成資料跑一次(驗流程)</button>`;
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
const views = { today: renderToday, portfolio: renderPortfolio, sectors: renderSectors, perf: renderPerf, backtest: renderBacktest };

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
        ? q.price - q.atr * STRATEGY_PARAMS.atrStopMult
        : q.price * (1 + STRATEGY_PARAMS.stopLossPct);
      const r = portfolio.buy({ symbol: q.symbol, name: q.name, etf: q.etf, price: q.price, stopPrice, atr: q.atr });
      if (!r.ok) toast(r.msg); else toast(`已買進 ${q.symbol}`);
      await compute(); render();
    });
  document.querySelectorAll('[data-sell]').forEach((el) =>
    el.onclick = async () => {
      const q = state.quotes.find((x) => x.symbol === el.dataset.sell);
      const sig = state.sells.find((x) => x.symbol === el.dataset.sell);
      let r;
      if (sig && sig.fraction != null && sig.fraction < 1) {
        // 階梯停利:部分減碼
        r = portfolio.sellPartial(el.dataset.sell, q.price, sig.fraction, sig.reasons.join(' / '), sig.ladderIdx);
        if (r.ok) toast(`已減碼 ${el.dataset.sell} ${(sig.fraction * 100).toFixed(0)}% (${pct(r.pnlPct)})`);
      } else {
        // 全平(停損/破線/手動)
        const reason = sig ? sig.reasons.join(' / ') : '手動平倉';
        r = portfolio.sell(el.dataset.sell, q.price, reason);
        if (r.ok) toast(`已平倉 ${el.dataset.sell} (${pct(r.pnlPct)})`);
      }
      await compute(); render();
    });
  const runBt = document.getElementById('run-bt');
  if (runBt) runBt.onclick = async () => {
    runBt.disabled = true; runBt.textContent = '回測中…';
    backtestResult = await buildAndRunBacktest(); render();
  };
  const loadHist = document.getElementById('load-hist');
  if (loadHist) loadHist.onclick = () => loadHistory();
  const reloadHist = document.getElementById('reload-hist');
  if (reloadHist) reloadHist.onclick = () => loadHistory();
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

// 用 adapter 的歷史資料組 priceMatrix 給回測引擎 (之後換真實資料即可)
async function buildAndRunBacktest() {
  const days = 252 * 3; // 3 年
  const priceMatrix = {};
  // 為了有足夠長度，臨時用一個新的模擬器產生較長的歷史
  const sim = new MockDataAdapter(987654);
  for (let i = 0; i < days; i++) sim.advanceDay();
  for (const u of UNIVERSE) priceMatrix[u.symbol] = await sim.getHistorical(u.symbol, days);
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

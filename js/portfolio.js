// =============================================================
// portfolio.js — 持倉管理 (需求 1: 永遠不超過 6 倉) + 本地儲存
// -------------------------------------------------------------
// 持倉狀態存在 localStorage，重開 App 不會掉。
// 部署成真正的 PWA 後，這就是離線可用的本地資料庫。
// =============================================================

import { MAX_POSITIONS } from './strategy.js';

const STORAGE_KEY = 'usstock_portfolio_v1';

export class Portfolio {
  constructor() {
    this.positions = []; // { symbol, name, etf, shares, entryPrice, entryDate, peakPrice }
    this.cashLog = [];   // 已實現損益紀錄 (供回測 / 績效統計)
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const data = JSON.parse(raw);
        this.positions = data.positions || [];
        this.cashLog = data.cashLog || [];
      }
    } catch (e) { /* 第一次使用，沒資料是正常的 */ }
  }

  save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        positions: this.positions, cashLog: this.cashLog,
      }));
    } catch (e) { console.warn('儲存失敗', e); }
  }

  isFull() { return this.positions.length >= MAX_POSITIONS; }
  has(symbol) { return this.positions.some((p) => p.symbol === symbol); }

  // 買進。需求 1: 滿 6 倉或已持有 -> 拒絕。
  buy({ symbol, name, etf, price, shares = 1 }) {
    if (this.isFull()) return { ok: false, msg: '已達 6 倉上限' };
    if (this.has(symbol)) return { ok: false, msg: '已持有此標的' };
    this.positions.push({
      symbol, name, etf, shares,
      entryPrice: price, peakPrice: price,
      entryDate: new Date().toISOString().slice(0, 10),
    });
    this.save();
    return { ok: true };
  }

  // 賣出 (平倉)，把已實現損益記進 cashLog
  sell(symbol, price) {
    const i = this.positions.findIndex((p) => p.symbol === symbol);
    if (i < 0) return { ok: false, msg: '未持有' };
    const pos = this.positions[i];
    const pnlPct = (price - pos.entryPrice) / pos.entryPrice;
    this.cashLog.push({
      symbol, entryPrice: pos.entryPrice, exitPrice: price, pnlPct,
      entryDate: pos.entryDate, exitDate: new Date().toISOString().slice(0, 10),
    });
    this.positions.splice(i, 1);
    this.save();
    return { ok: true, pnlPct };
  }

  // 每日用最新報價更新持倉的現價與「持倉最高價」(移動停利要用)
  mark(quotes) {
    const by = Object.fromEntries(quotes.map((q) => [q.symbol, q]));
    for (const pos of this.positions) {
      const q = by[pos.symbol];
      if (!q) continue;
      pos.lastPrice = q.price;
      pos.peakPrice = Math.max(pos.peakPrice ?? pos.entryPrice, q.price);
    }
    this.save();
  }

  // 未實現損益統計
  stats() {
    let unreal = 0;
    for (const p of this.positions) {
      if (p.lastPrice) unreal += (p.lastPrice - p.entryPrice) / p.entryPrice;
    }
    const realized = this.cashLog.reduce((a, c) => a + c.pnlPct, 0);
    const wins = this.cashLog.filter((c) => c.pnlPct > 0).length;
    return {
      open: this.positions.length,
      unrealAvgPct: this.positions.length ? unreal / this.positions.length : 0,
      realizedSumPct: realized,
      trades: this.cashLog.length,
      winRate: this.cashLog.length ? wins / this.cashLog.length : 0,
    };
  }

  reset() {
    this.positions = []; this.cashLog = []; this.save();
  }
}

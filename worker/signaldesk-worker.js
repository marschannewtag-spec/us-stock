// =============================================================
// signaldesk-worker.js — Cloudflare Worker(Twelve Data 代理)
// -------------------------------------------------------------
// 作用:
//   1. 把 Twelve Data 的 API key 藏在 Worker secret(TD_API_KEY),前端永遠看不到、
//      也不會被推上 GitHub。
//   2. 解決 CORS:前端只打這支 Worker,由 Worker 去打 Twelve Data。
//   3. 把回傳統一整理成 { "SYMBOL": { values:[...] } } 的格式,前端好處理。
//   4. 每次呼叫最多 8 檔 —— 對齊 Twelve Data 免費層「每分鐘 8 credits」的限制,
//      避免單一請求就 429。
//
// 部署方式(兩擇一):
//   A) Cloudflare 儀表板 → Workers → Create → 貼上這整支 → Deploy
//      然後 Settings → Variables → 新增 Secret:TD_API_KEY = 你的 Twelve Data key
//   B) 用 wrangler:見 README「部署 Worker」。
//
// 端點:
//   GET /timeseries?symbols=XLK,XLF,AAPL&outputsize=260
//     -> { "XLK": {values:[{datetime,close,...}...]}, "XLF": {...}, ... }
// =============================================================

const MAX_SYMBOLS_PER_CALL = 8; // 對齊免費層 8 credits/分

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS 預檢
    if (request.method === 'OPTIONS') {
      return withCORS(new Response(null, { status: 204 }), env);
    }

    if (url.pathname === '/timeseries') {
      const symbolsParam = url.searchParams.get('symbols');
      const outputsize = url.searchParams.get('outputsize') || '260';

      if (!symbolsParam) {
        return withCORS(json({ error: 'symbols 參數必填' }, 400), env);
      }
      const list = symbolsParam.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
      if (list.length === 0) {
        return withCORS(json({ error: 'symbols 為空' }, 400), env);
      }
      if (list.length > MAX_SYMBOLS_PER_CALL) {
        return withCORS(json({ error: `一次最多 ${MAX_SYMBOLS_PER_CALL} 檔(免費層限制)` }, 400), env);
      }
      if (!env.TD_API_KEY) {
        return withCORS(json({ error: 'Worker 未設定 TD_API_KEY secret' }, 500), env);
      }

      const api = 'https://api.twelvedata.com/time_series'
        + `?symbol=${encodeURIComponent(list.join(','))}`
        + '&interval=1day'
        + `&outputsize=${encodeURIComponent(outputsize)}`
        + '&order=ASC'                       // 舊 -> 新,最後一筆就是最新
        + `&apikey=${env.TD_API_KEY}`;

      let raw;
      try {
        const r = await fetch(api, { cf: { cacheTtl: 300, cacheEverything: true } });
        raw = await r.json();
      } catch (e) {
        return withCORS(json({ error: '打 Twelve Data 失敗', detail: String(e) }, 502), env);
      }

      // Twelve Data 錯誤(key 無效 / 額度用盡 429 等)會回 { status:'error', ... }
      if (raw && raw.status === 'error') {
        return withCORS(json({ error: 'twelvedata', code: raw.code, message: raw.message }, 502), env);
      }

      // 統一格式:單檔時 Twelve Data 直接回 {meta,values};多檔時回 {SYMBOL:{...}}
      let normalized;
      if (raw && raw.values) {
        normalized = { [list[0]]: { values: raw.values } };
      } else {
        normalized = {};
        for (const sym of list) {
          const node = raw[sym];
          normalized[sym] = { values: node && node.values ? node.values : [] };
        }
      }

      return withCORS(json(normalized), env);
    }

    // ── 長歷史(回測用):代理 Stooq CSV,回 OHLC ──
    if (url.pathname === '/history') {
      const symbol = (url.searchParams.get('symbol') || '').trim().toLowerCase();
      const years = parseInt(url.searchParams.get('years') || '16', 10);
      if (!symbol) return withCORS(json({ error: 'symbol 必填' }, 400), env);

      const d2 = new Date();
      const d1 = new Date(); d1.setFullYear(d1.getFullYear() - years);
      const fmt = (d) => d.toISOString().slice(0, 10).replace(/-/g, '');
      const stooqUrl = `https://stooq.com/q/d/l/?s=${encodeURIComponent(symbol)}.us&i=d`
        + `&d1=${fmt(d1)}&d2=${fmt(d2)}`;

      let csv;
      try {
        const r = await fetch(stooqUrl, { cf: { cacheTtl: 86400, cacheEverything: true } });
        csv = await r.text();
      } catch (e) {
        return withCORS(json({ error: 'stooq 抓取失敗', detail: String(e) }, 502), env);
      }
      // Stooq 找不到會回 HTML 或 "No data"
      if (!csv || csv.startsWith('<') || /no data|exceeded|limit/i.test(csv)) {
        return withCORS(json({ symbol: symbol.toUpperCase(), bars: [], note: 'stooq 無資料或限流' }), env);
      }

      const lines = csv.trim().split('\n');
      const bars = [];
      for (let i = 1; i < lines.length; i++) { // 跳過表頭 Date,Open,High,Low,Close,Volume
        const p = lines[i].split(',');
        if (p.length < 5) continue;
        const o = +p[1], h = +p[2], l = +p[3], c = +p[4];
        if (isNaN(c) || isNaN(h) || isNaN(l)) continue;
        bars.push({ d: p[0], o, h, l, c });
      }
      return withCORS(json({ symbol: symbol.toUpperCase(), bars }), env);
    }

    return withCORS(json({ error: 'not found' }, 404), env);
  },
};

// ---- helpers ----
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function withCORS(resp, env) {
  // 想鎖來源就把 * 換成你的網域(例:https://你的帳號.github.io),避免額度被別人用掉
  const origin = (env && env.ALLOWED_ORIGIN) ? env.ALLOWED_ORIGIN : '*';
  resp.headers.set('Access-Control-Allow-Origin', origin);
  resp.headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  resp.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  return resp;
}

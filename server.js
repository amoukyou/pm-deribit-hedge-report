const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3456;
const BASE = __dirname;
const SPREAD_WIDTH = 1000;
const REFRESH_INTERVAL = 30000; // 30s

// --- SQLite ---
const db = new DatabaseSync(path.join(BASE, 'monitor.db'));
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT, strategy TEXT, direction TEXT, question TEXT,
    pm_date TEXT, strike TEXT, pm_ask REAL, deribit_desc TEXT,
    deribit_q REAL, qp REAL, time_diff INTEGER,
    pm_link TEXT, deribit_link TEXT,
    leg1_name TEXT, leg1_action TEXT, leg1_price REAL,
    leg2_name TEXT, leg2_action TEXT, leg2_price REAL,
    underlying REAL, spread_width REAL,
    updated_at TEXT
  )
`);
db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);

// --- HTTP fetch ---
function fetchJSON(url) {
  return new Promise((resolve) => {
    const mod = url.startsWith('https') ? https : http;
    const req = mod.get(url, { headers: { 'User-Agent': 'PMDeribitMonitor/1.0' }, timeout: 8000 }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

// --- Load market metadata ---
let markets = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(BASE, 'data.json'), 'utf8'));
  markets = raw.markets || [];
  console.log(`Loaded ${markets.length} markets from data.json`);
} catch { console.error('Run fetch_data.py first'); }

// --- Batch fetch with concurrency ---
async function batchFetch(tasks, concurrency = 20) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) { const i = idx++; results[i] = await tasks[i](); }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

async function getPMBestAsk(tokenId) {
  const book = await fetchJSON(`https://clob.polymarket.com/book?token_id=${tokenId}`);
  if (!book) return null;
  const asks = book.asks || [];
  return asks.length > 0 ? parseFloat(asks[asks.length - 1].price) : null;
}

async function getDeribitTicker(instrument) {
  const data = await fetchJSON(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrument}`);
  if (!data || !data.result) return { bid: null, ask: null, mark: null, underlying: null };
  const r = data.result;
  return { bid: r.best_bid_price, ask: r.best_ask_price, mark: r.mark_price, underlying: r.underlying_price };
}

// --- Background data refresh ---
async function refreshData() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] Refreshing...`);

  const refTicker = await getDeribitTicker('BTC-17MAR26-74000-C');
  const underlying = refTicker.underlying || 73500;

  // Collect all fetch tasks
  const pmTasks = [];
  const dbTasks = [];
  const metas = [];

  for (const m of markets) {
    const yesIdx = pmTasks.length;
    pmTasks.push(() => getPMBestAsk(m.pm_yes_token));
    const noIdx = pmTasks.length;
    pmTasks.push(() => getPMBestAsk(m.pm_no_token));

    if (m.type === 'Above') {
      const K = m.strike;
      const dbPrefix = m.deribit_instrument;
      const k2 = K + SPREAD_WIDTH, k1 = K - SPREAD_WIDTH;
      const dbK2 = dbPrefix.replace(`-${K}`, `-${k2}`);
      const dbK1 = dbPrefix.replace(`-${K}`, `-${k1}`);

      const ci = [dbTasks.length]; dbTasks.push(() => getDeribitTicker(`${dbPrefix}-C`));
      ci.push(dbTasks.length); dbTasks.push(() => getDeribitTicker(`${dbK2}-C`));
      ci.push(dbTasks.length); dbTasks.push(() => getDeribitTicker(`${dbPrefix}-P`));
      ci.push(dbTasks.length); dbTasks.push(() => getDeribitTicker(`${dbK1}-P`));

      metas.push({ m, yesIdx, noIdx, type: 'Above', K, k2, k1, dbPrefix, ci });
    } else {
      metas.push({ m, yesIdx, noIdx, type: 'Range' });
    }
  }

  const [pmR, dbR] = await Promise.all([
    batchFetch(pmTasks, 20),
    batchFetch(dbTasks, 15)
  ]);

  // Build rows and write to DB
  const now = new Date().toISOString();
  const insert = db.prepare(`INSERT INTO monitor (type,strategy,direction,question,pm_date,strike,pm_ask,deribit_desc,deribit_q,qp,time_diff,pm_link,deribit_link,leg1_name,leg1_action,leg1_price,leg2_name,leg2_action,leg2_price,underlying,spread_width,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.exec('DELETE FROM monitor');
  for (const meta of metas) {
    const { m } = meta;
    const yesAsk = pmR[meta.yesIdx];
    const noAsk = pmR[meta.noIdx];

    if (meta.type === 'Above') {
      const { K, k2, k1, dbPrefix, ci } = meta;
      const callK = dbR[ci[0]], callK2 = dbR[ci[1]], putK = dbR[ci[2]], putK1 = dbR[ci[3]];

      // #1: sell K call (at bid), buy K+1000 call (at ask)
      let q1 = null;
      if (callK.bid != null && callK2.ask != null) q1 = (callK.bid - callK2.ask) * underlying / SPREAD_WIDTH;
      const qp1 = (q1 != null && yesAsk != null) ? +(q1 - yesAsk).toFixed(4) : null;
      insert.run('Above', '#1', 'Buy Yes', m.question, m.pm_date, String(K), yesAsk,
        `Sell ${K}C / Buy ${k2}C`, q1, qp1, m.time_diff_hours,
        `https://polymarket.com/event/${m.pm_event_slug}`, `https://www.deribit.com/options/BTC/${dbPrefix}-C`,
        `${dbPrefix}-C`, 'Sell', callK.bid,
        `${dbPrefix.replace(`-${K}`,`-${k2}`)}-C`, 'Buy', callK2.ask,
        underlying, SPREAD_WIDTH, now);

      // #3: sell K put (at bid), buy K-1000 put (at ask)
      let q3 = null;
      if (putK.bid != null && putK1.ask != null) q3 = (putK.bid - putK1.ask) * underlying / SPREAD_WIDTH;
      const qp3 = (q3 != null && noAsk != null) ? +(q3 - noAsk).toFixed(4) : null;
      insert.run('Above', '#3', 'Buy No', m.question, m.pm_date, String(K), noAsk,
        `Sell ${K}P / Buy ${k1}P`, q3, qp3, m.time_diff_hours,
        `https://polymarket.com/event/${m.pm_event_slug}`, `https://www.deribit.com/options/BTC/${dbPrefix}-P`,
        `${dbPrefix}-P`, 'Sell', putK.bid,
        `${dbPrefix.replace(`-${K}`,`-${k1}`)}-P`, 'Buy', putK1.ask,
        underlying, SPREAD_WIDTH, now);
    } else {
      insert.run('Range', '#9', 'Buy Yes', m.question, m.pm_date, JSON.stringify(m.strike), yesAsk, 'Iron Butterfly', null, null, m.time_diff_hours, `https://polymarket.com/event/${m.pm_event_slug}`, null, null,null,null, null,null,null, underlying, null, now);
      insert.run('Range', '#11', 'Buy No', m.question, m.pm_date, JSON.stringify(m.strike), noAsk, 'Rev Iron Butterfly', null, null, m.time_diff_hours, `https://polymarket.com/event/${m.pm_event_slug}`, null, null,null,null, null,null,null, underlying, null, now);
    }
  }

  // Store meta
  const upsert = db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)`);
  upsert.run('underlying', String(underlying));
  upsert.run('updated_at', now);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  const count = db.prepare('SELECT COUNT(*) as c FROM monitor').get().c;
  console.log(`  Done: ${count} rows in ${elapsed}s`);
}

// --- API: read from DB (instant) ---
function getMonitorData() {
  const rows = db.prepare('SELECT * FROM monitor ORDER BY qp DESC').all();
  const underlying = parseFloat(db.prepare("SELECT value FROM meta WHERE key='underlying'").get()?.value || '73500');
  const updated = db.prepare("SELECT value FROM meta WHERE key='updated_at'").get()?.value || null;
  return { updated_at: updated, underlying, rows };
}

// --- HTTP Server ---
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json' };

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/monitor') {
    const data = getMonitorData();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  let filePath = path.join(BASE, req.url === '/' ? 'index.html' : req.url);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n  PM × Deribit Monitor`);
  console.log(`  Dashboard: http://localhost:${PORT}/ch4.html`);
  console.log(`  API: http://localhost:${PORT}/api/monitor`);
  console.log(`  Refresh: every ${REFRESH_INTERVAL/1000}s\n`);

  // First fetch, then schedule
  refreshData().then(() => {
    setInterval(refreshData, REFRESH_INTERVAL);
  });
});

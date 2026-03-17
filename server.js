const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const PORT = 3456;
const BASE = __dirname;
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
    leg3_name TEXT, leg3_action TEXT, leg3_price REAL,
    leg4_name TEXT, leg4_action TEXT, leg4_price REAL,
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

// --- Load Deribit available strikes per expiry ---
let deribitStrikes = {}; // { '17MAR26': [63000, 64000, ...], ... }

async function loadDeribitStrikes() {
  const data = await fetchJSON('https://www.deribit.com/api/v2/public/get_instruments?currency=BTC&kind=option&expired=false');
  if (!data || !data.result) return;
  deribitStrikes = {};
  for (const inst of data.result) {
    const name = inst.instrument_name; // BTC-17MAR26-74000-C
    const parts = name.split('-');
    const expiry = parts[1]; // 17MAR26
    if (!deribitStrikes[expiry]) deribitStrikes[expiry] = new Set();
    deribitStrikes[expiry].add(inst.strike);
  }
  // Convert to sorted arrays
  for (const exp in deribitStrikes) {
    deribitStrikes[exp] = [...deribitStrikes[exp]].sort((a, b) => a - b);
  }
  console.log(`  Loaded Deribit strikes for ${Object.keys(deribitStrikes).length} expiries`);
}

function findNextStrike(expiry, K, direction) {
  // direction: 'up' = next higher, 'down' = next lower
  const strikes = deribitStrikes[expiry];
  if (!strikes) return null;
  if (direction === 'up') {
    return strikes.find(s => s > K) || null;
  } else {
    for (let i = strikes.length - 1; i >= 0; i--) {
      if (strikes[i] < K) return strikes[i];
    }
    return null;
  }
}

// --- Background data refresh ---
async function refreshData() {
  const t0 = Date.now();
  console.log(`[${new Date().toISOString()}] Refreshing...`);

  // Load available strikes first
  await loadDeribitStrikes();

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
      const dbPrefix = m.deribit_instrument; // BTC-17MAR26-74000
      const expiry = dbPrefix.split('-')[1]; // 17MAR26

      // Find nearest next strike up (for #1 call spread) and down (for #3 put spread)
      const k2 = findNextStrike(expiry, K, 'up');
      const k1 = findNextStrike(expiry, K, 'down');
      const sw_up = k2 ? k2 - K : null;   // actual spread width for #1
      const sw_down = k1 ? K - k1 : null;  // actual spread width for #3

      const dbK2 = k2 ? dbPrefix.replace(`-${K}`, `-${k2}`) : null;
      const dbK1 = k1 ? dbPrefix.replace(`-${K}`, `-${k1}`) : null;

      const ci = [dbTasks.length]; dbTasks.push(() => getDeribitTicker(`${dbPrefix}-C`));
      ci.push(dbTasks.length); dbTasks.push(k2 ? () => getDeribitTicker(`${dbK2}-C`) : async () => ({bid:null,ask:null,mark:null,underlying:null}));
      ci.push(dbTasks.length); dbTasks.push(() => getDeribitTicker(`${dbPrefix}-P`));
      ci.push(dbTasks.length); dbTasks.push(k1 ? () => getDeribitTicker(`${dbK1}-P`) : async () => ({bid:null,ask:null,mark:null,underlying:null}));

      metas.push({ m, yesIdx, noIdx, type: 'Above', K, k2, k1, sw_up, sw_down, dbPrefix, dbK2, dbK1, ci });
    } else if (m.type === 'Range' && Array.isArray(m.strike)) {
      const K1 = m.strike[0], K2 = m.strike[1];
      // Find the expiry from deribit_instrument: "BTC-17MAR26-60000/62000" → "17MAR26"
      const expiry = (m.deribit_instrument || '').split('-')[1];

      // #9: Sell rangeSpread = Sell K1 Call, Buy next-up Call, Buy K2-prev Call, Sell K2 Call
      const k1up = findNextStrike(expiry, K1, 'up');   // K1+dK
      const k2dn = findNextStrike(expiry, K2, 'down'); // K2-dK
      // #11: Buy rangeSpread with ramps outside = need K1-dK and K2+dK
      const k1dn = findNextStrike(expiry, K1, 'down');
      const k2up = findNextStrike(expiry, K2, 'up');

      const dkUp = k1up ? k1up - K1 : null;
      const dkDn = k2dn ? K2 - k2dn : null;

      const makeInst = (exp, strike) => exp && strike ? `BTC-${exp}-${strike}` : null;

      // Fetch tasks for #9: 4 calls
      const rci = [];
      rci.push(dbTasks.length); dbTasks.push(() => getDeribitTicker(`${makeInst(expiry,K1)}-C`));    // sell K1 call
      rci.push(dbTasks.length); dbTasks.push(k1up ? () => getDeribitTicker(`${makeInst(expiry,k1up)}-C`) : async()=>({bid:null,ask:null})); // buy K1+dK call
      rci.push(dbTasks.length); dbTasks.push(k2dn ? () => getDeribitTicker(`${makeInst(expiry,k2dn)}-C`) : async()=>({bid:null,ask:null})); // buy K2-dK call
      rci.push(dbTasks.length); dbTasks.push(() => getDeribitTicker(`${makeInst(expiry,K2)}-C`));    // sell K2 call
      // For #11: 4 more
      rci.push(dbTasks.length); dbTasks.push(k1dn ? () => getDeribitTicker(`${makeInst(expiry,k1dn)}-C`) : async()=>({bid:null,ask:null})); // buy K1-dK call
      rci.push(dbTasks.length); dbTasks.push(k2up ? () => getDeribitTicker(`${makeInst(expiry,k2up)}-C`) : async()=>({bid:null,ask:null})); // sell K2+dK call... wait

      metas.push({ m, yesIdx, noIdx, type: 'Range', K1, K2, k1up, k2dn, k1dn, k2up, dkUp, dkDn, expiry, rci });
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
  const insert = db.prepare(`INSERT INTO monitor (type,strategy,direction,question,pm_date,strike,pm_ask,deribit_desc,deribit_q,qp,time_diff,pm_link,deribit_link,leg1_name,leg1_action,leg1_price,leg2_name,leg2_action,leg2_price,leg3_name,leg3_action,leg3_price,leg4_name,leg4_action,leg4_price,underlying,spread_width,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);

  db.exec('DELETE FROM monitor');
  for (const meta of metas) {
    const { m } = meta;
    const yesAsk = pmR[meta.yesIdx];
    const noAsk = pmR[meta.noIdx];

    if (meta.type === 'Above') {
      const { K, k2, k1, sw_up, sw_down, dbPrefix, dbK2, dbK1, ci } = meta;
      const callK = dbR[ci[0]], callK2 = dbR[ci[1]], putK = dbR[ci[2]], putK1 = dbR[ci[3]];

      // #1: sell K call (at bid), buy next-strike-up call (at ask)
      let q1 = null;
      if (k2 && sw_up && callK.bid != null && callK2.ask != null) q1 = (callK.bid - callK2.ask) * underlying / sw_up;
      const qp1 = (q1 != null && yesAsk != null) ? +(q1 - yesAsk).toFixed(4) : null;
      insert.run('Above', '#1', 'Buy Yes', m.question, m.pm_date, String(K), yesAsk,
        k2 ? `Sell ${K}C / Buy ${k2}C` : 'No matching strike', q1, qp1, m.time_diff_hours,
        `https://polymarket.com/event/${m.pm_event_slug}`, `https://www.deribit.com/options/BTC/${dbPrefix}-C`,
        `${dbPrefix}-C`, 'Sell', callK.bid,
        k2 ? `${dbK2}-C` : null, 'Buy', k2 ? callK2.ask : null,
        null,null,null, null,null,null,
        underlying, sw_up, now);

      // #3: sell K put (at bid), buy next-strike-down put (at ask)
      let q3 = null;
      if (k1 && sw_down && putK.bid != null && putK1.ask != null) q3 = (putK.bid - putK1.ask) * underlying / sw_down;
      const qp3 = (q3 != null && noAsk != null) ? +(q3 - noAsk).toFixed(4) : null;
      insert.run('Above', '#3', 'Buy No', m.question, m.pm_date, String(K), noAsk,
        k1 ? `Sell ${K}P / Buy ${k1}P` : 'No matching strike', q3, qp3, m.time_diff_hours,
        `https://polymarket.com/event/${m.pm_event_slug}`, `https://www.deribit.com/options/BTC/${dbPrefix}-P`,
        `${dbPrefix}-P`, 'Sell', putK.bid,
        k1 ? `${dbK1}-P` : null, 'Buy', k1 ? putK1.ask : null,
        null,null,null, null,null,null,
        underlying, sw_down, now);
    } else {
      if (meta.rci) {
        // Range with Deribit data
        const { K1, K2, k1up, k2dn, k1dn, k2up, dkUp, dkDn, expiry, rci } = meta;
        const cK1 = dbR[rci[0]], cK1up = dbR[rci[1]], cK2dn = dbR[rci[2]], cK2 = dbR[rci[3]];
        const cK1dn = dbR[rci[4]], cK2up = dbR[rci[5]];

        // #9 Sell rangeSpread: sell K1C(bid) + buy K1upC(ask) + buy K2dnC(ask) + sell K2C(bid)
        let q9 = null;
        if (k1up && k2dn && dkUp && cK1.bid!=null && cK1up.ask!=null && cK2dn.ask!=null && cK2.bid!=null) {
          q9 = (cK1.bid - cK1up.ask - cK2dn.ask + cK2.bid) * underlying / dkUp;
        }
        const qp9 = (q9!=null && yesAsk!=null) ? +(q9 - yesAsk).toFixed(4) : null;
        const desc9 = k1up && k2dn ? `S ${K1}C B ${k1up}C B ${k2dn}C S ${K2}C` : 'No match';
        insert.run('Range', '#9', 'Buy Yes', m.question, m.pm_date, JSON.stringify(m.strike), yesAsk,
          desc9, q9, qp9, m.time_diff_hours,
          `https://polymarket.com/event/${m.pm_event_slug}`, expiry ? `https://www.deribit.com/options/BTC/BTC-${expiry}-${K1}-C` : null,
          `BTC-${expiry}-${K1}-C`, 'Sell', cK1.bid,
          k1up ? `BTC-${expiry}-${k1up}-C` : null, 'Buy', k1up ? cK1up.ask : null,
          k2dn ? `BTC-${expiry}-${k2dn}-C` : null, 'Buy', k2dn ? cK2dn.ask : null,
          `BTC-${expiry}-${K2}-C`, 'Sell', cK2.bid,
          underlying, dkUp, now);

        // #11 Buy rangeSpread(ramps outside): Buy K1dnC(ask) + Sell K1C(bid) + Sell K2C(bid) + Buy K2upC(ask)
        let q11 = null;
        if (k1dn && k2up && cK1dn.ask!=null && cK1.bid!=null && cK2.bid!=null && cK2up.ask!=null) {
          const dkOut = K1 - k1dn;
          q11 = (cK1.bid - cK1dn.ask + cK2up.ask - cK2.bid); // net BTC cost to buy
          // Hmm, for #11 we BUY the spread, so: cost = ask(K1dn) - bid(K1) + bid(K2) - ask(K2up)...
          // Actually: we buy outside-range payoff. This = 1 - rangeSpread(K1,K2)
          // Buy it: pay (1-q_sell_price). But simpler: q11 per ticket = (bid(K1) - ask(K1dn) - ask(K2up) + bid(K2)) * ul / dkOut...
          // This is the reverse of selling. q11_normalized = -sell_cost = receive from selling the reverse
          q11 = (-cK1dn.ask + cK1.bid + cK2.bid - cK2up.ask) * underlying / dkOut;
        }
        const dkOut = k1dn ? K1 - k1dn : null;
        const qp11 = (q11!=null && noAsk!=null) ? +(q11 - noAsk).toFixed(4) : null;
        const desc11 = k1dn && k2up ? `B ${k1dn}C S ${K1}C S ${K2}C B ${k2up}C` : 'No match';
        insert.run('Range', '#11', 'Buy No', m.question, m.pm_date, JSON.stringify(m.strike), noAsk,
          desc11, q11, qp11, m.time_diff_hours,
          `https://polymarket.com/event/${m.pm_event_slug}`, expiry ? `https://www.deribit.com/options/BTC/BTC-${expiry}-${K1}-C` : null,
          k1dn ? `BTC-${expiry}-${k1dn}-C` : null, 'Buy', k1dn ? cK1dn.ask : null,
          `BTC-${expiry}-${K1}-C`, 'Sell', cK1.bid,
          `BTC-${expiry}-${K2}-C`, 'Sell', cK2.bid,
          k2up ? `BTC-${expiry}-${k2up}-C` : null, 'Buy', k2up ? cK2up.ask : null,
          underlying, dkOut, now);
      } else {
        // Fallback: no Deribit data
        insert.run('Range', '#9', 'Buy Yes', m.question, m.pm_date, JSON.stringify(m.strike), yesAsk, 'No match', null, null, m.time_diff_hours, `https://polymarket.com/event/${m.pm_event_slug}`, null, null,null,null, null,null,null, null,null,null, null,null,null, underlying, null, now);
        insert.run('Range', '#11', 'Buy No', m.question, m.pm_date, JSON.stringify(m.strike), noAsk, 'No match', null, null, m.time_diff_hours, `https://polymarket.com/event/${m.pm_event_slug}`, null, null,null,null, null,null,null, null,null,null, null,null,null, underlying, null, now);
      }
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

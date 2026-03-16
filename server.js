const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = 3456;
const BASE = path.dirname(__filename);

// --- Utility: fetch JSON from URL ---
function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'PMDeribitMonitor/1.0' } }, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

// --- Load market metadata from data.json ---
let markets = [];
try {
  const raw = JSON.parse(fs.readFileSync(path.join(BASE, 'data.json'), 'utf8'));
  markets = raw.markets || [];
  console.log(`Loaded ${markets.length} markets from data.json`);
} catch(e) {
  console.error('Failed to load data.json, run fetch_data.py first');
}

// --- Fetch live PM CLOB best ask ---
async function getPMBestAsk(tokenId) {
  try {
    const book = await fetchJSON(`https://clob.polymarket.com/book?token_id=${tokenId}`);
    const asks = book.asks || [];
    if (asks.length === 0) return null;
    // asks are sorted, lowest first
    return parseFloat(asks[asks.length - 1].price); // PM CLOB: last = best (lowest)
  } catch { return null; }
}

// --- Fetch live Deribit ticker ---
async function getDeribitTicker(instrument) {
  try {
    const data = await fetchJSON(`https://www.deribit.com/api/v2/public/ticker?instrument_name=${instrument}`);
    const r = data.result || {};
    return {
      bid: r.best_bid_price,
      ask: r.best_ask_price,
      mark: r.mark_price,
      underlying: r.underlying_price
    };
  } catch { return { bid: null, ask: null, mark: null, underlying: null }; }
}

// --- Build 112 monitoring rows ---
async function buildMonitorData() {
  const rows = [];
  const underlying = (await getDeribitTicker('BTC-17MAR26-74000-C')).underlying || 73500;
  const SPREAD_WIDTH = 1000; // $1000 spread for Above strategies

  for (const m of markets) {
    // Get PM best ask for Yes and No
    const yesAsk = await getPMBestAsk(m.pm_yes_token);
    const noAsk = await getPMBestAsk(m.pm_no_token);

    if (m.type === 'Above') {
      const K = m.strike;
      const day = m.pm_date.replace('Mar ', '');
      const dbPrefix = m.deribit_instrument; // like BTC-17MAR26-74000

      // Strategy #1: Buy Yes + sell Bull Call Spread (sell K call, buy K+1000 call)
      const callK = await getDeribitTicker(`${dbPrefix}-C`);
      // Find K+1000 instrument
      const k2 = K + SPREAD_WIDTH;
      const dbK2 = dbPrefix.replace(`-${K}`, `-${k2}`);
      const callK2 = await getDeribitTicker(`${dbK2}-C`);

      // q for #1 = sell K call (bid) - buy K+1000 call (ask), in BTC, convert to $1 scale
      let q1 = null;
      if (callK.bid != null && callK2.ask != null) {
        const spreadPayoffBTC = callK.bid - callK2.ask; // per 1 BTC contract
        const spreadPayoffUSD = spreadPayoffBTC * underlying;
        const maxPayoff = SPREAD_WIDTH; // max $1000 per 1 BTC
        q1 = spreadPayoffUSD / maxPayoff; // normalized to $1 scale
      }

      rows.push({
        type: 'Above',
        strategy: '#1',
        direction: 'Buy Yes',
        question: m.question,
        pm_date: m.pm_date,
        strike: K,
        pm_ask: yesAsk,
        deribit_desc: `Sell ${K}C / Buy ${k2}C`,
        deribit_q: q1,
        qp: (q1 != null && yesAsk != null) ? +(q1 - yesAsk).toFixed(4) : null,
        time_diff: m.time_diff_hours,
        pm_link: `https://polymarket.com/event/${m.pm_event_slug}`,
        deribit_link: `https://www.deribit.com/options/BTC/${dbPrefix}-C`
      });

      // Strategy #3: Buy No + sell Bear Put Spread (sell K put, buy K-1000 put)
      const putK = await getDeribitTicker(`${dbPrefix}-P`);
      const k1 = K - SPREAD_WIDTH;
      const dbK1 = dbPrefix.replace(`-${K}`, `-${k1}`);
      const putK1 = await getDeribitTicker(`${dbK1}-P`);

      let q3 = null;
      if (putK.bid != null && putK1.ask != null) {
        const spreadPayoffBTC = putK.bid - putK1.ask;
        const spreadPayoffUSD = spreadPayoffBTC * underlying;
        q3 = spreadPayoffUSD / SPREAD_WIDTH;
      }

      rows.push({
        type: 'Above',
        strategy: '#3',
        direction: 'Buy No',
        question: m.question,
        pm_date: m.pm_date,
        strike: K,
        pm_ask: noAsk,
        deribit_desc: `Sell ${K}P / Buy ${k1}P`,
        deribit_q: q3,
        qp: (q3 != null && noAsk != null) ? +(q3 - noAsk).toFixed(4) : null,
        time_diff: m.time_diff_hours,
        pm_link: `https://polymarket.com/event/${m.pm_event_slug}`,
        deribit_link: `https://www.deribit.com/options/BTC/${dbPrefix}-P`
      });

    } else if (m.type === 'Range') {
      // Range: simpler, just show PM ask for now, Deribit combo is complex
      rows.push({
        type: 'Range',
        strategy: '#9',
        direction: 'Buy Yes',
        question: m.question,
        pm_date: m.pm_date,
        strike: m.strike,
        pm_ask: yesAsk,
        deribit_desc: 'Iron Butterfly (complex)',
        deribit_q: null,
        qp: null,
        time_diff: m.time_diff_hours,
        pm_link: `https://polymarket.com/event/${m.pm_event_slug}`,
        deribit_link: null
      });

      rows.push({
        type: 'Range',
        strategy: '#11',
        direction: 'Buy No',
        question: m.question,
        pm_date: m.pm_date,
        strike: m.strike,
        pm_ask: noAsk,
        deribit_desc: 'Reverse Iron Butterfly',
        deribit_q: null,
        qp: null,
        time_diff: m.time_diff_hours,
        pm_link: `https://polymarket.com/event/${m.pm_event_slug}`,
        deribit_link: null
      });
    }
  }

  return { updated_at: new Date().toISOString(), underlying, rows };
}

// --- Serve static files + API ---
const MIME = { '.html':'text/html', '.js':'text/javascript', '.css':'text/css', '.json':'application/json', '.png':'image/png' };

const server = http.createServer(async (req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');

  if (req.url === '/api/monitor') {
    console.log(`[${new Date().toISOString()}] Fetching live data...`);
    try {
      const data = await buildMonitorData();
      console.log(`[${new Date().toISOString()}] Done. ${data.rows.length} rows.`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch(e) {
      console.error(e);
      res.writeHead(500);
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // Static files
  let filePath = path.join(BASE, req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, content) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(content);
  });
});

server.listen(PORT, () => {
  console.log(`\n  PM × Deribit Monitor running at http://localhost:${PORT}`);
  console.log(`  Dashboard: http://localhost:${PORT}/ch4.html`);
  console.log(`  API: http://localhost:${PORT}/api/monitor\n`);
});

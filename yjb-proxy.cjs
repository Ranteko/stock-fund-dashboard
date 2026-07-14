const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT || 18788);
const HOST = '127.0.0.1';
const API_HOST = 'browser-plug-api.yangjibao.com';
const SIGN_SECRET = 'YxmKSrQR4uoJ5lOoWIhcbd7SlUEh9OOc';
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const STATE_FILE = path.join(DATA_DIR, 'desktop-state.json');
const LIVE_FILE = path.join(DATA_DIR, 'desktop-live.json');

function ensureDataDir(){
  if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, {recursive:true});
}
function readJson(file, fallback){
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJson(file, data){
  ensureDataDir();
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function send(res, status, body, type = 'application/json; charset=utf-8'){
  res.writeHead(status, {
    'Content-Type': type,
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sign(pathname, token){
  const ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHash('md5')
    .update(pathname.split('?')[0] + (token || '') + ts + SIGN_SECRET)
    .digest('hex');
  return {ts, sig};
}

function yjbGet(pathname, token = ''){
  return new Promise((resolve, reject) => {
    const {ts, sig} = sign(pathname, token);
    const req = https.request({
      hostname: API_HOST,
      path: pathname,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json;charset=UTF-8',
        'Authorization': token,
        'Request-Time': ts,
        'Request-Sign': sig,
      },
      timeout: 12000,
    }, upstreamRes => {
      let data = '';
      upstreamRes.setEncoding('utf8');
      upstreamRes.on('data', chunk => data += chunk);
      upstreamRes.on('end', () => {
        try{
          const json = JSON.parse(data || '{}');
          if(!upstreamRes.statusCode || upstreamRes.statusCode >= 400 || (json.code != null && json.code !== 200)){
            reject(new Error(json.message || `养基宝请求失败 HTTP ${upstreamRes.statusCode}`));
          } else {
            resolve(json.data);
          }
        }catch(e){ reject(e); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('养基宝接口超时')));
    req.on('error', reject);
    req.end();
  });
}

function proxyYjb(req, res, url){
  let body = '';
  req.on('data', chunk => {
    body += chunk;
    if(body.length > 1024 * 1024) req.destroy();
  });
  req.on('end', () => {
    let payload = {};
    try { payload = body ? JSON.parse(body) : {}; }
    catch { return send(res, 400, JSON.stringify({code:400, message:'请求格式不是 JSON'})); }

    const targetPath = String(payload.path || url.searchParams.get('path') || '');
    const token = String(payload.token || '');
    if(!targetPath.startsWith('/') || targetPath.includes('://')){
      return send(res, 400, JSON.stringify({code:400, message:'非法接口路径'}));
    }

    yjbGet(targetPath, token)
      .then(data => send(res, 200, JSON.stringify({code:200, message:'SUCCESS', data})))
      .catch(err => send(res, 502, JSON.stringify({code:502, message:err.message})));
  });
}

function readBody(req, max = 2 * 1024 * 1024){
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if(body.length > max) reject(new Error('请求体过大'));
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

async function saveDesktopState(req, res){
  try{
    const body = await readBody(req);
    const state = JSON.parse(body || '{}');
    if(!Array.isArray(state.positions)) throw new Error('缺少 positions');
    writeJson(STATE_FILE, {...state, _savedAt: Date.now()});
    collectDesktopPoint(true).catch(()=>{});
    send(res, 200, JSON.stringify({ok:true}));
  }catch(e){
    send(res, 400, JSON.stringify({ok:false, message:e.message}));
  }
}

function serveDesktopLive(res){
  const live = readJson(LIVE_FILE, {tracking:{intraday:{}, eod:[]}, updatedAt:null});
  send(res, 200, JSON.stringify(live));
}

function serveQr(res, url){
  const data = url.searchParams.get('data') || '';
  if(!data) return send(res, 400, 'Missing data', 'text/plain; charset=utf-8');
  QRCode.toString(data, {
    type: 'svg',
    errorCorrectionLevel: 'M',
    margin: 2,
    width: 220,
    color: {dark:'#111111', light:'#ffffff'},
  }, (err, svg) => {
    if(err) return send(res, 500, err.message, 'text/plain; charset=utf-8');
    send(res, 200, svg, 'image/svg+xml; charset=utf-8');
  });
}

function serveStatic(res, pathname){
  const clean = pathname === '/' ? '/index.html' : pathname;
  const file = path.join(ROOT, clean);
  if(!file.startsWith(ROOT) || !fs.existsSync(file) || !fs.statSync(file).isFile()){
    return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
  }
  const ext = path.extname(file).toLowerCase();
  const type = ext === '.html' ? 'text/html; charset=utf-8'
    : ext === '.js' ? 'application/javascript; charset=utf-8'
    : ext === '.css' ? 'text/css; charset=utf-8'
    : 'application/octet-stream';
  send(res, 200, fs.readFileSync(file), type);
}

function dateStr(d = new Date()){
  return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0');
}
function isTradingHours(d = new Date()){
  const dow = d.getDay();
  if(dow === 0 || dow === 6) return false;
  const m = d.getHours() * 60 + d.getMinutes();
  return (m >= 9*60+15 && m <= 11*60+30) || (m >= 13*60 && m <= 15*60+30);
}
function normalizeStockCode(raw){
  const c = String(raw||'').trim().replace(/^(sh|sz)/i,'');
  if(!/^\d{6}$/.test(c)) return null;
  if(/^(60|68|9\d|11|50|51|52|56|58|88)/.test(c)) return 'sh' + c;
  if(/^(00|30|20|39|15|16|18)/.test(c)) return 'sz' + c;
  return 'sh' + c;
}
function isETF(p){
  if(!p || p.type !== 'stock') return false;
  const code = String(p.code || '').replace(/^(sh|sz)/i, '');
  return /^(51|56|58|15|16|18)\d{4}$/.test(code) || /ETF/i.test(p.name || '');
}
async function fetchText(url, opts = {}){
  const res = await fetch(url, {cache:'no-store', ...opts});
  if(!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
async function fetchStockQuotes(codes){
  const normalized = codes.map(normalizeStockCode).filter(Boolean);
  if(!normalized.length) return {};
  const text = await fetchText('https://qt.gtimg.cn/q=' + normalized.join(','));
  const out = {};
  for(const line of text.split('\n')){
    const m = line.match(/v_(sh|sz)(\d{6})="([^"]*)"/);
    if(!m) continue;
    const fields = m[3].split('~');
    out[m[2]] = {
      name: fields[1],
      price: parseFloat(fields[3]),
      prevClose: parseFloat(fields[4]),
      changePct: parseFloat(fields[32]) / 100,
      ts: fields[30],
      type: 'stock',
    };
  }
  return out;
}
async function fetchFundQuote(code){
  const text = await fetchText(`https://fundgz.1234567.com.cn/js/${code}.js?_=${Date.now()}`);
  const m = text.match(/jsonpgz\((.*)\);?/);
  if(!m) return null;
  const data = JSON.parse(m[1]);
  const dwjz = parseFloat(data.dwjz);
  const gsz = parseFloat(data.gsz);
  const today = dateStr();
  const navIsToday = data.jzrq === today;
  let price, prevClose, source;
  if(navIsToday){
    price = dwjz;
    const pct = parseFloat(data.gszzl);
    prevClose = !isNaN(pct) && pct !== 0 ? dwjz / (1 + pct / 100) : dwjz;
    source = 'real';
  } else {
    price = isNaN(gsz) ? dwjz : gsz;
    prevClose = dwjz;
    source = isNaN(gsz) ? 'closed' : 'estimate';
  }
  if(isNaN(price)) return null;
  return {
    name: data.name,
    price,
    prevClose,
    changePct: parseFloat(data.gszzl) / 100,
    ts: data.gztime || data.jzrq,
    source,
    estimated: source === 'estimate',
    type: 'fund',
  };
}
async function fetchTrueLatestNavF10(code){
  const text = await fetchText(`https://fundf10.eastmoney.com/F10DataApi.aspx?type=lsjz&code=${code}&page=1&per=2&_=${Date.now()}`);
  const m = text.match(/content:"([\s\S]*)",records:/);
  if(!m) return null;
  const html = m[1].replace(/\\"/g, '"').replace(/\\\//g, '/');
  const rows = [...html.matchAll(/<td>(\d{4}-\d{2}-\d{2})<\/td><td[^>]*>([\d.]+)<\/td><td[^>]*>([\d.]+)<\/td><td[^>]*>([+-]?[\d.]+)%/g)];
  if(!rows.length) return null;
  const latest = rows[0], prev = rows[1];
  const nav = parseFloat(latest[2]);
  if(isNaN(nav)) return null;
  return {
    date: latest[1],
    nav,
    prevNav: prev ? parseFloat(prev[2]) : nav,
    pct: parseFloat(latest[4]) || 0,
  };
}
async function fetchFundQuotes(codes){
  const out = {};
  for(const code of codes){
    try { out[code] = await fetchFundQuote(code); }
    catch { out[code] = null; }
    if(!out[code]){
      try{
        const enriched = await fetchTrueLatestNavF10(code);
        if(enriched){
          out[code] = {
            name: '',
            price: enriched.nav,
            prevClose: enriched.prevNav,
            changePct: enriched.pct / 100,
            ts: enriched.date,
            source: enriched.date === dateStr() ? 'real' : 'closed',
            estimated: false,
            type: 'fund',
          };
        }
      }catch{}
    }
  }
  return out;
}
function flatten(obj, prefix='', depth=0, out=[]){
  if(obj == null || depth > 5 || typeof obj !== 'object') return out;
  for(const [k,v] of Object.entries(obj)){
    const p = prefix ? prefix + '.' + k : k;
    if(v && typeof v === 'object') flatten(v, p, depth + 1, out);
    else out.push([p, v]);
  }
  return out;
}
function yjbCodeOf(item){
  const rows = flatten(item);
  const preferred = rows.find(([k,v]) => /(^|\.)((fund_?)?code|fc|fcode)$/i.test(k) && /^\d{6}$/.test(String(v)));
  if(preferred) return String(preferred[1]);
  const any = rows.find(([,v]) => /^\d{6}$/.test(String(v)));
  return any ? String(any[1]) : '';
}
function yjbExtractPrice(item){
  const skip = /(amount|money|income|profit|pnl|rate|ratio|percent|pct|share|portion|cost|fee|hold|market|total|sum|asset|date|time|id)$/i;
  const preferred = /(valuation|estimate|estimated|expect|realtime|real_time|gsz|gz|vv|nav|nv|net_?value|unit_?value|dwjz|price|value)$/i;
  const rows = flatten(item);
  const candidates = [];
  for(const [path, val] of rows){
    if(typeof val === 'boolean') continue;
    const num = parseFloat(String(val).replace(/,/g,''));
    if(!(num > 0.01 && num < 100)) continue;
    const key = path.split('.').pop() || path;
    const lower = path.toLowerCase();
    let score = 0;
    if(skip.test(key)) score -= 20;
    if(preferred.test(lower)) score += 10;
    if(/estimate|valuation|expect|gsz|gz|vv/.test(lower)) score += 8;
    if(/nv_info|nav|net|unit|value|nv/.test(lower)) score += 4;
    if(/pct|rate|ratio|percent|income|amount|share|cost|profit|hold/.test(lower)) score -= 20;
    candidates.push({path, price:num, score});
  }
  candidates.sort((a,b) => b.score - a.score);
  return candidates[0] && candidates[0].score > 0 ? candidates[0] : null;
}
function collectAccountIds(data){
  const ids = new Set();
  for(const [pathKey, val] of flatten(data)){
    if(val != null && (/([.]account_?id)$/i.test(pathKey) || /(^|[.])id$/i.test(pathKey)) && /^\d+$/.test(String(val))) ids.add(String(val));
  }
  if(!ids.size && data && data.id != null) ids.add(String(data.id));
  return [...ids];
}
function collectArray(data){
  if(Array.isArray(data)) return data;
  if(!data || typeof data !== 'object') return [];
  for(const key of ['list','data','items','fund_list','fundList','hold_list','holdList']){
    if(Array.isArray(data[key])) return data[key];
  }
  return Object.values(data).find(Array.isArray) || [];
}
async function fetchYjbPrices(state){
  const token = state && state.settings && state.settings.yjb && state.settings.yjb.token;
  if(!token) return new Map();
  const accountData = await yjbGet('/user_account', token);
  const accountIds = collectAccountIds(accountData);
  const prices = new Map();
  for(const accountId of accountIds){
    const hold = await yjbGet('/fund_hold?account_id=' + encodeURIComponent(accountId), token);
    for(const item of collectArray(hold)){
      const code = yjbCodeOf(item);
      const hit = yjbExtractPrice(item);
      if(code && hit) prices.set(code, hit.price);
    }
  }
  return prices;
}
function computePosition(p, q){
  if(!q || isNaN(q.price)) return null;
  const price = q.price;
  const shares = parseFloat(p.shares) || 0;
  const costPrice = parseFloat(p.costPrice) || 0;
  const mv = price * shares;
  const pnl = (price - costPrice) * shares;
  let dayPnl = null, dayPnlPct = null;
  if(q.prevClose && !isNaN(q.prevClose)){
    dayPnl = (price - q.prevClose) * shares;
    dayPnlPct = price / q.prevClose - 1;
  }
  return {...p, q, price, mv, pnl, dayPnl, dayPnlPct, type:p.type};
}
function aggregate(rows){
  let mv = 0, pnl = 0, dayPnl = 0, prevMv = 0;
  for(const r of rows){
    mv += r.mv || 0;
    pnl += r.pnl || 0;
    dayPnl += r.dayPnl || 0;
    if(r.dayPnl != null && r.mv != null) prevMv += r.mv - r.dayPnl;
  }
  return {mv, pnl, dayPnl, dayPnlPct: prevMv > 0 ? dayPnl / prevMv : null};
}
let collecting = false;
let lastCollectAt = 0;
async function collectDesktopPoint(force=false){
  if(collecting) return;
  const state = readJson(STATE_FILE, null);
  if(!state || !Array.isArray(state.positions) || !state.positions.length) return;
  const sec = Number(state.settings && state.settings.autoRefreshSec) || 30;
  if(!force && Date.now() - lastCollectAt < Math.max(15, sec) * 1000) return;
  if(!isTradingHours()) return;
  collecting = true;
  try{
    const live = readJson(LIVE_FILE, {tracking:{intraday:{}, eod:[]}, updatedAt:null});
    live.tracking ||= {intraday:{}, eod:[]};
    live.tracking.intraday ||= {};
    const positions = state.positions.filter(p => (parseFloat(p.shares) || 0) > 0);
    const stockCodes = [...new Set(positions.filter(p => p.type === 'stock').map(p => p.code))];
    const fundCodes = [...new Set(positions.filter(p => p.type === 'fund').map(p => p.code))];
    const [stocks, funds, yjbPrices] = await Promise.all([
      fetchStockQuotes(stockCodes).catch(()=>({})),
      fetchFundQuotes(fundCodes).catch(()=>({})),
      fetchYjbPrices(state).catch(()=>new Map()),
    ]);
    for(const code of fundCodes){
      const price = yjbPrices.get(code);
      if(price && funds[code] && funds[code].source !== 'real'){
        funds[code].price = Math.round(price * 10000) / 10000;
        funds[code].source = 'yangjibao';
      }
    }
    const byPos = {};
    const rows = [];
    for(const p of positions){
      const q = p.type === 'stock' ? stocks[p.code] : funds[p.code];
      const row = computePosition(p, q);
      if(!row) continue;
      rows.push(row);
      byPos[p.id] = {
        mv: row.mv, dayPnl: row.dayPnl, dayPnlPct: row.dayPnlPct, pnl: row.pnl,
        name: row.name, type: row.type, platform: row.platform,
        code: row.code, themes: Array.isArray(row.themes) ? row.themes.slice() : [],
        isETF: isETF(row),
      };
    }
    if(!rows.length) return;
    const totals = aggregate(rows);
    const byPlat = {};
    for(const id in byPos){
      const r = byPos[id];
      const k = r.platform || '未分类';
      byPlat[k] ||= {mv:0, dayPnl:0, pnl:0, count:0};
      byPlat[k].mv += r.mv || 0;
      byPlat[k].dayPnl += r.dayPnl || 0;
      byPlat[k].pnl += r.pnl || 0;
      byPlat[k].count++;
    }
    const today = dateStr();
    live.tracking.intraday[today] ||= {points:[]};
    const point = {ts:Date.now(), mv:totals.mv, dayPnl:totals.dayPnl, dayPnlPct:totals.dayPnlPct, pnl:totals.pnl, byPos, byPlat};
    const points = live.tracking.intraday[today].points;
    if(points.length && point.ts - points[points.length - 1].ts < 5000) points[points.length - 1] = point;
    else points.push(point);
    if(points.length > 1500) live.tracking.intraday[today].points = points.filter((_, i) => i % 2 === 0 || i === points.length - 1);
    live.updatedAt = Date.now();
    live.lastPointAt = point.ts;
    writeJson(LIVE_FILE, live);
    lastCollectAt = Date.now();
  }catch(e){
    const live = readJson(LIVE_FILE, {tracking:{intraday:{}, eod:[]}, updatedAt:null});
    live.lastError = e.message;
    live.lastErrorAt = Date.now();
    writeJson(LIVE_FILE, live);
  }finally{
    collecting = false;
  }
}
setInterval(() => collectDesktopPoint(false), 15 * 1000);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if(req.method === 'OPTIONS') return send(res, 204, '');
  if(url.pathname === '/api/state' && req.method === 'POST') return saveDesktopState(req, res);
  if(url.pathname === '/api/desktop/live') return serveDesktopLive(res);
  if(url.pathname === '/api/yjb') return proxyYjb(req, res, url);
  if(url.pathname === '/api/qr') return serveQr(res, url);
  if(req.method !== 'GET') return send(res, 405, 'Method not allowed', 'text/plain; charset=utf-8');
  serveStatic(res, decodeURIComponent(url.pathname));
});

server.listen(PORT, HOST, () => {
  console.log(`stock-fund-dashboard: http://${HOST}:${PORT}/`);
  console.log('养基宝代理已启动：/api/yjb');
});

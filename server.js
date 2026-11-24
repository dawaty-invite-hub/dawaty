// Zero-dependency server. Storage: one JSON file (data.json). Run: node server.js
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const DATA = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const SALT = process.env.SALT || 'change-me-in-production';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS || 'app.instinct.com').split(',').map(s => s.trim().toLowerCase()).filter(Boolean); // default: only the official Instinct invite host; set ALLOWED_HOSTS env to override
const CAP = 10;            // people one link can serve
const REPORTS_TO_REMOVE = 3; // distinct reporters needed to auto-remove
const MIN_FORM_MS = 2500;  // bots submit faster than this
let db = { links: [], takes: [] };
const DBURL = process.env.DATABASE_URL;
let pool = null;
if (DBURL) { const { Pool } = require('pg'); pool = new Pool({ connectionString: DBURL, ssl: { rejectUnauthorized: false }, max: 3 }); }
async function load() {
  if (pool) {
    await pool.query('CREATE TABLE IF NOT EXISTS kv (k text PRIMARY KEY, v jsonb NOT NULL, updated timestamptz DEFAULT now())');
    const r = await pool.query("SELECT v FROM kv WHERE k='db'");
    if (r.rows[0]) db = r.rows[0].v;
  } else { try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {} }
}
let t, saving = Promise.resolve();
const save = () => { clearTimeout(t); t = setTimeout(() => {
  if (pool) saving = saving.then(() => pool.query("INSERT INTO kv(k,v) VALUES('db',$1) ON CONFLICT (k) DO UPDATE SET v=$1, updated=now()", [JSON.stringify(db)])).catch(e => console.error('save failed', e.message));
  else { fs.writeFileSync(DATA + '.tmp', JSON.stringify(db)); fs.renameSync(DATA + '.tmp', DATA); }
}, 50); };
const h = s => crypto.createHash('sha256').update(SALT + s).digest('hex').slice(0, 24);
const ipOf = r => h((process.env.TRUST_PROXY ? (r.headers['x-forwarded-for'] || '').split(',')[0].trim() : '') || r.socket.remoteAddress || '');
const now = () => Date.now();

// rate limiting: sliding window per ip+action
const hits = new Map();
function limited(ip, act, max, winMs) {
  const k = ip + act, n = now(), a = (hits.get(k) || []).filter(x => n - x < winMs);
  if (a.length >= max) { hits.set(k, a); return true; }
  a.push(n); hits.set(k, a); return false;
}
setInterval(() => { const n = now(); for (const [k, a] of hits) if (!a.some(x => n - x < 86400000)) hits.delete(k); }, 600000).unref();

const live = () => db.links.filter(l => !l.removed);
const open = () => live().filter(l => l.uses < CAP);
function stats() {
  const L = live();
  return { liveLinks: L.length, seatsLeft: L.reduce((s, l) => s + Math.max(0, CAP - l.uses), 0),
    totalTaken: db.takes.length, contributors: new Set(L.map(l => l.ipHash)).size,
    removed: db.links.filter(l => l.removed).length };
}
function board() {
  const m = {};
  for (const l of db.links) if (l.name) { m[l.name] = (m[l.name] || 0) + l.uses; }
  return Object.entries(m).map(([name, served]) => ({ name, served })).filter(x => x.served > 0)
    .sort((a, b) => b.served - a.served).slice(0, 10);
}
function validUrl(s) {
  if (typeof s !== 'string' || s.length > 300) return null;
  let u; try { u = new URL(s.trim()); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password) return null;
  if (ALLOWED_HOSTS.length && !ALLOWED_HOSTS.includes(u.hostname.toLowerCase())) return null;
  if (ALLOWED_HOSTS.length) { // official shape: https://<host>/invite?t=<26 chars a-z0-9>
    const tk = u.searchParams.get('t');
    if (u.pathname !== '/invite' || !tk || !/^[a-z0-9]{26}$/.test(tk)) return null;
    return 'https://' + u.hostname.toLowerCase() + '/invite?t=' + tk; // drops other params like preview
  }
  u.hash = ''; return u.toString();
}
const cleanName = s => typeof s === 'string' ? s.replace(/[<>&"'`\u0000-\u001f]/g, '').trim().slice(0, 24) : '';

function body(r) { return new Promise((ok, no) => { let b = ''; r.on('data', c => { b += c; if (b.length > 5000) { r.destroy(); no(); } }); r.on('end', () => { try { ok(JSON.parse(b || '{}')); } catch { no(); } }); }); }
const send = (res, code, o) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(o)); };

const api = {
  async stats() { return [200, { ...stats(), cap: CAP, board: board() }]; },
  async take(r, ip, b) {
    if (limited(ip, 'take', 3, 3600000)) return [429, { error: 'استنى شوية وجرب تاني (حد أقصى 3 لينكات في الساعة).' }];
    const mine = (b.own || '').toString();
    const pool = open().filter(l => l.id !== mine && l.ipHash !== ip).sort((a, c) => a.uses - c.uses || a.created - c.created);
    // rotate: fill the oldest-served link first so each one reaches its 10 quickly, then move on
    const l = pool.sort((a, c) => c.uses - a.uses || a.created - c.created)[0];
    if (!l) return [404, { error: 'مفيش لينكات متاحة دلوقتي. جرب بعد شوية أو ضيف لينكك.' }];
    l.uses++; db.takes.push({ link: l.id, ip, at: now() }); save();
    return [200, { url: l.url, id: l.id, left: CAP - l.uses }];
  },
  async add(r, ip, b) {
    if (b.website) return [200, { ok: true }]; // honeypot: pretend success
    if (now() - (+b.t || 0) < MIN_FORM_MS) return [400, { error: 'بسرعة كده؟ جرب تاني.' }];
    if (limited(ip, 'add', 3, 86400000)) return [429, { error: 'وصلت للحد اليومي للإضافة.' }];
    const url = validUrl(b.url);
    if (!url) return [400, { error: 'اللينك مش صالح. لازم يبدأ بـ https://' + (ALLOWED_HOSTS.length ? ' ومن موقع مسموح.' : '') }];
    if (db.links.some(l => l.url === url && !l.removed)) return [409, { error: 'اللينك ده متضاف قبل كده.' }];
    if (db.links.filter(l => l.ipHash === ip && !l.removed).length >= 2) return [429, { error: 'عندك لينكين شغالين بالفعل.' }];
    const l = { id: crypto.randomBytes(5).toString('hex'), url, name: cleanName(b.name), ipHash: ip, uses: 0, created: now(), reports: [], removed: false, secret: crypto.randomBytes(12).toString('hex') };
    db.links.push(l); save();
    return [200, { ok: true, id: l.id, secret: l.secret }];
  },
  async report(r, ip, b) {
    if (limited(ip, 'report', 10, 3600000)) return [429, { error: 'كتير أوي.' }];
    const l = live().find(x => x.id === b.id); if (!l) return [404, { error: 'اللينك مش موجود.' }];
    if (!db.takes.some(x => x.link === l.id && x.ip === ip)) return [403, { error: 'تقدر تبلّغ بس عن لينك أخدته انت.' }];
    if (!l.reports.includes(ip)) l.reports.push(ip);
    if (l.reports.length >= REPORTS_TO_REMOVE) l.removed = true;
    save(); return [200, { ok: true, removed: l.removed }];
  },
  async remove(r, ip, b) { // owner removes own link with the secret saved in their browser
    if (limited(ip, 'remove', 10, 3600000)) return [429, { error: 'كتير أوي.' }];
    const l = live().find(x => x.id === b.id && x.secret === b.secret); if (!l) return [404, { error: 'مش لاقي لينك بالبيانات دي.' }];
    l.removed = true; save(); return [200, { ok: true }];
  },
};

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const hdr = { 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'x-frame-options': 'DENY',
    'content-security-policy': "default-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'" };
  for (const k in hdr) res.setHeader(k, hdr[k]);
  if (p.startsWith('/api/')) {
    const f = api[p.slice(5)]; if (!f) return send(res, 404, { error: 'not found' });
    if (p !== '/api/stats' && req.method !== 'POST') return send(res, 405, { error: 'method' });
    const ip = ipOf(req);
    if (limited(ip, 'any', 120, 60000)) return send(res, 429, { error: 'بطّئ شوية.' });
    try { const [c, o] = await f(req, ip, req.method === 'POST' ? await body(req) : {}); return send(res, c, o); }
    catch { return send(res, 400, { error: 'طلب غلط.' }); }
  }
  const STATIC = { '/': 'index.html', '/index.html': 'index.html', '/style.css': 'style.css', '/app.js': 'app.js' };
  if (!STATIC[p]) { res.writeHead(404); return res.end('404'); }
  const file = path.join(__dirname, STATIC[p]);
  fs.readFile(file, (e, d) => { if (e) { res.writeHead(404); return res.end('404'); } res.writeHead(200, { 'content-type': types[path.extname(file)] || 'application/octet-stream' }); res.end(d); });
});
load().then(() => server.listen(PORT, () => console.log('http://localhost:' + PORT))).catch(e => { console.error('startup failed', e); process.exit(1); });

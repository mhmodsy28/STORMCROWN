const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
process.on('uncaughtException', e => console.error('💥', e && e.stack ? e.stack : e));
process.on('unhandledRejection', e => console.error('💥', e && e.stack ? e.stack : e));

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;
const DATABASE_URL = process.env.DATABASE_URL;
if (!JWT_SECRET) { console.error('❌ JWT_SECRET'); process.exit(1); }
if (!DATABASE_URL) { console.error('❌ DATABASE_URL'); process.exit(1); }

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const USDT_TO_SYP = 15000, USD_TO_SYP = 15000;
const RTP = Math.min(0.97, Math.max(0.85, parseFloat(process.env.RTP || '0.94')));

// ============ SLOT ============
const MAX_WIN_MULT = 5000;
const FREE_SPINS_COUNT = 15;
const activeBonuses = new Map();

// ============ AVIATOR ============
const AVIATOR_RTP = 0.95;
const AVIATOR_WAITING_MS = 7000;
const AVIATOR_CRASH_DISPLAY_MS = 3500;
const AVIATOR_MAX_MULT = 200;
const AVIATOR_GROWTH_RATE = 0.08;
const aviatorState = {
  roundId: 0,
  crashPoint: 1.00,
  startTime: 0,
  state: 'waiting',
  players: new Map(),
  history: []
};

// ============ MINES ============
const MINES_RTP = 0.97;
const minesGames = new Map();

// ============ WHEEL ============
const WHEEL_VALUES = [0, 100, 500, 1000, 2000, 5000, 10000, 25000];
const WHEEL_WEIGHTS = [40, 25, 15, 10, 5, 3, 1.5, 0.5];

// ============ DAILY ============
const DAILY_REWARDS = [20, 40, 80, 160, 320, 640, 1280];

// ============ JACKPOT ============
const JP_TIERS = [16000, 60000, 300000, 700000];
const JP_CONTRIB = [0.001, 0.0005, 0.0002, 0.0001];
const JP_WHEEL_WEIGHTS = [60, 25, 11, 4];

// ============ CHICKEN ROAD ============
const CHICKEN_RTP = 0.96;
const CHICKEN_ROADS = new Map();

// ============ PLINKO ============
const PLINKO_RTP = 0.97;

// ============ LIMBO ============
const LIMBO_HOUSE_EDGE = 0.03;

// ============ COINFLIP ============
const COINFLIP_RTP = 0.96;

// ============ TOWER ============
const TOWER_RTP = 0.96;
const TOWER_GAMES = new Map();

// ============ DICE ============
const DICE_RTP = 0.99;

const COMPANY_WALLETS = {
  sham_syp: process.env.SHAM_SYP || '066f10afcd1b2d1a8f66dbe1a1eb3f17',
  sham_usd: process.env.SHAM_USD || '066f10afcd1b2d1a8f66dbe1a1eb3f17',
  usdt_bep20: '0x3932890a5d1acb3ab036bd39ade26c47929b37e5',
  usdt_trc20: 'TXYZ1234567890abcdef1234567890abcdef'
};

const PAYMENT_METHODS = [
  { code: 'sham_syp', name: 'شام كاش - ليرة سورية', currency: 'SYP', min: 200, max: 5000000, rate: 1 },
  { code: 'sham_usd', name: 'شام كاش - دولار', currency: 'USD', min: 5, max: 5000, rate: USD_TO_SYP },
  { code: 'usdt_bep20', name: 'USDT (BEP20)', currency: 'USDT', min: 5, max: 5000, rate: USDT_TO_SYP },
  { code: 'usdt_trc20', name: 'USDT (TRC20)', currency: 'USDT', min: 5, max: 5000, rate: USDT_TO_SYP }
];

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 10000
});
pool.on('error', e => console.error('💥 pool:', e));

// ============ DATABASE ============
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY,uid VARCHAR(20) UNIQUE NOT NULL,first_name VARCHAR(100),last_name VARCHAR(100),phone VARCHAR(50) UNIQUE,email VARCHAR(200) UNIQUE,password_hash VARCHAR(200),balance BIGINT DEFAULT 0,laps INT DEFAULT 0,best_win BIGINT DEFAULT 0,wagered BIGINT DEFAULT 0,won BIGINT DEFAULT 0,banned INT DEFAULT 0,referred_by VARCHAR(20),agent_level INT DEFAULT 0,invite_code VARCHAR(20) UNIQUE,total_commission BIGINT DEFAULT 0,notes TEXT DEFAULT '',created_at BIGINT,last_login BIGINT,last_ip VARCHAR(50),last_wheel BIGINT DEFAULT 0,last_daily BIGINT DEFAULT 0,daily_streak INT DEFAULT 0);
    CREATE TABLE IF NOT EXISTS spins (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,won BIGINT,net BIGINT,created_at BIGINT,ip VARCHAR(50));
    CREATE TABLE IF NOT EXISTS login_log (id SERIAL PRIMARY KEY,uid VARCHAR(20),phone VARCHAR(100),success INT,ip VARCHAR(50),user_agent TEXT,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS transactions (id SERIAL PRIMARY KEY,uid VARCHAR(20),type VARCHAR(50),amount BIGINT,balance_after BIGINT,note TEXT,admin VARCHAR(50),created_at BIGINT);
    CREATE TABLE IF NOT EXISTS user_wallets (uid VARCHAR(20) PRIMARY KEY,sham_syp VARCHAR(200) DEFAULT '',sham_usd VARCHAR(200) DEFAULT '',usdt_bep20 VARCHAR(200) DEFAULT '',usdt_trc20 VARCHAR(200) DEFAULT '',updated_at BIGINT);
    CREATE TABLE IF NOT EXISTS deposit_requests (id SERIAL PRIMARY KEY,uid VARCHAR(20),method_code VARCHAR(50),amount NUMERIC,amount_syp BIGINT,tx_hash VARCHAR(200),status VARCHAR(20) DEFAULT 'pending',admin_note TEXT DEFAULT '',created_at BIGINT,processed_at BIGINT,processed_by VARCHAR(50));
    CREATE TABLE IF NOT EXISTS withdraw_requests (id SERIAL PRIMARY KEY,uid VARCHAR(20),method_code VARCHAR(50),amount NUMERIC,amount_syp BIGINT,wallet_to VARCHAR(300),status VARCHAR(20) DEFAULT 'pending',admin_note TEXT DEFAULT '',created_at BIGINT,processed_at BIGINT,processed_by VARCHAR(50));
    CREATE TABLE IF NOT EXISTS commissions (id SERIAL PRIMARY KEY,agent_uid VARCHAR(20),source_uid VARCHAR(20),amount BIGINT,type VARCHAR(50),note TEXT,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS wheel_spins (id SERIAL PRIMARY KEY,uid VARCHAR(20),amount BIGINT,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS jackpot (id INT PRIMARY KEY DEFAULT 1,tier1 BIGINT DEFAULT 16000,tier2 BIGINT DEFAULT 60000,tier3 BIGINT DEFAULT 300000,tier4 BIGINT DEFAULT 700000,last_winner VARCHAR(20),last_win_amount BIGINT,last_win_at BIGINT,last_win_tier INT);
    CREATE TABLE IF NOT EXISTS daily_claims (id SERIAL PRIMARY KEY,uid VARCHAR(20),amount BIGINT,streak INT,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS aviator_bets (id SERIAL PRIMARY KEY,round_id INT,uid VARCHAR(20),bet BIGINT,multiplier NUMERIC,cashout BIGINT,won BOOLEAN,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS mines_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,mines INT,revealed INT,cashout BIGINT,won BOOLEAN,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS chicken_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,difficulty INT,steps INT,multiplier NUMERIC,cashout BIGINT,won BOOLEAN,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS plinko_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,risk VARCHAR(20),rows_count INT,slot INT,multiplier NUMERIC,win BIGINT,path TEXT,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS dice_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,target NUMERIC,direction VARCHAR(10),roll NUMERIC,won BOOLEAN,payout NUMERIC,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS limbo_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,target NUMERIC,result NUMERIC,won BOOLEAN,payout NUMERIC,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS coinflip_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,pick VARCHAR(10),result VARCHAR(10),won BOOLEAN,payout NUMERIC,created_at BIGINT);
    CREATE TABLE IF NOT EXISTS tower_games (id SERIAL PRIMARY KEY,uid VARCHAR(20),bet BIGINT,difficulty INT,level INT,multiplier NUMERIC,cashout BIGINT,won BOOLEAN,created_at BIGINT);
    INSERT INTO jackpot (id,tier1,tier2,tier3,tier4) VALUES (1,16000,60000,300000,700000) ON CONFLICT (id) DO NOTHING;
    CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);
    CREATE INDEX IF NOT EXISTS idx_spins_uid ON spins(uid);
    CREATE INDEX IF NOT EXISTS idx_daily_uid ON daily_claims(uid);
    CREATE INDEX IF NOT EXISTS idx_aviator_uid ON aviator_bets(uid);
    CREATE INDEX IF NOT EXISTS idx_mines_uid ON mines_games(uid);
    CREATE INDEX IF NOT EXISTS idx_chicken_uid ON chicken_games(uid);
    CREATE INDEX IF NOT EXISTS idx_plinko_uid ON plinko_games(uid);
  `);
  console.log('✅ DB ready');
}

// ============ HELPERS ============
function rint(max) { return crypto.randomInt(0, max); }
function genUID() { let u = ''; for (let i = 0; i < 15; i++) u += rint(10); while (u[0] === '0') u = u.slice(1) + rint(10); return u; }
function genInviteCode() { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; let s = 'SC'; for (let i = 0; i < 8; i++) s += c[rint(c.length)]; return s; }
function getClientIP(req) { return (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').replace('::ffff:', ''); }

async function addJackpotContribution(bet) {
  for (let i = 0; i < 4; i++) {
    const inc = Math.floor(bet * JP_CONTRIB[i]);
    if (inc > 0) {
      const col = 'tier' + (i + 1);
      await pool.query(`UPDATE jackpot SET ${col}=${col}+$1 WHERE id=1`, [inc]);
    }
  }
}

// ============ MIDDLEWARE ============
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimits = new Map();
function rateLimit(maxReq, windowMs) {
  return (req, res, next) => {
    const key = getClientIP(req) + ':' + req.path;
    const now = Date.now();
    const d = rateLimits.get(key) || { count: 0, reset: now + windowMs };
    if (now > d.reset) { d.count = 0; d.reset = now + windowMs; }
    d.count++;
    rateLimits.set(key, d);
    if (d.count > maxReq) return res.status(429).json({ error: 'كثير من الطلبات' });
    next();
  };
}

async function authUser(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const r = await pool.query('SELECT * FROM users WHERE uid = $1', [payload.uid]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'المستخدم غير موجود' });
    if (user.banned) return res.status(403).json({ error: 'الحساب محظور' });
    req.user = user;
    next();
  } catch (e) { return res.status(401).json({ error: 'جلسة منتهية' }); }
}

function authAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if (token !== ADMIN_TOKEN) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

// ============ AUTH ============
app.post('/api/register', rateLimit(10, 60000), async (req, res) => {
  try {
    const { first, last, phone, email, password, inviteCode } = req.body;
    const ip = getClientIP(req);
    if (!first || first.length < 2) return res.status(400).json({ error: 'الاسم مطلوب' });
    if (!last || last.length < 2) return res.status(400).json({ error: 'الكنية مطلوبة' });
    if (!phone || phone.length < 8) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'البريد غير صحيح' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });

    const exists = await pool.query('SELECT uid FROM users WHERE phone = $1 OR email = $2 LIMIT 1', [phone, email]);
    if (exists.rows.length) return res.status(409).json({ error: 'الرقم أو البريد مسجل مسبقاً' });

    let referrerUid = null;
    if (inviteCode) {
      const r = await pool.query('SELECT uid FROM users WHERE invite_code = $1', [inviteCode.toUpperCase()]);
      if (r.rows.length) referrerUid = r.rows[0].uid;
    }

    let uid;
    for (let i = 0; i < 20; i++) { uid = genUID(); const c = await pool.query('SELECT 1 FROM users WHERE uid = $1', [uid]); if (!c.rows.length) break; }
    let code;
    for (let i = 0; i < 20; i++) { code = genInviteCode(); const c = await pool.query('SELECT 1 FROM users WHERE invite_code = $1', [code]); if (!c.rows.length) break; }

    const hash = bcrypt.hashSync(password, 10);
    const now = Date.now();
    await pool.query(`INSERT INTO users (uid,first_name,last_name,phone,email,password_hash,balance,laps,best_win,wagered,won,banned,referred_by,agent_level,invite_code,total_commission,created_at,last_login,last_ip,last_wheel,last_daily,daily_streak) VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,0,0,$7,0,$8,0,$9,$9,$10,0,0,0)`, [uid, first, last, phone, email, hash, referrerUid, code, now, ip]);
    await pool.query(`INSERT INTO login_log (uid,phone,success,ip,user_agent,created_at) VALUES ($1,$2,1,$3,$4,$5)`, [uid, phone, ip, req.headers['user-agent'] || '', now]);

    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { uid, first, last, phone, email, balance: 0, laps: 0, best: 0, wagered: 0, won: 0, invite_code: code, agent_level: 0, total_commission: 0 } });
  } catch (e) { console.error('register:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/login', rateLimit(10, 60000), async (req, res) => {
  try {
    const { id, password } = req.body;
    const ip = getClientIP(req);
    if (!id || !password) return res.status(400).json({ error: 'أدخل البيانات' });
    const r = await pool.query('SELECT * FROM users WHERE phone = $1 OR email = $1 OR uid = $1 LIMIT 1', [id]);
    const user = r.rows[0];
    if (!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if (!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'كلمة المرور خاطئة' });
    if (user.banned) return res.status(403).json({ error: 'الحساب محظور' });
    await pool.query('UPDATE users SET last_login = $1, last_ip = $2 WHERE uid = $3', [Date.now(), ip, user.uid]);
    await pool.query(`INSERT INTO login_log (uid,phone,success,ip,user_agent,created_at) VALUES ($1,$2,1,$3,$4,$5)`, [user.uid, id, ip, req.headers['user-agent'] || '', Date.now()]);
    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({ success: true, token, user: { uid: user.uid, first: user.first_name, last: user.last_name, phone: user.phone, email: user.email, balance: Number(user.balance), laps: user.laps, best: Number(user.best_win), wagered: Number(user.wagered), won: Number(user.won), invite_code: user.invite_code, agent_level: user.agent_level, total_commission: Number(user.total_commission) } });
  } catch (e) { console.error('login:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/me', authUser, async (req, res) => {
  try {
    const u = req.user;
    const w = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [u.uid]);
    const wallet = w.rows[0] || {};
    const jp = await pool.query('SELECT * FROM jackpot WHERE id = 1');
    const bonus = activeBonuses.get(u.uid);
    const j = jp.rows[0] || {};
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    const canDaily = (now - Number(u.last_daily || 0)) >= ONE_DAY;
    const nextDaily = canDaily ? now : Number(u.last_daily || 0) + ONE_DAY;

    res.json({
      uid: u.uid, first: u.first_name, last: u.last_name, phone: u.phone, email: u.email,
      balance: Number(u.balance), laps: u.laps, best: Number(u.best_win),
      wagered: Number(u.wagered), won: Number(u.won), invite_code: u.invite_code,
      agent_level: u.agent_level, total_commission: Number(u.total_commission),
      created: Number(u.created_at), lastLogin: Number(u.last_login),
      lastWheel: Number(u.last_wheel || 0),
      jackpot: { tier1: Number(j.tier1 || 16000), tier2: Number(j.tier2 || 60000), tier3: Number(j.tier3 || 300000), tier4: Number(j.tier4 || 700000), lastWinner: j.last_winner, lastWinAmount: Number(j.last_win_amount || 0), lastWinAt: Number(j.last_win_at || 0), lastWinTier: j.last_win_tier },
      daily: { canClaim: canDaily, nextAvailable: nextDaily, streak: Number(u.daily_streak || 0) },
      activeBonus: bonus ? { spinsLeft: bonus.spinsLeft, cumulativeMult: bonus.cumulativeMult, totalWonInBonus: bonus.totalWonInBonus } : null,
      wallets: { sham_syp: wallet.sham_syp || '', sham_usd: wallet.sham_usd || '', usdt_bep20: wallet.usdt_bep20 || '', usdt_trc20: wallet.usdt_trc20 || '' }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

// ============ SLOT GAME LOGIC ============
const COLS = 6, ROWS = 5;
const SYM = { zeusFist: { pay: 2.0 }, crown: { pay: 1.0 }, chalice: { pay: 0.7 }, hourglass: { pay: 0.5 }, ring: { pay: 0.35 }, flaming: { pay: 0.24 }, gem_red: { pay: 0.19 }, gem_blue: { pay: 0.15 }, gem_green: { pay: 0.11 }, gem_purple: { pay: 0.07 } };
const ZEUS_MAIN = [2, 3, 5, 10, 15, 25];
const ZEUS_PREMIUM = [2, 3, 5, 10, 15, 25, 50, 100];

function pickZeusValue(pool) {
  const r = rint(1000);
  const isPremium = Array.isArray(pool) && pool.length > 6;
  if (isPremium) {
    if (r < 350) return 2; if (r < 550) return 3; if (r < 700) return 5;
    if (r < 820) return 10; if (r < 900) return 15; if (r < 950) return 25;
    if (r < 985) return 50; return 100;
  } else {
    if (r < 500) return 2; if (r < 780) return 3; if (r < 920) return 5;
    if (r < 970) return 10; if (r < 992) return 15; return 25;
  }
}

function rSym(zeusPool) {
  const r = rint(10000);
  if (r < 50) return { type: 'jackpot' };
  if (r < 90) return { type: 'zeus', v: pickZeusValue(zeusPool) };
  if (r < 110) return { type: 'scatter' };
  if (r < 1100) return { type: 'gem_purple' };
  if (r < 2300) return { type: 'gem_green' };
  if (r < 3500) return { type: 'gem_blue' };
  if (r < 4600) return { type: 'gem_red' };
  if (r < 5600) return { type: 'flaming' };
  if (r < 6600) return { type: 'ring' };
  if (r < 7500) return { type: 'hourglass' };
  if (r < 8300) return { type: 'chalice' };
  if (r < 9000) return { type: 'crown' };
  return { type: 'zeusFist' };
}

function genGrid(zeusPool) {
  const g = [];
  for (let x = 0; x < COLS; x++) { g[x] = []; for (let y = 0; y < ROWS; y++) g[x][y] = rSym(zeusPool); }
  return g;
}

function chkWins(g, bet) {
  const c = {};
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
    const s = g[x][y];
    if (!s || s.type === 'zeus' || s.type === 'scatter' || s.type === 'jackpot') continue;
    c[s.type] = (c[s.type] || 0) + 1;
  }
  const wins = [];
  for (const [sym, n] of Object.entries(c)) {
    if (n < 7) continue;
    const base = SYM[sym].pay * bet;
    let posMult = 1;
    if (n === 8) posMult = 1.5; else if (n === 9) posMult = 2.5; else if (n === 10) posMult = 4;
    else if (n === 11) posMult = 6; else if (n === 12) posMult = 9; else if (n >= 13) posMult = 12;
    wins.push({ symbol: sym, count: n, amount: Math.floor(base * posMult) });
  }
  return wins;
}

function zeusSum(g) { let s = 0; for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (g[x][y] && g[x][y].type === 'zeus') s += g[x][y].v; return s; }
function cntSc(g) { let n = 0; for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (g[x][y] && g[x][y].type === 'scatter') n++; return n; }
function cntJp(g) { let n = 0; for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (g[x][y] && g[x][y].type === 'jackpot') n++; return n; }

function runSpin(bet, zeusPool, freeSpinsActive, cumulativeMult) {
  const MAX_CHAINS = 6;
  const chains = [];
  let grid = genGrid(zeusPool);
  let totalWin = 0;
  let cumMult = cumulativeMult || 0;
  let jpTriggered = false;
  let finalGridForJp = null;

  for (let chain = 0; chain < MAX_CHAINS; chain++) {
    if (cntJp(grid) >= 3) { jpTriggered = true; finalGridForJp = JSON.parse(JSON.stringify(grid)); }
    const wins = chkWins(grid, bet);
    const zs = zeusSum(grid);
    if (wins.length === 0) break;
    let chainWin = wins.reduce((a, w) => a + w.amount, 0);
    let appliedMult;
    if (freeSpinsActive) { cumMult += zs; appliedMult = cumMult; } else { appliedMult = zs; }
    if (appliedMult > 0) chainWin *= appliedMult;
    chains.push({ grid: JSON.parse(JSON.stringify(grid)), wins, zeusSum: zs, multiplier: appliedMult, cumulativeMult: cumMult, winAmount: chainWin });
    totalWin += chainWin;
    const winningSymbols = [...new Set(wins.map(w => w.symbol))];
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (grid[x][y] && winningSymbols.includes(grid[x][y].type)) grid[x][y] = null;
    for (let x = 0; x < COLS; x++) {
      const kept = [];
      for (let y = ROWS - 1; y >= 0; y--) if (grid[x][y]) kept.push(grid[x][y]);
      while (kept.length < ROWS) kept.push(rSym(zeusPool));
      grid[x] = kept.reverse();
    }
  }
  if (cntJp(grid) >= 3) { jpTriggered = true; finalGridForJp = JSON.parse(JSON.stringify(grid)); }
  return { chains, totalWin, finalGrid: grid, cumulativeMult: cumMult, jpTriggered, jpGrid: finalGridForJp, jpCount: jpTriggered ? cntJp(finalGridForJp || grid) : 0 };
}

function pickJackpotTier() {
  const total = JP_WHEEL_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = Math.random() * total;
  for (let i = 0; i < JP_WHEEL_WEIGHTS.length; i++) { r -= JP_WHEEL_WEIGHTS[i]; if (r <= 0) return i; }
  return 0;
}

// ============ SLOT SPIN ============
app.post('/api/spin', authUser, rateLimit(180, 60000), async (req, res) => {
  const u = req.user;
  const ip = getClientIP(req);
  try {
    const { bet } = req.body;
    if (typeof bet !== 'number' || bet <= 0 || bet > 1000000) return res.status(400).json({ error: 'رهان غير صحيح' });
    const activeBonus = activeBonuses.get(u.uid);
    const isFree = !!activeBonus;
    if (!isFree && u.balance < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    const betUsed = isFree ? activeBonus.initialBet : bet;
    const startCumMult = isFree ? activeBonus.cumulativeMult : 0;
    const zeusPool = isFree ? ZEUS_PREMIUM : ZEUS_MAIN;
    const result = runSpin(betUsed, zeusPool, isFree, startCumMult);
    let totalWin = result.totalWin;
    const maxWin = betUsed * MAX_WIN_MULT;
    if (totalWin > maxWin) totalWin = maxWin;
    let net;
    let newBalance = Number(u.balance);
    let bonusEnded = false;
    let bonusSummary = null;

    if (isFree) {
      net = totalWin;
      newBalance = Number(u.balance) + totalWin;
      activeBonus.spinsLeft -= 1;
      activeBonus.cumulativeMult = result.cumulativeMult;
      activeBonus.totalWonInBonus += totalWin;
      if (totalWin > activeBonus.bestWin) activeBonus.bestWin = totalWin;
      if (activeBonus.spinsLeft <= 0) {
        bonusEnded = true;
        bonusSummary = { spins: FREE_SPINS_COUNT, initialBet: activeBonus.initialBet, bonusPrice: activeBonus.bonusPrice || 0, totalWon: activeBonus.totalWonInBonus, bestWin: activeBonus.bestWin, finalMultiplier: result.cumulativeMult };
        activeBonuses.delete(u.uid);
      }
      await pool.query(`UPDATE users SET balance=$1, laps=laps+1, won=won+$2, best_win=GREATEST(best_win,$3) WHERE uid=$4`, [newBalance, totalWin, totalWin, u.uid]);
      await pool.query(`INSERT INTO spins (uid,bet,won,net,created_at,ip) VALUES ($1,$2,$3,$4,$5,$6)`, [u.uid, 0, totalWin, totalWin, Date.now(), ip]);
    } else {
      net = totalWin - bet;
      newBalance = Number(u.balance) + net;
      if (newBalance < 0) return res.status(400).json({ error: 'رصيد غير كافٍ' });
      await pool.query(`UPDATE users SET balance=$1, laps=laps+1, wagered=wagered+$2, won=won+$3, best_win=GREATEST(best_win,$4) WHERE uid=$5`, [newBalance, bet, totalWin, totalWin, u.uid]);
      await pool.query(`INSERT INTO spins (uid,bet,won,net,created_at,ip) VALUES ($1,$2,$3,$4,$5,$6)`, [u.uid, bet, totalWin, net, Date.now(), ip]);
      await addJackpotContribution(bet);
      if (net < 0 && u.referred_by) {
        const refR = await pool.query('SELECT * FROM users WHERE uid = $1', [u.referred_by]);
        const ref = refR.rows[0];
        if (ref && ref.agent_level > 0) {
          const rate = ref.agent_level === 1 ? 0.03 : ref.agent_level === 2 ? 0.05 : 0.08;
          const commission = Math.floor(Math.abs(net) * rate);
          if (commission > 0) {
            await pool.query('UPDATE users SET balance=balance+$1, total_commission=total_commission+$1 WHERE uid=$2', [commission, ref.uid]);
            await pool.query(`INSERT INTO commissions (agent_uid,source_uid,amount,type,note,created_at) VALUES ($1,$2,$3,'loss_commission',$4,$5)`, [ref.uid, u.uid, commission, 'عمولة ' + Math.abs(net), Date.now()]);
          }
        }
      }
    }

    let jackpotWon = 0, jackpotWonTier = 0, jackpotWonAmount = 0;
    if (result.jpTriggered && !isFree) {
      const tierIdx = pickJackpotTier();
      const jr = await pool.query('SELECT * FROM jackpot WHERE id = 1');
      const j = jr.rows[0];
      const col = 'tier' + (tierIdx + 1);
      const tierAmount = Number(j[col] || JP_TIERS[tierIdx]);
      jackpotWon = tierAmount;
      jackpotWonTier = tierIdx;
      jackpotWonAmount = tierAmount;
      newBalance += tierAmount;
      await pool.query('UPDATE users SET balance=$1, won=won+$2 WHERE uid=$3', [newBalance, tierAmount, u.uid]);
      await pool.query(`UPDATE jackpot SET ${col}=$1, last_winner=$2, last_win_amount=$3, last_win_at=$4, last_win_tier=$5 WHERE id=1`, [JP_TIERS[tierIdx], u.uid, tierAmount, Date.now(), tierIdx]);
      await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'jackpot',$2,$3,$4,NULL,$5)`, [u.uid, tierAmount, newBalance, '🎰 جاكبوت طبق ' + (tierIdx + 1), Date.now()]);
    }

    const scatterCount = cntSc(result.finalGrid);
    let freeSpinsTriggered = false;
    if (scatterCount >= 4 && !isFree && !activeBonuses.has(u.uid)) {
      activeBonuses.set(u.uid, { spinsLeft: FREE_SPINS_COUNT, cumulativeMult: 0, totalWonInBonus: 0, initialBet: bet, bonusPrice: 0, bestWin: 0, startBalance: newBalance });
      freeSpinsTriggered = true;
    }

    res.json({ success: true, balance: newBalance, bet: isFree ? 0 : bet, betUsed, isFree, isFreeNow: isFree, totalWin, net, chains: result.chains, finalGrid: result.finalGrid, scatterCount, freeSpinsTriggered, bonusEnded, bonusSummary, jackpotTriggered: result.jpTriggered, jackpotWon, jackpotWonTier, jackpotWonAmount, jackpotSymbols: result.jpCount, activeBonus: activeBonuses.has(u.uid) ? { spinsLeft: activeBonuses.get(u.uid).spinsLeft, cumulativeMult: activeBonuses.get(u.uid).cumulativeMult, totalWonInBonus: activeBonuses.get(u.uid).totalWonInBonus } : null });
  } catch (e) { console.error('spin:', e); res.status(500).json({ error: 'خطأ' }); }
});

// ============ SLOT: GAMBLE / BONUS / WHEEL ============
app.post('/api/gamble', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { amount } = req.body;
    const u = req.user;
    if (typeof amount !== 'number' || amount <= 0) return res.status(400).json({ error: 'مبلغ غير صحيح' });
    if (amount > 10000000) return res.status(400).json({ error: 'الحد الأقصى' });
    const isWin = crypto.randomInt(0, 2) === 0;
    if (isWin) {
      const newBal = Number(u.balance) + amount;
      await pool.query('UPDATE users SET balance=$1, won=won+$2 WHERE uid=$3', [newBal, amount, u.uid]);
      await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'gamble_win',$2,$3,$4,NULL,$5)`, [u.uid, amount, newBal, 'ضاعف ناجح', Date.now()]);
      return res.json({ success: true, won: true, newBalance: newBal, awarded: amount });
    }
    res.json({ success: true, won: false, awarded: 0 });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/wheel/status', authUser, async (req, res) => {
  const u = req.user;
  const last = Number(u.last_wheel || 0);
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const canSpin = now - last >= ONE_DAY;
  res.json({ canSpin, nextAvailable: canSpin ? now : last + ONE_DAY, lastSpin: last });
});

app.post('/api/wheel/spin', authUser, rateLimit(5, 60000), async (req, res) => {
  try {
    const u = req.user;
    const last = Number(u.last_wheel || 0);
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (now - last < ONE_DAY) return res.status(400).json({ error: 'العجلة متاحة مرة كل 24 ساعة' });
    const total = WHEEL_WEIGHTS.reduce((a, b) => a + b, 0);
    let r = Math.random() * total;
    let idx = 0;
    for (let i = 0; i < WHEEL_WEIGHTS.length; i++) { r -= WHEEL_WEIGHTS[i]; if (r <= 0) { idx = i; break; } }
    const amount = WHEEL_VALUES[idx];
    const newBal = Number(u.balance) + amount;
    await pool.query('UPDATE users SET balance=$1, last_wheel=$2, won=won+$3 WHERE uid=$4', [newBal, now, amount, u.uid]);
    await pool.query('INSERT INTO wheel_spins (uid,amount,created_at) VALUES ($1,$2,$3)', [u.uid, amount, now]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'wheel',$2,$3,$4,NULL,$5)`, [u.uid, amount, newBal, 'عجلة الحظ', Date.now()]);
    res.json({ success: true, amount, index: idx, newBalance: newBal });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/buy-bonus', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { price, type } = req.body;
    const u = req.user;
    if (typeof price !== 'number' || price <= 0) return res.status(400).json({ error: 'سعر غير صحيح' });
    if (Number(u.balance) < price) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    if (activeBonuses.has(u.uid)) return res.status(400).json({ error: 'لديك بونص نشط' });
    const newBalance = Number(u.balance) - price;
    await pool.query('UPDATE users SET balance=$1 WHERE uid=$2', [newBalance, u.uid]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'bonus_buy',$2,$3,$4,NULL,$5)`, [u.uid, -price, newBalance, 'بونص ' + type, Date.now()]);
    const bet = type === 'premium' ? Math.floor(price / 200) : Math.floor(price / 50);
    activeBonuses.set(u.uid, { spinsLeft: FREE_SPINS_COUNT, cumulativeMult: 0, totalWonInBonus: 0, initialBet: bet, bonusPrice: price, bestWin: 0, startBalance: newBalance });
    res.json({ success: true, balance: newBalance, bet, bonusPrice: price, activeBonus: { spinsLeft: FREE_SPINS_COUNT, cumulativeMult: 0, totalWonInBonus: 0 } });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

// ============ JACKPOT & DAILY ============
app.get('/api/jackpot', async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM jackpot WHERE id = 1');
    const j = r.rows[0];
    res.json({ tier1: Number(j.tier1 || 16000), tier2: Number(j.tier2 || 60000), tier3: Number(j.tier3 || 300000), tier4: Number(j.tier4 || 700000), lastWinner: j.last_winner, lastWinAmount: Number(j.last_win_amount || 0), lastWinAt: Number(j.last_win_at || 0), lastWinTier: j.last_win_tier });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/daily/status', authUser, async (req, res) => {
  const u = req.user;
  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const canClaim = (now - Number(u.last_daily || 0)) >= ONE_DAY;
  let streak = Number(u.daily_streak || 0);
  if (u.last_daily && now - Number(u.last_daily) > ONE_DAY * 2) streak = 0;
  res.json({ canClaim, nextAvailable: canClaim ? now : Number(u.last_daily || 0) + ONE_DAY, streak, nextReward: DAILY_REWARDS[Math.min(streak, DAILY_REWARDS.length - 1)] });
});

app.post('/api/daily/claim', authUser, async (req, res) => {
  try {
    const u = req.user;
    const now = Date.now();
    const ONE_DAY = 24 * 60 * 60 * 1000;
    if (now - Number(u.last_daily || 0) < ONE_DAY) return res.status(400).json({ error: 'المكافأة متاحة مرة كل 24 ساعة' });
    let streak = Number(u.daily_streak || 0);
    if (u.last_daily && now - Number(u.last_daily) > ONE_DAY * 2) streak = 0;
    const reward = DAILY_REWARDS[Math.min(streak, DAILY_REWARDS.length - 1)];
    const newBal = Number(u.balance) + reward;
    const newStreak = streak + 1;
    await pool.query('UPDATE users SET balance=$1, last_daily=$2, daily_streak=$3, won=won+$4 WHERE uid=$5', [newBal, now, newStreak, reward, u.uid]);
    await pool.query('INSERT INTO daily_claims (uid,amount,streak,created_at) VALUES ($1,$2,$3,$4)', [u.uid, reward, newStreak, now]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'daily_bonus',$2,$3,$4,NULL,$5)`, [u.uid, reward, newBal, 'مكافأة يومية يوم ' + newStreak, now]);
    res.json({ success: true, amount: reward, streak: newStreak, newBalance: newBal });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

// ============ LEADERBOARD ============
app.get('/api/leaderboard', async (req, res) => {
  try {
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const startOfDay = today.getTime();
    const r = await pool.query(`SELECT u.uid, u.first_name, u.last_name, COALESCE(SUM(s.won),0)::bigint AS total_won FROM users u LEFT JOIN spins s ON s.uid=u.uid AND s.created_at>=$1 GROUP BY u.uid, u.first_name, u.last_name ORDER BY total_won DESC LIMIT 10`, [startOfDay]);
    const list = r.rows.map((x, i) => ({ rank: i + 1, uid: x.uid, mask: x.first_name ? x.first_name.charAt(0) + '***' : 'مجهول', won: Number(x.total_won) }));
    res.json({ leaderboard: list });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ AVIATOR GAME LOGIC =====================
// =====================================================
function aviatorNewRound() {
  aviatorState.roundId++;
  const r = Math.random();
  let cp;
  if (r > AVIATOR_RTP) cp = 1.00;
  else cp = Math.max(1.00, AVIATOR_RTP / (1 - r));
  cp = Math.min(cp, AVIATOR_MAX_MULT);
  aviatorState.crashPoint = Math.floor(cp * 100) / 100;
  aviatorState.state = 'waiting';
  aviatorState.startTime = Date.now() + AVIATOR_WAITING_MS;
  aviatorState.players.clear();

  setTimeout(() => {
    aviatorState.state = 'flying';
    aviatorState.startTime = Date.now();
    const flightMs = Math.log(aviatorState.crashPoint) / AVIATOR_GROWTH_RATE * 1000;
    setTimeout(() => {
      aviatorState.state = 'crashed';
      aviatorState.history.unshift(aviatorState.crashPoint);
      if (aviatorState.history.length > 20) aviatorState.history.pop();
      for (const [uid, p] of aviatorState.players) {
        if (!p.cashedOut) {
          pool.query(`INSERT INTO aviator_bets (round_id,uid,bet,multiplier,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
            [aviatorState.roundId, uid, p.bet, 0, 0, false, Date.now()]).catch(() => {});
        }
      }
      setTimeout(aviatorNewRound, AVIATOR_CRASH_DISPLAY_MS);
    }, flightMs);
  }, AVIATOR_WAITING_MS);
}

function aviatorCurrentMult() {
  if (aviatorState.state !== 'flying') return 1.00;
  const elapsed = (Date.now() - aviatorState.startTime) / 1000;
  return Math.pow(Math.E, AVIATOR_GROWTH_RATE * elapsed);
}

app.get('/api/aviator/state', async (req, res) => {
  try {
    const now = Date.now();
    const currentMult = aviatorCurrentMult();
    const elapsed = aviatorState.state === 'flying' ? (now - aviatorState.startTime) / 1000 : 0;

    res.json({
      roundId: aviatorState.roundId,
      state: aviatorState.state,
      startTime: aviatorState.startTime,
      waitingUntil: aviatorState.state === 'waiting' ? aviatorState.startTime : null,
      crashPoint: aviatorState.state === 'crashed' ? aviatorState.crashPoint : null,
      currentMult: Math.floor(currentMult * 100) / 100,
      elapsed: Math.floor(elapsed * 10) / 10,
      history: aviatorState.history.slice(0, 20)
    });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/aviator/bet', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { amount } = req.body;
    const u = req.user;
    if (typeof amount !== 'number' || amount < 20 || amount > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    if (Number(u.balance) < amount) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    if (aviatorState.state !== 'waiting') return res.status(400).json({ error: 'الجولة بدأت — انتظر الجولة القادمة' });
    if (aviatorState.players.has(u.uid)) return res.status(400).json({ error: 'لديك رهان في هذه الجولة' });

    const newBal = Number(u.balance) - amount;
    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2 WHERE uid=$3', [newBal, amount, u.uid]);
    aviatorState.players.set(u.uid, { bet: amount, cashedOut: false, cashoutMult: 0, cashoutAmount: 0 });
    await addJackpotContribution(amount);

    res.json({ success: true, balance: newBal, bet: amount, roundId: aviatorState.roundId });
  } catch (e) { console.error('aviator bet:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/aviator/cashout', authUser, rateLimit(60, 60000), async (req, res) => {
  try {
    const u = req.user;
    if (aviatorState.state !== 'flying') return res.status(400).json({ error: 'الطائرة لم تكن في الجو' });
    const p = aviatorState.players.get(u.uid);
    if (!p) return res.status(400).json({ error: 'لا يوجد رهان' });
    if (p.cashedOut) return res.status(400).json({ error: 'سحبت بالفعل' });

    const currentMult = aviatorCurrentMult();
    if (currentMult >= aviatorState.crashPoint) return res.status(400).json({ error: 'فوت الوقت — انفجرت' });

    const roundedMult = Math.floor(currentMult * 100) / 100;
    const amount = Math.floor(p.bet * roundedMult);
    p.cashedOut = true;
    p.cashoutMult = roundedMult;
    p.cashoutAmount = amount;

    const refR = await pool.query('SELECT balance FROM users WHERE uid = $1', [u.uid]);
    const newBal = Number(refR.rows[0].balance) + amount;
    await pool.query('UPDATE users SET balance=$1, won=won+$2, best_win=GREATEST(best_win,$3) WHERE uid=$4', [newBal, amount, amount, u.uid]);
    await pool.query(`INSERT INTO aviator_bets (round_id,uid,bet,multiplier,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [aviatorState.roundId, u.uid, p.bet, roundedMult, amount, true, Date.now()]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'aviator_win',$2,$3,$4,NULL,$5)`,
      [u.uid, amount, newBal, 'طائرة x' + roundedMult, Date.now()]);

    res.json({ success: true, balance: newBal, multiplier: roundedMult, amount });
  } catch (e) { console.error('aviator cashout:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/aviator/history', authUser, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM aviator_bets WHERE uid = $1 ORDER BY id DESC LIMIT 30', [req.user.uid]);
    res.json({ bets: r.rows });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ MINES GAME LOGIC ======================
// =====================================================
function minesGenerate(minesCount) {
  const grid = new Array(25).fill(0);
  const positions = [...Array(25).keys()];
  for (let i = 0; i < minesCount; i++) {
    const idx = crypto.randomInt(0, positions.length);
    grid[positions[idx]] = 1;
    positions.splice(idx, 1);
  }
  return grid;
}

function minesMultiplier(mines, revealed) {
  if (revealed === 0) return 1.00;
  let prob = 1;
  for (let i = 0; i < revealed; i++) prob *= (25 - mines - i) / (25 - i);
  return Math.max(1.00, Math.floor((MINES_RTP / prob) * 100) / 100);
}

app.post('/api/mines/start', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { bet, mines } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    if (typeof mines !== 'number' || mines < 1 || mines > 24) return res.status(400).json({ error: 'عدد الألغام بين 1 و 24' });
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    if (minesGames.has(u.uid)) return res.status(400).json({ error: 'لديك لعبة نشطة' });

    const grid = minesGenerate(mines);
    const newBal = Number(u.balance) - bet;
    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2 WHERE uid=$3', [newBal, bet, u.uid]);
    await addJackpotContribution(bet);

    minesGames.set(u.uid, { grid, mines, bet, revealed: [], cashout: 0, roundId: Date.now() });
    res.json({ success: true, balance: newBal, gameId: Date.now() });
  } catch (e) { console.error('mines start:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/mines/reveal', authUser, rateLimit(120, 60000), async (req, res) => {
  try {
    const { tile } = req.body;
    const u = req.user;
    const g = minesGames.get(u.uid);
    if (!g) return res.status(400).json({ error: 'لا توجد لعبة' });
    if (typeof tile !== 'number' || tile < 0 || tile > 24) return res.status(400).json({ error: 'خانة غير صحيحة' });
    if (g.revealed.includes(tile)) return res.status(400).json({ error: 'فتحت هذه الخانة مسبقاً' });

    if (g.grid[tile] === 1) {
      minesGames.delete(u.uid);
      await pool.query(`INSERT INTO mines_games (uid,bet,mines,revealed,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [u.uid, g.bet, g.mines, g.revealed.length, 0, false, Date.now()]);
      return res.json({ success: true, hitMine: true, revealed: g.revealed, mineIndex: tile, gameOver: true });
    }

    g.revealed.push(tile);
    const multiplier = minesMultiplier(g.mines, g.revealed.length);
    const nextAmount = Math.floor(g.bet * multiplier);

    res.json({ success: true, hitMine: false, tile, revealed: g.revealed, multiplier, nextAmount, revealedCount: g.revealed.length });
  } catch (e) { console.error('mines reveal:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/mines/cashout', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const u = req.user;
    const g = minesGames.get(u.uid);
    if (!g) return res.status(400).json({ error: 'لا توجد لعبة' });
    if (g.revealed.length === 0) return res.status(400).json({ error: 'افتح خانة واحدة على الأقل' });

    const multiplier = minesMultiplier(g.mines, g.revealed.length);
    const amount = Math.floor(g.bet * multiplier);
    minesGames.delete(u.uid);

    const refR = await pool.query('SELECT balance FROM users WHERE uid = $1', [u.uid]);
    const newBal = Number(refR.rows[0].balance) + amount;
    await pool.query('UPDATE users SET balance=$1, won=won+$2, best_win=GREATEST(best_win,$3) WHERE uid=$4', [newBal, amount, amount, u.uid]);
    await pool.query(`INSERT INTO mines_games (uid,bet,mines,revealed,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.uid, g.bet, g.mines, g.revealed.length, amount, true, Date.now()]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'mines_win',$2,$3,$4,NULL,$5)`,
      [u.uid, amount, newBal, 'ألغام x' + multiplier, Date.now()]);

    res.json({ success: true, balance: newBal, multiplier, amount, revealed: g.revealed, grid: g.grid });
  } catch (e) { console.error('mines cashout:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/mines/cancel', authUser, async (req, res) => {
  const g = minesGames.get(req.user.uid);
  if (g && g.revealed.length === 0) {
    minesGames.delete(req.user.uid);
    const newBal = Number(req.user.balance) + g.bet;
    await pool.query('UPDATE users SET balance=$1 WHERE uid=$2', [newBal, req.user.uid]);
    return res.json({ success: true, refund: g.bet, balance: newBal });
  }
  res.status(400).json({ error: 'لا يمكن الإلغاء' });
});

// =====================================================
// ============ CHICKEN ROAD ===========================
// =====================================================
function chickenMultiplier(step, difficulty) {
  const lanes = { 1: 3, 2: 4, 3: 5, 4: 6 }[difficulty] || 3;
  let prob = 1;
  for (let i = 0; i < step; i++) prob *= (lanes - 1) / lanes;
  return Math.max(1.00, Math.floor((CHICKEN_RTP / prob) * 100) / 100);
}

app.post('/api/chicken/start', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { bet, difficulty } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    const diff = parseInt(difficulty) || 1;
    if (diff < 1 || diff > 4) return res.status(400).json({ error: 'صعوبة غير صحيحة' });
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    if (CHICKEN_ROADS.has(u.uid)) return res.status(400).json({ error: 'لديك لعبة نشطة' });

    const newBal = Number(u.balance) - bet;
    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2 WHERE uid=$3', [newBal, bet, u.uid]);
    await addJackpotContribution(bet);

    CHICKEN_ROADS.set(u.uid, { bet, difficulty: diff, step: 0, multiplier: 1, active: true });
    res.json({ success: true, balance: newBal, nextMultiplier: chickenMultiplier(1, diff) });
  } catch (e) { console.error('chicken start:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/chicken/step', authUser, rateLimit(120, 60000), async (req, res) => {
  try {
    const u = req.user;
    const g = CHICKEN_ROADS.get(u.uid);
    if (!g || !g.active) return res.status(400).json({ error: 'لا توجد لعبة' });
    if (g.step >= 24) return res.status(400).json({ error: 'وصلت النهاية!' });

    const lanes = { 1: 3, 2: 4, 3: 5, 4: 6 }[g.difficulty];
    const crashed = crypto.randomInt(0, lanes) === 0;

    if (crashed) {
      CHICKEN_ROADS.delete(u.uid);
      const refR = await pool.query('SELECT balance FROM users WHERE uid=$1', [u.uid]);
      await pool.query(`INSERT INTO chicken_games (uid,bet,difficulty,steps,multiplier,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [u.uid, g.bet, g.difficulty, g.step, g.multiplier, 0, false, Date.now()]).catch(() => {});
      await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'chicken_loss',$2,$3,$4,NULL,$5)`,
        [u.uid, -g.bet, Number(refR.rows[0].balance), 'خسارة تشكن روود', Date.now()]).catch(() => {});
      return res.json({ success: true, crashed: true, step: g.step, multiplier: g.multiplier });
    }

    g.step++;
    g.multiplier = chickenMultiplier(g.step, g.difficulty);
    const nextMult = chickenMultiplier(g.step + 1, g.difficulty);
    res.json({ success: true, crashed: false, step: g.step, multiplier: g.multiplier, nextMultiplier: nextMult });
  } catch (e) { console.error('chicken step:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/chicken/cashout', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const u = req.user;
    const g = CHICKEN_ROADS.get(u.uid);
    if (!g || !g.active) return res.status(400).json({ error: 'لا توجد لعبة' });
    if (g.step === 0) return res.status(400).json({ error: 'تقدّم خطوة أولاً' });

    const amount = Math.floor(g.bet * g.multiplier);
    CHICKEN_ROADS.delete(u.uid);
    const refR = await pool.query('SELECT balance FROM users WHERE uid=$1', [u.uid]);
    const newBal = Number(refR.rows[0].balance) + amount;
    await pool.query('UPDATE users SET balance=$1, won=won+$2, best_win=GREATEST(best_win,$3) WHERE uid=$4', [newBal, amount, amount, u.uid]);
    await pool.query(`INSERT INTO chicken_games (uid,bet,difficulty,steps,multiplier,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.uid, g.bet, g.difficulty, g.step, g.multiplier, amount, true, Date.now()]).catch(() => {});
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'chicken_win',$2,$3,$4,NULL,$5)`,
      [u.uid, amount, newBal, 'دجاجة x' + g.multiplier, Date.now()]);
    res.json({ success: true, balance: newBal, amount, multiplier: g.multiplier, step: g.step });
  } catch (e) { console.error('chicken cashout:', e); res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ PLINKO =================================
// =====================================================
app.post('/api/plinko/drop', authUser, rateLimit(60, 60000), async (req, res) => {
  try {
    const { bet, risk = 'medium', rows = 12 } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    const r = parseInt(rows);
    if (r < 8 || r > 16) return res.status(400).json({ error: 'الصفوف بين 8 و 16' });
    const riskKey = ['low', 'medium', 'high'].includes(risk) ? risk : 'medium';
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const path = [];
    let position = 0;
    for (let i = 0; i < r; i++) {
      const right = crypto.randomInt(0, 2) === 1;
      path.push(right ? 'R' : 'L');
      if (right) position++;
    }

    const PLINKO_PAYOUTS = {
      low: [5.6, 2.1, 1.1, 1.0, 0.5, 1.0, 1.1, 2.1, 5.6],
      medium: [13, 3, 1.3, 0.7, 0.4, 0.7, 1.3, 3, 13],
      high: [29, 4, 1.5, 0.3, 0.2, 0.3, 1.5, 4, 29]
    };
    const basePayouts = PLINKO_PAYOUTS[riskKey];
    const slotCount = r + 1;
    const payouts = [];
    for (let i = 0; i < slotCount; i++) {
      const t = i / (slotCount - 1);
      const mirrored = 1 - Math.abs(t - 0.5) * 2;
      const idx = Math.min(basePayouts.length - 1, Math.floor(mirrored * basePayouts.length));
      payouts.push(basePayouts[idx]);
    }
    const mult = payouts[position] || 1;
    const win = Math.floor(bet * mult);
    const net = win - bet;
    const newBal = Number(u.balance) + net;

    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2, won=won+$3, best_win=GREATEST(best_win,$4) WHERE uid=$5',
      [newBal, bet, win, win, u.uid]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'plinko',$2,$3,$4,NULL,$5)`,
      [u.uid, net, newBal, 'plinko x' + mult, Date.now()]);
    await pool.query(`INSERT INTO plinko_games (uid,bet,risk,rows_count,slot,multiplier,win,path,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [u.uid, bet, riskKey, r, position, mult, win, path.join(''), Date.now()]).catch(() => {});
    await addJackpotContribution(bet);

    res.json({ success: true, balance: newBal, path, slot: position, multiplier: mult, win, net, payouts });
  } catch (e) { console.error('plinko:', e); res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ DICE ===================================
// =====================================================
app.post('/api/dice/roll', authUser, rateLimit(120, 60000), async (req, res) => {
  try {
    const { bet, target, direction } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    const t = parseFloat(target);
    if (isNaN(t) || t < 2 || t > 98) return res.status(400).json({ error: 'الهدف بين 2 و 98' });
    if (!['over', 'under'].includes(direction)) return res.status(400).json({ error: 'اتجاه غير صحيح' });
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const roll = crypto.randomInt(0, 10000) / 100;
    const won = direction === 'over' ? roll > t : roll < t;
    const winChance = direction === 'over' ? (100 - t) : t;
    const payout = won ? Math.floor(bet * (DICE_RTP * 100 / winChance)) : 0;
    const net = payout - bet;
    const newBal = Number(u.balance) + net;

    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2, won=won+$3, best_win=GREATEST(best_win,$4) WHERE uid=$5',
      [newBal, bet, payout, payout, u.uid]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'dice',$2,$3,$4,NULL,$5)`,
      [u.uid, net, newBal, 'نرد ' + roll + ' ' + direction + ' ' + t, Date.now()]);
    await pool.query(`INSERT INTO dice_games (uid,bet,target,direction,roll,won,payout,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [u.uid, bet, t, direction, roll, won, payout, Date.now()]).catch(() => {});
    await addJackpotContribution(bet);

    res.json({ success: true, balance: newBal, roll, won, payout, net, target: t, direction });
  } catch (e) { console.error('dice:', e); res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ LIMBO ==================================
// =====================================================
app.post('/api/limbo/play', authUser, rateLimit(120, 60000), async (req, res) => {
  try {
    const { bet, target } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    const t = parseFloat(target);
    if (isNaN(t) || t < 1.01 || t > 1000) return res.status(400).json({ error: 'الهدف بين 1.01 و 1000' });
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const r = Math.random();
    const result = Math.max(1.00, Math.floor(((1 - LIMBO_HOUSE_EDGE) / (1 - r)) * 100) / 100);
    const won = result >= t;
    const payout = won ? Math.floor(bet * t) : 0;
    const net = payout - bet;
    const newBal = Number(u.balance) + net;

    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2, won=won+$3, best_win=GREATEST(best_win,$4) WHERE uid=$5',
      [newBal, bet, payout, payout, u.uid]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'limbo',$2,$3,$4,NULL,$5)`,
      [u.uid, net, newBal, 'ليمبو x' + result, Date.now()]);
    await pool.query(`INSERT INTO limbo_games (uid,bet,target,result,won,payout,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.uid, bet, t, result, won, payout, Date.now()]).catch(() => {});
    await addJackpotContribution(bet);

    res.json({ success: true, balance: newBal, result, won, payout, net, target: t });
  } catch (e) { console.error('limbo:', e); res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ COINFLIP ===============================
// =====================================================
app.post('/api/coinflip/play', authUser, rateLimit(120, 60000), async (req, res) => {
  try {
    const { bet, pick } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    if (!['heads', 'tails'].includes(pick)) return res.status(400).json({ error: 'اختر وجه أو كتابة' });
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const result = crypto.randomInt(0, 2) === 0 ? 'heads' : 'tails';
    const won = result === pick;
    const payout = won ? Math.floor(bet * (COINFLIP_RTP * 2)) : 0;
    const net = payout - bet;
    const newBal = Number(u.balance) + net;

    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2, won=won+$3, best_win=GREATEST(best_win,$4) WHERE uid=$5',
      [newBal, bet, payout, payout, u.uid]);
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'coinflip',$2,$3,$4,NULL,$5)`,
      [u.uid, net, newBal, 'كوين فليب ' + result, Date.now()]);
    await pool.query(`INSERT INTO coinflip_games (uid,bet,pick,result,won,payout,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [u.uid, bet, pick, result, won, payout, Date.now()]).catch(() => {});
    await addJackpotContribution(bet);

    res.json({ success: true, balance: newBal, result, won, payout, net, pick });
  } catch (e) { console.error('coinflip:', e); res.status(500).json({ error: 'خطأ' }); }
});

// =====================================================
// ============ TOWER ==================================
// =====================================================
function towerMultiplier(level, difficulty) {
  // difficulty 1=easy (4 tiles), 2=medium (3), 3=hard (2)
  const tiles = { 1: 4, 2: 3, 3: 2 }[difficulty] || 4;
  let prob = 1;
  for (let i = 0; i < level; i++) prob *= 1 / tiles;
  return Math.max(1.00, Math.floor((TOWER_RTP / prob) * 100) / 100);
}

app.post('/api/tower/start', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { bet, difficulty } = req.body;
    const u = req.user;
    if (typeof bet !== 'number' || bet < 20 || bet > 1000000) return res.status(400).json({ error: 'الرهان بين 20 و 1,000,000' });
    const diff = parseInt(difficulty) || 1;
    if (diff < 1 || diff > 3) return res.status(400).json({ error: 'صعوبة غير صحيحة' });
    if (Number(u.balance) < bet) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    if (TOWER_GAMES.has(u.uid)) return res.status(400).json({ error: 'لديك لعبة نشطة' });

    const newBal = Number(u.balance) - bet;
    await pool.query('UPDATE users SET balance=$1, wagered=wagered+$2 WHERE uid=$3', [newBal, bet, u.uid]);
    await addJackpotContribution(bet);
    TOWER_GAMES.set(u.uid, { bet, difficulty: diff, level: 0, multiplier: 1, active: true });
    res.json({ success: true, balance: newBal, nextMultiplier: towerMultiplier(1, diff) });
  } catch (e) { console.error('tower start:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/tower/pick', authUser, rateLimit(120, 60000), async (req, res) => {
  try {
    const { tile } = req.body;
    const u = req.user;
    const g = TOWER_GAMES.get(u.uid);
    if (!g || !g.active) return res.status(400).json({ error: 'لا توجد لعبة' });
    const tiles = { 1: 4, 2: 3, 3: 2 }[g.difficulty];
    const t = parseInt(tile);
    if (isNaN(t) || t < 0 || t >= tiles) return res.status(400).json({ error: 'خانة غير صحيحة' });

    const safeTile = crypto.randomInt(0, tiles);
    if (t !== safeTile) {
      TOWER_GAMES.delete(u.uid);
      const refR = await pool.query('SELECT balance FROM users WHERE uid=$1', [u.uid]);
      await pool.query(`INSERT INTO tower_games (uid,bet,difficulty,level,multiplier,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [u.uid, g.bet, g.difficulty, g.level, g.multiplier, 0, false, Date.now()]).catch(() => {});
      return res.json({ success: true, crashed: true, level: g.level, safeTile, multiplier: g.multiplier });
    }

    g.level++;
    g.multiplier = towerMultiplier(g.level, g.difficulty);
    const nextMult = towerMultiplier(g.level + 1, g.difficulty);
    res.json({ success: true, crashed: false, level: g.level, safeTile, multiplier: g.multiplier, nextMultiplier: nextMult });
  } catch (e) { console.error('tower pick:', e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/tower/cashout', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const u = req.user;
    const g = TOWER_GAMES.get(u.uid);
    if (!g || !g.active) return res.status(400).json({ error: 'لا توجد لعبة' });
    if (g.level === 0) return res.status(400).json({ error: 'اصعد طابقاً واحداً أولاً' });

    const amount = Math.floor(g.bet * g.multiplier);
    TOWER_GAMES.delete(u.uid);
    const refR = await pool.query('SELECT balance FROM users WHERE uid=$1', [u.uid]);
    const newBal = Number(refR.rows[0].balance) + amount;
    await pool.query('UPDATE users SET balance=$1, won=won+$2, best_win=GREATEST(best_win,$3) WHERE uid=$4', [newBal, amount, amount, u.uid]);
    await pool.query(`INSERT INTO tower_games (uid,bet,difficulty,level,multiplier,cashout,won,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [u.uid, g.bet, g.difficulty, g.level, g.multiplier, amount, true, Date.now()]).catch(() => {});
    await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'tower_win',$2,$3,$4,NULL,$5)`,
      [u.uid, amount, newBal, 'برج x' + g.multiplier, Date.now()]);
    res.json({ success: true, balance: newBal, amount, multiplier: g.multiplier, level: g.level });
  } catch (e) { console.error('tower cashout:', e); res.status(500).json({ error: 'خطأ' }); }
});

// ============ WALLET ============
app.get('/api/wallet/methods', (req, res) => {
  res.json({ methods: PAYMENT_METHODS.map(m => ({ ...m, company_wallet: COMPANY_WALLETS[m.code] || '' })) });
});

app.get('/api/wallet/my-addresses', authUser, async (req, res) => {
  const w = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [req.user.uid]);
  const r = w.rows[0] || {};
  res.json({ sham_syp: r.sham_syp || '', sham_usd: r.sham_usd || '', usdt_bep20: r.usdt_bep20 || '', usdt_trc20: r.usdt_trc20 || '' });
});

app.post('/api/wallet/save-address', authUser, async (req, res) => {
  const { sham_syp, sham_usd, usdt_bep20, usdt_trc20 } = req.body;
  await pool.query(`INSERT INTO user_wallets (uid,sham_syp,sham_usd,usdt_bep20,usdt_trc20,updated_at) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (uid) DO UPDATE SET sham_syp=EXCLUDED.sham_syp, sham_usd=EXCLUDED.sham_usd, usdt_bep20=EXCLUDED.usdt_bep20, usdt_trc20=EXCLUDED.usdt_trc20, updated_at=EXCLUDED.updated_at`, [req.user.uid, sham_syp || '', sham_usd || '', usdt_bep20 || '', usdt_trc20 || '', Date.now()]);
  res.json({ success: true });
});

app.post('/api/wallet/deposit', authUser, rateLimit(15, 60000), async (req, res) => {
  try {
    const { method_code, amount, tx_hash } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if (!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < method.min || amountNum > method.max) return res.status(400).json({ error: 'المبلغ غير صحيح' });
    const amountSyp = Math.floor(amountNum * method.rate);
    const pending = await pool.query("SELECT id FROM deposit_requests WHERE uid = $1 AND status = 'pending' LIMIT 1", [req.user.uid]);
    if (pending.rows.length) return res.status(400).json({ error: 'لديك طلب إيداع معلق' });
    await pool.query(`INSERT INTO deposit_requests (uid,method_code,amount,amount_syp,tx_hash,status,created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)`, [req.user.uid, method_code, amountNum, amountSyp, tx_hash || '', Date.now()]);
    res.json({ success: true, message: 'تم استلام الطلب', amount_syp: amountSyp });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/wallet/withdraw', authUser, rateLimit(5, 60000), async (req, res) => {
  try {
    const { method_code, amount, wallet_to } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if (!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    if (!wallet_to || wallet_to.length < 5) return res.status(400).json({ error: 'أدخل عنوان المحفظة' });
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < method.min || amountNum > method.max) return res.status(400).json({ error: 'المبلغ غير صحيح' });
    const amountSyp = Math.floor(amountNum * method.rate);
    if (Number(req.user.balance) < amountSyp) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    const pending = await pool.query("SELECT id FROM withdraw_requests WHERE uid = $1 AND status = 'pending' LIMIT 1", [req.user.uid]);
    if (pending.rows.length) return res.status(400).json({ error: 'لديك طلب سحب معلق' });
    const newBal = Number(req.user.balance) - amountSyp;
    await pool.query('UPDATE users SET balance=$1 WHERE uid=$2', [newBal, req.user.uid]);
    await pool.query(`INSERT INTO withdraw_requests (uid,method_code,amount,amount_syp,wallet_to,status,created_at) VALUES ($1,$2,$3,$4,$5,'pending',$6)`, [req.user.uid, method_code, amountNum, amountSyp, wallet_to, Date.now()]);
    res.json({ success: true, message: 'تم استلام الطلب', amount_syp: amountSyp });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/wallet/history', authUser, async (req, res) => {
  const deposits = await pool.query('SELECT * FROM deposit_requests WHERE uid = $1 ORDER BY id DESC LIMIT 30', [req.user.uid]);
  const withdraws = await pool.query('SELECT * FROM withdraw_requests WHERE uid = $1 ORDER BY id DESC LIMIT 30', [req.user.uid]);
  res.json({ deposits: deposits.rows, withdraws: withdraws.rows });
});

// ============ AGENT ============
app.get('/api/agent/info', authUser, async (req, res) => {
  const u = req.user;
  const referrals = await pool.query('SELECT uid,first_name,last_name,balance,laps,wagered,won,created_at,last_login FROM users WHERE referred_by = $1 ORDER BY created_at DESC', [u.uid]);
  const commissions = await pool.query('SELECT * FROM commissions WHERE agent_uid = $1 ORDER BY id DESC LIMIT 100', [u.uid]);
  const refs = referrals.rows.map(r => ({ uid: r.uid, first_name: r.first_name, last_name: r.last_name, balance: Number(r.balance), laps: r.laps, wagered: Number(r.wagered), won: Number(r.won), created_at: Number(r.created_at), last_login: Number(r.last_login) }));
  const totalRefWagered = refs.reduce((s, r) => s + r.wagered, 0);
  const totalRefWon = refs.reduce((s, r) => s + r.won, 0);
  const totalRefLost = Math.max(0, totalRefWagered - totalRefWon);
  res.json({ invite_code: u.invite_code, agent_level: u.agent_level, total_commission: Number(u.total_commission), referrals_count: refs.length, referrals: refs, commissions: commissions.rows.map(c => ({ ...c, amount: Number(c.amount), created_at: Number(c.created_at) })), stats: { total_ref_wagered: totalRefWagered, total_ref_won: totalRefWon, total_ref_lost: totalRefLost } });
});

app.post('/api/agent/become', authUser, async (req, res) => {
  if (req.user.agent_level > 0) return res.status(400).json({ error: 'أنت وكيل بالفعل' });
  await pool.query('UPDATE users SET agent_level = 1 WHERE uid = $1', [req.user.uid]);
  res.json({ success: true, message: 'تم ترقيتك' });
});

app.get('/api/rtp', (req, res) => res.json({ rtp: RTP, houseEdge: 1 - RTP, maxWinMult: MAX_WIN_MULT }));

// ============ ADMIN ============
app.post('/api/admin/login', rateLimit(5, 60000), (req, res) => {
  const { password } = req.body;
  if (password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'كلمة مرور خاطئة' });
  res.json({ success: true, token: ADMIN_TOKEN });
});

app.get('/api/admin/stats', authAdmin, async (req, res) => {
  try {
    const users = await pool.query('SELECT COUNT(*)::int AS c FROM users');
    const totalBalance = await pool.query('SELECT COALESCE(SUM(balance),0)::bigint AS s FROM users');
    const totalWagered = await pool.query('SELECT COALESCE(SUM(wagered),0)::bigint AS s FROM users');
    const totalWon = await pool.query('SELECT COALESCE(SUM(won),0)::bigint AS s FROM users');
    const spins = await pool.query('SELECT COUNT(*)::int AS c FROM spins');
    const aviatorBets = await pool.query('SELECT COUNT(*)::int AS c FROM aviator_bets');
    const minesGamesCount = await pool.query('SELECT COUNT(*)::int AS c FROM mines_games');
    const activeToday = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE last_login > $1', [Date.now() - 86400000]);
    const banned = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE banned = 1');
    const pendingDeposits = await pool.query("SELECT COUNT(*)::int AS c FROM deposit_requests WHERE status='pending'");
    const pendingWithdraws = await pool.query("SELECT COUNT(*)::int AS c FROM withdraw_requests WHERE status='pending'");
    const agents = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE agent_level > 0');
    const totalCommission = await pool.query('SELECT COALESCE(SUM(amount),0)::bigint AS s FROM commissions');
    const jr = await pool.query('SELECT * FROM jackpot WHERE id=1'); const j = jr.rows[0] || {};
    const tw = Number(totalWagered.rows[0].s);
    const wn = Number(totalWon.rows[0].s);
    res.json({ totalUsers: users.rows[0].c, totalBalance: Number(totalBalance.rows[0].s), totalWagered: tw, totalWon: wn, totalSpins: spins.rows[0].c, aviatorBets: aviatorBets.rows[0].c, minesGames: minesGamesCount.rows[0].c, activeToday: activeToday.rows[0].c, banned: banned.rows[0].c, pendingDeposits: pendingDeposits.rows[0].c, pendingWithdraws: pendingWithdraws.rows[0].c, agents: agents.rows[0].c, totalCommission: Number(totalCommission.rows[0].s), jackpot: { tier1: Number(j.tier1 || 16000), tier2: Number(j.tier2 || 60000), tier3: Number(j.tier3 || 300000), tier4: Number(j.tier4 || 700000) }, houseProfit: tw - wn, rtp: tw > 0 ? (wn / tw * 100).toFixed(2) + '%' : '—' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const { search, sort, limit = 100, offset = 0 } = req.query;
    let whereSql = ''; const params = [];
    if (search) { params.push('%' + search.toLowerCase() + '%'); whereSql = `WHERE LOWER(uid) LIKE $1 OR LOWER(phone) LIKE $1 OR LOWER(email) LIKE $1 OR LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(invite_code) LIKE $1`; }
    const sortMap = { balance: 'balance DESC', balance_asc: 'balance ASC', laps: 'laps DESC', best: 'best_win DESC', recent: 'last_login DESC', created: 'created_at DESC', commission: 'total_commission DESC' };
    const orderBy = sortMap[sort] || sortMap.created;
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM users ${whereSql}`, params);
    params.push(parseInt(limit)); params.push(parseInt(offset));
    const users = await pool.query(`SELECT * FROM users ${whereSql} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const mapped = users.rows.map(u => ({ id: u.id, uid: u.uid, first_name: u.first_name, last_name: u.last_name, phone: u.phone, email: u.email, balance: Number(u.balance), laps: u.laps, best_win: Number(u.best_win), wagered: Number(u.wagered), won: Number(u.won), banned: u.banned, referred_by: u.referred_by, agent_level: u.agent_level, invite_code: u.invite_code, total_commission: Number(u.total_commission), notes: u.notes, created_at: Number(u.created_at), last_login: Number(u.last_login), last_ip: u.last_ip }));
    res.json({ users: mapped, total: total.rows[0].c });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/user/:uid', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE uid = $1 OR phone = $1 LIMIT 1', [req.params.uid]);
    if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
    const user = r.rows[0];
    const spins = await pool.query('SELECT * FROM spins WHERE uid = $1 ORDER BY id DESC LIMIT 100', [user.uid]);
    const aviatorBets = await pool.query('SELECT * FROM aviator_bets WHERE uid = $1 ORDER BY id DESC LIMIT 100', [user.uid]);
    const minesGamesList = await pool.query('SELECT * FROM mines_games WHERE uid = $1 ORDER BY id DESC LIMIT 100', [user.uid]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE uid = $1 ORDER BY id DESC LIMIT 100', [user.uid]);
    const logins = await pool.query('SELECT * FROM login_log WHERE uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    const deposits = await pool.query('SELECT * FROM deposit_requests WHERE uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    const withdraws = await pool.query('SELECT * FROM withdraw_requests WHERE uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    const referrals = await pool.query('SELECT uid,first_name,last_name,created_at FROM users WHERE referred_by = $1', [user.uid]);
    const commissions = await pool.query('SELECT * FROM commissions WHERE agent_uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    res.json({ user, spins: spins.rows, aviatorBets: aviatorBets.rows, minesGames: minesGamesList.rows, transactions: transactions.rows, logins: logins.rows, deposits: deposits.rows, withdraws: withdraws.rows, referrals: referrals.rows, commissions: commissions.rows });
  } catch (e) { res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/update-balance', authAdmin, async (req, res) => {
  const { uid, newBalance, note } = req.body;
  if (typeof newBalance !== 'number') return res.status(400).json({ error: 'قيمة غير صحيحة' });
  const r = await pool.query('SELECT balance FROM users WHERE uid = $1', [uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
  const diff = newBalance - Number(r.rows[0].balance);
  await pool.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBalance, uid]);
  await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,$2,$3,$4,$5,'admin',$6)`, [uid, diff >= 0 ? 'admin_credit' : 'admin_debit', diff, newBalance, note || '', Date.now()]);
  res.json({ success: true, newBalance });
});

app.post('/api/admin/adjust-balance', authAdmin, async (req, res) => {
  const { uid, amount, note } = req.body;
  if (typeof amount !== 'number') return res.status(400).json({ error: 'قيمة غير صحيحة' });
  const r = await pool.query('SELECT balance FROM users WHERE uid = $1', [uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
  const newBal = Math.max(0, Number(r.rows[0].balance) + amount);
  await pool.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBal, uid]);
  await pool.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,$2,$3,$4,$5,'admin',$6)`, [uid, amount >= 0 ? 'admin_credit' : 'admin_debit', amount, newBal, note || '', Date.now()]);
  res.json({ success: true, newBalance: newBal });
});

app.post('/api/admin/toggle-ban', authAdmin, async (req, res) => {
  const { uid } = req.body;
  const r = await pool.query('SELECT banned FROM users WHERE uid = $1', [uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
  const nb = r.rows[0].banned ? 0 : 1;
  await pool.query('UPDATE users SET banned = $1 WHERE uid = $2', [nb, uid]);
  res.json({ success: true, banned: nb });
});

app.post('/api/admin/set-note', authAdmin, async (req, res) => {
  const { uid, note } = req.body;
  await pool.query('UPDATE users SET notes = $1 WHERE uid = $2', [note || '', uid]);
  res.json({ success: true });
});

app.post('/api/admin/set-agent-level', authAdmin, async (req, res) => {
  const { uid, level } = req.body;
  const lvl = Math.max(0, Math.min(3, parseInt(level) || 0));
  await pool.query('UPDATE users SET agent_level = $1 WHERE uid = $2', [lvl, uid]);
  res.json({ success: true, level: lvl });
});

app.post('/api/admin/set-jackpot', authAdmin, async (req, res) => {
  const { tier1, tier2, tier3, tier4 } = req.body;
  const updates = []; const vals = [];
  if (typeof tier1 === 'number') { updates.push('tier1=$' + (vals.length + 1)); vals.push(tier1); }
  if (typeof tier2 === 'number') { updates.push('tier2=$' + (vals.length + 1)); vals.push(tier2); }
  if (typeof tier3 === 'number') { updates.push('tier3=$' + (vals.length + 1)); vals.push(tier3); }
  if (typeof tier4 === 'number') { updates.push('tier4=$' + (vals.length + 1)); vals.push(tier4); }
  if (!updates.length) return res.status(400).json({ error: 'لا توجد قيم' });
  await pool.query(`UPDATE jackpot SET ${updates.join(',')} WHERE id=1`, vals);
  res.json({ success: true });
});

app.get('/api/admin/deposits', authAdmin, async (req, res) => {
  const { status = 'pending' } = req.query;
  const r = await pool.query(`SELECT d.*, u.first_name, u.last_name, u.phone FROM deposit_requests d LEFT JOIN users u ON u.uid = d.uid WHERE d.status = $1 ORDER BY d.id DESC LIMIT 200`, [status]);
  res.json({ deposits: r.rows });
});

app.post('/api/admin/deposits/process', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id, action, admin_note } = req.body;
    const dr = await client.query('SELECT * FROM deposit_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!dr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'غير موجود' }); }
    const deposit = dr.rows[0];
    if (deposit.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'تمت معالجته' }); }
    if (action === 'approve') {
      const ur = await client.query('SELECT balance FROM users WHERE uid = $1 FOR UPDATE', [deposit.uid]);
      if (!ur.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'المستخدم غير موجود' }); }
      const newBal = Number(ur.rows[0].balance) + Number(deposit.amount_syp);
      await client.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBal, deposit.uid]);
      await client.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'deposit',$2,$3,$4,'admin',$5)`, [deposit.uid, deposit.amount_syp, newBal, 'إيداع ' + deposit.method_code, Date.now()]);
    }
    await client.query('UPDATE deposit_requests SET status = $1, admin_note = $2, processed_at = $3, processed_by = $4 WHERE id = $5', [action === 'approve' ? 'approved' : 'rejected', admin_note || '', Date.now(), 'admin', id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'خطأ' }); }
  finally { client.release(); }
});

app.get('/api/admin/withdraws', authAdmin, async (req, res) => {
  const { status = 'pending' } = req.query;
  const r = await pool.query(`SELECT w.*, u.first_name, u.last_name, u.phone, u.balance AS user_balance FROM withdraw_requests w LEFT JOIN users u ON u.uid = w.uid WHERE w.status = $1 ORDER BY w.id DESC LIMIT 200`, [status]);
  res.json({ withdraws: r.rows });
});

app.post('/api/admin/withdraws/process', authAdmin, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { id, action, admin_note } = req.body;
    const wr = await client.query('SELECT * FROM withdraw_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!wr.rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'غير موجود' }); }
    const withdraw = wr.rows[0];
    if (withdraw.status !== 'pending') { await client.query('ROLLBACK'); return res.status(400).json({ error: 'تمت معالجته' }); }
    if (action === 'reject') {
      const ur = await client.query('SELECT balance FROM users WHERE uid = $1 FOR UPDATE', [withdraw.uid]);
      if (ur.rows.length) {
        const newBal = Number(ur.rows[0].balance) + Number(withdraw.amount_syp);
        await client.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBal, withdraw.uid]);
        await client.query(`INSERT INTO transactions (uid,type,amount,balance_after,note,admin,created_at) VALUES ($1,'withdraw_refund',$2,$3,$4,'admin',$5)`, [withdraw.uid, withdraw.amount_syp, newBal, 'إعادة رصيد سحب مرفوض', Date.now()]);
      }
    }
    await client.query('UPDATE withdraw_requests SET status = $1, admin_note = $2, processed_at = $3, processed_by = $4 WHERE id = $5', [action === 'approve' ? 'approved' : 'rejected', admin_note || '', Date.now(), 'admin', id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) { await client.query('ROLLBACK'); console.error(e); res.status(500).json({ error: 'خطأ' }); }
  finally { client.release(); }
});

app.get('/api/admin/recent-spins', authAdmin, async (req, res) => {
  const r = await pool.query(`SELECT s.*, u.first_name, u.last_name FROM spins s LEFT JOIN users u ON u.uid = s.uid ORDER BY s.id DESC LIMIT 100`);
  res.json({ spins: r.rows });
});

app.get('/api/admin/recent-aviator', authAdmin, async (req, res) => {
  const r = await pool.query(`SELECT a.*, u.first_name, u.last_name FROM aviator_bets a LEFT JOIN users u ON u.uid = a.uid ORDER BY a.id DESC LIMIT 100`);
  res.json({ bets: r.rows });
});

app.get('/api/admin/recent-mines', authAdmin, async (req, res) => {
  const r = await pool.query(`SELECT m.*, u.first_name, u.last_name FROM mines_games m LEFT JOIN users u ON u.uid = m.uid ORDER BY m.id DESC LIMIT 100`);
  res.json({ games: r.rows });
});

app.get('/api/admin/recent-logins', authAdmin, async (req, res) => {
  const r = await pool.query(`SELECT l.*, u.first_name, u.last_name FROM login_log l LEFT JOIN users u ON u.uid = l.uid ORDER BY l.id DESC LIMIT 100`);
  res.json({ logins: r.rows });
});

app.get('/api/admin/agents', authAdmin, async (req, res) => {
  const r = await pool.query(`SELECT u.uid, u.first_name, u.last_name, u.phone, u.agent_level, u.total_commission, u.balance, u.created_at, (SELECT COUNT(*)::int FROM users x WHERE x.referred_by = u.uid) AS referrals FROM users u WHERE u.agent_level > 0 ORDER BY u.total_commission DESC LIMIT 200`);
  res.json({ agents: r.rows });
});

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

// ============ START ============
(async () => {
  try {
    console.log('🚀 بدء التشغيل...');
    await initDB();
    aviatorNewRound();
    app.listen(PORT, () => {
      console.log('⚡ STORMGATE v2.0');
      console.log('Port:', PORT);
      console.log('RTP Slot:', (RTP * 100).toFixed(2) + '%');
      console.log('RTP Aviator:', (AVIATOR_RTP * 100).toFixed(2) + '%');
      console.log('RTP Mines:', (MINES_RTP * 100).toFixed(2) + '%');
      console.log('RTP Chicken:', (CHICKEN_RTP * 100).toFixed(2) + '%');
      console.log('RTP Plinko:', (PLINKO_RTP * 100).toFixed(2) + '%');
      console.log('RTP Dice:', (DICE_RTP * 100).toFixed(2) + '%');
      console.log('RTP Tower:', (TOWER_RTP * 100).toFixed(2) + '%');
      console.log('Daily:', DAILY_REWARDS.join('/'));
      console.log('Jackpot tiers:', JP_TIERS.join('/'));
    });
  } catch (e) { console.error('❌ فشل:', e); setTimeout(() => process.exit(1), 3000); }
})();

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });

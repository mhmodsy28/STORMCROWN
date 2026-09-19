/* ============================================================
   STORMCROWN — server.js
   - PostgreSQL دائم
   - منطق اللفة في السيرفر
   - RTP ثابت 94%
   - دعم الجولات المجانية
   - معالجة أخطاء شاملة
   ============================================================ */

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();

/* ===== التقاط أي خطأ غير معالج ===== */
process.on('uncaughtException', (e) => {
  console.error('💥 UNCAUGHT EXCEPTION:');
  console.error(e && e.stack ? e.stack : e);
});
process.on('unhandledRejection', (e) => {
  console.error('💥 UNHANDLED REJECTION:');
  console.error(e && e.stack ? e.stack : e);
});

const PORT = process.env.PORT || 3000;

/* ===== متغيرات البيئة ===== */
console.log('🔍 فحص المتغيرات...');
console.log('   PORT:', PORT);
console.log('   NODE_ENV:', process.env.NODE_ENV || '(غير مضبوط)');
console.log('   DATABASE_URL:', process.env.DATABASE_URL ? '✅ موجود' : '❌ مفقود');
console.log('   JWT_SECRET:', process.env.JWT_SECRET ? '✅ موجود' : '❌ مفقود');
console.log('   ADMIN_PASSWORD:', process.env.ADMIN_PASSWORD ? '✅ موجود' : '⚠️ يستخدم الافتراضي');
console.log('   ADMIN_TOKEN:', process.env.ADMIN_TOKEN ? '✅ موجود' : '⚠️ يُولَّد عشوائيًا');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ JWT_SECRET غير مضبوط — أضفه في Environment');
  setTimeout(() => process.exit(1), 2000);
}

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error('❌ DATABASE_URL غير مضبوط — أضفه في Environment');
  setTimeout(() => process.exit(1), 2000);
}

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me-now';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || crypto.randomBytes(24).toString('hex');

const USDT_TO_SYP = 15000;
const USD_TO_SYP  = 15000;

/* ===== RTP ===== */
const RTP = Math.min(0.97, Math.max(0.85, parseFloat(process.env.RTP || '0.94')));
const MAX_WIN_MULT = 5000;

const COMPANY_WALLETS = {
  sham_syp:   '066f10afcd1b2d1a8f66dbe1a1eb3f17',
  sham_usd:   '066f10afcd1b2d1a8f66dbe1a1eb3f17',
  usdt_bep20: '0x3932890a5d1acb3ab036bd39ade26c47929b37e5',
  usdt_trc20: 'TXYZ1234567890abcdef1234567890abcdef'
};

const PAYMENT_METHODS = [
  { code: 'sham_syp',   name: 'شام كاش - ليرة سورية', currency: 'SYP',  min: 200, max: 5000000, rate: 1 },
  { code: 'sham_usd',   name: 'شام كاش - دولار',       currency: 'USD',  min: 5,   max: 5000,    rate: USD_TO_SYP },
  { code: 'usdt_bep20', name: 'USDT (BEP20)',          currency: 'USDT', min: 5,   max: 5000,    rate: USDT_TO_SYP },
  { code: 'usdt_trc20', name: 'USDT (TRC20)',          currency: 'USDT', min: 5,   max: 5000,    rate: USDT_TO_SYP }
];

/* ===== قاعدة البيانات ===== */
console.log('📦 تهيئة pool قاعدة البيانات...');
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
  max: 10,
  connectionTimeoutMillis: 10000
});

pool.on('error', (e) => {
  console.error('💥 خطأ غير متوقع في pool:', e);
});

async function initDB() {
  console.log('🛠️ إنشاء الجداول...');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      uid VARCHAR(20) UNIQUE NOT NULL,
      first_name VARCHAR(100),
      last_name VARCHAR(100),
      phone VARCHAR(50) UNIQUE,
      email VARCHAR(200) UNIQUE,
      password_hash VARCHAR(200),
      balance BIGINT DEFAULT 0,
      laps INT DEFAULT 0,
      best_win BIGINT DEFAULT 0,
      wagered BIGINT DEFAULT 0,
      won BIGINT DEFAULT 0,
      banned INT DEFAULT 0,
      referred_by VARCHAR(20),
      agent_level INT DEFAULT 0,
      invite_code VARCHAR(20) UNIQUE,
      total_commission BIGINT DEFAULT 0,
      notes TEXT DEFAULT '',
      created_at BIGINT,
      last_login BIGINT,
      last_ip VARCHAR(50)
    );
    CREATE TABLE IF NOT EXISTS spins (
      id SERIAL PRIMARY KEY,
      uid VARCHAR(20),
      bet BIGINT,
      won BIGINT,
      net BIGINT,
      created_at BIGINT,
      ip VARCHAR(50)
    );
    CREATE TABLE IF NOT EXISTS login_log (
      id SERIAL PRIMARY KEY,
      uid VARCHAR(20),
      phone VARCHAR(100),
      success INT,
      ip VARCHAR(50),
      user_agent TEXT,
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS transactions (
      id SERIAL PRIMARY KEY,
      uid VARCHAR(20),
      type VARCHAR(50),
      amount BIGINT,
      balance_after BIGINT,
      note TEXT,
      admin VARCHAR(50),
      created_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS user_wallets (
      uid VARCHAR(20) PRIMARY KEY,
      sham_syp VARCHAR(200) DEFAULT '',
      sham_usd VARCHAR(200) DEFAULT '',
      usdt_bep20 VARCHAR(200) DEFAULT '',
      usdt_trc20 VARCHAR(200) DEFAULT '',
      updated_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS deposit_requests (
      id SERIAL PRIMARY KEY,
      uid VARCHAR(20),
      method_code VARCHAR(50),
      amount NUMERIC,
      amount_syp BIGINT,
      tx_hash VARCHAR(200),
      status VARCHAR(20) DEFAULT 'pending',
      admin_note TEXT DEFAULT '',
      created_at BIGINT,
      processed_at BIGINT,
      processed_by VARCHAR(50)
    );
    CREATE TABLE IF NOT EXISTS withdraw_requests (
      id SERIAL PRIMARY KEY,
      uid VARCHAR(20),
      method_code VARCHAR(50),
      amount NUMERIC,
      amount_syp BIGINT,
      wallet_to VARCHAR(300),
      status VARCHAR(20) DEFAULT 'pending',
      admin_note TEXT DEFAULT '',
      created_at BIGINT,
      processed_at BIGINT,
      processed_by VARCHAR(50)
    );
    CREATE TABLE IF NOT EXISTS commissions (
      id SERIAL PRIMARY KEY,
      agent_uid VARCHAR(20),
      source_uid VARCHAR(20),
      amount BIGINT,
      type VARCHAR(50),
      note TEXT,
      created_at BIGINT
    );
    CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);
    CREATE INDEX IF NOT EXISTS idx_users_phone ON users(phone);
    CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
    CREATE INDEX IF NOT EXISTS idx_spins_uid ON spins(uid);
    CREATE INDEX IF NOT EXISTS idx_deposits_status ON deposit_requests(status);
    CREATE INDEX IF NOT EXISTS idx_withdraws_status ON withdraw_requests(status);
    CREATE INDEX IF NOT EXISTS idx_commissions_agent ON commissions(agent_uid);
  `);
  console.log('✅ قاعدة البيانات جاهزة');
}

/* ===== منطق اللعبة ===== */
const COLS = 6, ROWS = 5;

const SYM = {
  zeusFist:  { pay: 5.0  },
  crown:     { pay: 2.0  },
  chalice:   { pay: 1.5  },
  hourglass: { pay: 1.0  },
  ring:      { pay: 0.5  },
  flaming:   { pay: 0.30 },
  gem_red:   { pay: 0.25 },
  gem_blue:  { pay: 0.20 },
  gem_green: { pay: 0.15 },
  gem_purple:{ pay: 0.10 }
};

const ZEUS_MAIN = [2, 3, 5, 10, 15, 25, 50, 100, 250, 500];

function rint(max) { return crypto.randomInt(0, max); }
function rnd(a)   { return a[rint(a.length)]; }

function rSym(zeusPool) {
  const r = rint(100);
  if (r < 15) return { type: 'zeus', v: rnd(zeusPool) };
  if (r < 20) return { type: 'scatter' };
  if (r < 30) return { type: 'gem_purple' };
  if (r < 40) return { type: 'gem_green' };
  if (r < 49) return { type: 'gem_blue' };
  if (r < 58) return { type: 'gem_red' };
  if (r < 66) return { type: 'flaming' };
  if (r < 73) return { type: 'ring' };
  if (r < 79) return { type: 'hourglass' };
  if (r < 84) return { type: 'chalice' };
  if (r < 88) return { type: 'crown' };
  if (r < 90) return { type: 'zeusFist' };
  return { type: 'gem_purple' };
}

function genGrid(zeusPool) {
  const g = [];
  for (let x = 0; x < COLS; x++) {
    g[x] = [];
    for (let y = 0; y < ROWS; y++) g[x][y] = rSym(zeusPool);
  }
  return g;
}

function chkWins(g, bet) {
  const c = {};
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
    const s = g[x][y];
    if (!s || s.type === 'zeus' || s.type === 'scatter') continue;
    c[s.type] = (c[s.type] || 0) + 1;
  }
  const wins = [];
  for (const [sym, n] of Object.entries(c)) {
    if (n < 6) continue;
    const base = SYM[sym].pay * bet;
    let posMult = 1;
    if (n === 7)       posMult = 1.8;
    else if (n === 8)  posMult = 3.0;
    else if (n === 9)  posMult = 5.0;
    else if (n === 10) posMult = 8.0;
    else if (n === 11) posMult = 12.0;
    else if (n >= 12)  posMult = 20.0;
    wins.push({ symbol: sym, count: n, amount: Math.floor(base * posMult) });
  }
  return wins;
}

function zeusSum(g) {
  let s = 0;
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++)
    if (g[x][y] && g[x][y].type === 'zeus') s += g[x][y].v;
  return s;
}

function cntSc(g) {
  let n = 0;
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++)
    if (g[x][y] && g[x][y].type === 'scatter') n++;
  return n;
}

function runSpin(bet, zeusPool, freeSpinsActive, cumulativeMult) {
  const MAX_CHAINS = 30;
  const chains = [];
  let grid = genGrid(zeusPool);
  let totalWin = 0;
  let cumMult = cumulativeMult || 0;

  for (let chain = 0; chain < MAX_CHAINS; chain++) {
    const wins = chkWins(grid, bet);
    const zs = zeusSum(grid);
    if (wins.length === 0) break;

    let chainWin = wins.reduce((a, w) => a + w.amount, 0);
    let appliedMult = zs;
    if (freeSpinsActive) { cumMult += zs; appliedMult = cumMult; }
    if (appliedMult > 0) chainWin *= appliedMult;

    chains.push({
      grid: JSON.parse(JSON.stringify(grid)),
      wins: wins,
      zeusSum: zs,
      multiplier: appliedMult,
      cumulativeMult: cumMult,
      winAmount: chainWin
    });
    totalWin += chainWin;

    const winningSymbols = [...new Set(wins.map(w => w.symbol))];
    for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) {
      if (grid[x][y] && winningSymbols.includes(grid[x][y].type)) grid[x][y] = null;
    }
    for (let x = 0; x < COLS; x++) {
      const kept = [];
      for (let y = ROWS - 1; y >= 0; y--) if (grid[x][y]) kept.push(grid[x][y]);
      while (kept.length < ROWS) kept.push(rSym(zeusPool));
      grid[x] = kept.reverse();
    }
  }

  return { chains, totalWin, finalGrid: grid, cumulativeMult: cumMult };
}

/* ===== Helpers ===== */
function genUID() {
  let uid = '';
  for (let i = 0; i < 15; i++) uid += rint(10);
  while (uid[0] === '0') uid = uid.slice(1) + rint(10);
  return uid;
}
function genInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SC';
  for (let i = 0; i < 8; i++) code += chars[rint(chars.length)];
  return code;
}
function getClientIP(req) {
  return (req.headers['x-forwarded-for']?.split(',')[0] ||
          req.socket.remoteAddress || '').replace('::ffff:', '');
}

/* ===== Middleware ===== */
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

/* ===== المصادقة ===== */
app.post('/api/register', rateLimit(10, 60000), async (req, res) => {
  try {
    const { first, last, phone, email, password, inviteCode } = req.body;
    const ip = getClientIP(req);
    if (!first || first.length < 2) return res.status(400).json({ error: 'الاسم مطلوب' });
    if (!last  || last.length  < 2) return res.status(400).json({ error: 'الكنية مطلوبة' });
    if (!phone || phone.length < 8) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
    if (!email || !email.includes('@')) return res.status(400).json({ error: 'البريد غير صحيح' });
    if (!password || password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });

    const exists = await pool.query(
      'SELECT uid FROM users WHERE phone = $1 OR email = $2 LIMIT 1',
      [phone, email]
    );
    if (exists.rows.length) return res.status(409).json({ error: 'الرقم أو البريد مسجل مسبقاً' });

    let referrerUid = null;
    if (inviteCode) {
      const r = await pool.query('SELECT uid FROM users WHERE invite_code = $1', [inviteCode.toUpperCase()]);
      if (r.rows.length) referrerUid = r.rows[0].uid;
    }

    let uid;
    for (let i = 0; i < 20; i++) {
      uid = genUID();
      const c = await pool.query('SELECT 1 FROM users WHERE uid = $1', [uid]);
      if (!c.rows.length) break;
    }
    let code;
    for (let i = 0; i < 20; i++) {
      code = genInviteCode();
      const c = await pool.query('SELECT 1 FROM users WHERE invite_code = $1', [code]);
      if (!c.rows.length) break;
    }

    const hash = bcrypt.hashSync(password, 10);
    const now = Date.now();

    await pool.query(`
      INSERT INTO users (uid, first_name, last_name, phone, email, password_hash,
                         balance, laps, best_win, wagered, won, banned,
                         referred_by, agent_level, invite_code, total_commission,
                         created_at, last_login, last_ip)
      VALUES ($1,$2,$3,$4,$5,$6,0,0,0,0,0,0,$7,0,$8,0,$9,$9,$10)
    `, [uid, first, last, phone, email, hash, referrerUid, code, now, ip]);

    await pool.query(`
      INSERT INTO login_log (uid, phone, success, ip, user_agent, created_at)
      VALUES ($1,$2,1,$3,$4,$5)
    `, [uid, phone, ip, req.headers['user-agent'] || '', now]);

    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true, token,
      user: { uid, first, last, phone, email, balance: 0, laps: 0, best: 0,
              wagered: 0, won: 0, invite_code: code, agent_level: 0, total_commission: 0 }
    });
  } catch (e) { console.error('register error:', e); res.status(500).json({ error: 'خطأ في السيرفر' }); }
});

app.post('/api/login', rateLimit(10, 60000), async (req, res) => {
  try {
    const { id, password } = req.body;
    const ip = getClientIP(req);
    if (!id || !password) return res.status(400).json({ error: 'أدخل البيانات' });

    const r = await pool.query(
      'SELECT * FROM users WHERE phone = $1 OR email = $1 OR uid = $1 LIMIT 1',
      [id]
    );
    const user = r.rows[0];

    if (!user) {
      await pool.query(`
        INSERT INTO login_log (uid, phone, success, ip, user_agent, created_at)
        VALUES (NULL,$1,0,$2,$3,$4)
      `, [id, ip, req.headers['user-agent'] || '', Date.now()]);
      return res.status(401).json({ error: 'الحساب غير موجود' });
    }
    if (!bcrypt.compareSync(password, user.password_hash)) {
      await pool.query(`
        INSERT INTO login_log (uid, phone, success, ip, user_agent, created_at)
        VALUES ($1,$2,0,$3,$4,$5)
      `, [user.uid, id, ip, req.headers['user-agent'] || '', Date.now()]);
      return res.status(401).json({ error: 'كلمة المرور خاطئة' });
    }
    if (user.banned) return res.status(403).json({ error: 'الحساب محظور' });

    await pool.query(
      'UPDATE users SET last_login = $1, last_ip = $2 WHERE uid = $3',
      [Date.now(), ip, user.uid]
    );
    await pool.query(`
      INSERT INTO login_log (uid, phone, success, ip, user_agent, created_at)
      VALUES ($1,$2,1,$3,$4,$5)
    `, [user.uid, id, ip, req.headers['user-agent'] || '', Date.now()]);

    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true, token,
      user: {
        uid: user.uid, first: user.first_name, last: user.last_name,
        phone: user.phone, email: user.email, balance: Number(user.balance),
        laps: user.laps, best: Number(user.best_win), wagered: Number(user.wagered),
        won: Number(user.won), invite_code: user.invite_code,
        agent_level: user.agent_level, total_commission: Number(user.total_commission)
      }
    });
  } catch (e) { console.error('login error:', e); res.status(500).json({ error: 'خطأ في السيرفر' }); }
});

app.get('/api/me', authUser, async (req, res) => {
  try {
    const u = req.user;
    const w = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [u.uid]);
    const wallet = w.rows[0] || {};
    res.json({
      uid: u.uid, first: u.first_name, last: u.last_name,
      phone: u.phone, email: u.email,
      balance: Number(u.balance), laps: u.laps, best: Number(u.best_win),
      wagered: Number(u.wagered), won: Number(u.won),
      invite_code: u.invite_code, agent_level: u.agent_level,
      total_commission: Number(u.total_commission),
      created: Number(u.created_at), lastLogin: Number(u.last_login),
      wallets: {
        sham_syp: wallet.sham_syp || '', sham_usd: wallet.sham_usd || '',
        usdt_bep20: wallet.usdt_bep20 || '', usdt_trc20: wallet.usdt_trc20 || ''
      }
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

/* ===== Spin ===== */
app.post('/api/spin', authUser, rateLimit(180, 60000), async (req, res) => {
  const u = req.user;
  const ip = getClientIP(req);
  try {
    const { bet, freeSpin } = req.body;
    if (typeof bet !== 'number' || bet <= 0 || bet > 1000000)
      return res.status(400).json({ error: 'رهان غير صحيح' });
    if (!freeSpin && u.balance < bet)
      return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const result = runSpin(bet, ZEUS_MAIN, !!freeSpin, 0);
    let totalWin = result.totalWin;
    const maxWin = bet * MAX_WIN_MULT;
    if (totalWin > maxWin) totalWin = maxWin;

    const net = totalWin - (freeSpin ? 0 : bet);
    const newBalance = Number(u.balance) + net;
    if (newBalance < 0) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    await pool.query(`
      UPDATE users
         SET balance = $1, laps = laps + 1, wagered = wagered + $2,
             won = won + $3, best_win = GREATEST(best_win, $4)
       WHERE uid = $5
    `, [newBalance, freeSpin ? 0 : bet, totalWin, totalWin, u.uid]);

    await pool.query(`
      INSERT INTO spins (uid, bet, won, net, created_at, ip)
      VALUES ($1,$2,$3,$4,$5,$6)
    `, [u.uid, freeSpin ? 0 : bet, totalWin, net, Date.now(), ip]);

    if (net < 0 && u.referred_by) {
      const refR = await pool.query('SELECT * FROM users WHERE uid = $1', [u.referred_by]);
      const ref = refR.rows[0];
      if (ref && ref.agent_level > 0) {
        const rate = ref.agent_level === 1 ? 0.03 : ref.agent_level === 2 ? 0.05 : 0.08;
        const commission = Math.floor(Math.abs(net) * rate);
        if (commission > 0) {
          await pool.query(
            'UPDATE users SET balance = balance + $1, total_commission = total_commission + $1 WHERE uid = $2',
            [commission, ref.uid]
          );
          await pool.query(`
            INSERT INTO commissions (agent_uid, source_uid, amount, type, note, created_at)
            VALUES ($1,$2,$3,'loss_commission',$4,$5)
          `, [ref.uid, u.uid, commission, 'عمولة من خسارة ' + Math.abs(net), Date.now()]);
        }
      }
    }

    const scatterCount = cntSc(result.finalGrid);

    res.json({
      success: true, balance: newBalance,
      bet: freeSpin ? 0 : bet, totalWin, net,
      chains: result.chains, finalGrid: result.finalGrid,
      scatterCount, freeSpinsTriggered: scatterCount >= 4 && !freeSpin
    });
  } catch (e) {
    console.error('spin error:', e);
    res.status(500).json({ error: 'خطأ في السيرفر' });
  }
});

/* ===== Buy bonus ===== */
app.post('/api/buy-bonus', authUser, rateLimit(30, 60000), async (req, res) => {
  try {
    const { price, type } = req.body;
    const u = req.user;
    if (typeof price !== 'number' || price <= 0)
      return res.status(400).json({ error: 'سعر غير صحيح' });
    if (Number(u.balance) < price)
      return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const newBalance = Number(u.balance) - price;
    await pool.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBalance, u.uid]);
    await pool.query(`
      INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
      VALUES ($1,'bonus_buy',$2,$3,$4,NULL,$5)
    `, [u.uid, -price, newBalance, 'بونص ' + type, Date.now()]);

    res.json({ success: true, balance: newBalance });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

/* ===== Wallet ===== */
app.get('/api/wallet/methods', (req, res) => {
  res.json({ methods: PAYMENT_METHODS.map(m => ({ ...m, company_wallet: COMPANY_WALLETS[m.code] || '' })) });
});

app.get('/api/wallet/my-addresses', authUser, async (req, res) => {
  const w = await pool.query('SELECT * FROM user_wallets WHERE uid = $1', [req.user.uid]);
  const r = w.rows[0] || {};
  res.json({
    sham_syp: r.sham_syp || '', sham_usd: r.sham_usd || '',
    usdt_bep20: r.usdt_bep20 || '', usdt_trc20: r.usdt_trc20 || ''
  });
});

app.post('/api/wallet/save-address', authUser, async (req, res) => {
  const { sham_syp, sham_usd, usdt_bep20, usdt_trc20 } = req.body;
  await pool.query(`
    INSERT INTO user_wallets (uid, sham_syp, sham_usd, usdt_bep20, usdt_trc20, updated_at)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (uid) DO UPDATE SET
      sham_syp = EXCLUDED.sham_syp, sham_usd = EXCLUDED.sham_usd,
      usdt_bep20 = EXCLUDED.usdt_bep20, usdt_trc20 = EXCLUDED.usdt_trc20,
      updated_at = EXCLUDED.updated_at
  `, [req.user.uid, sham_syp || '', sham_usd || '', usdt_bep20 || '', usdt_trc20 || '', Date.now()]);
  res.json({ success: true });
});

app.post('/api/wallet/deposit', authUser, rateLimit(15, 60000), async (req, res) => {
  try {
    const { method_code, amount, tx_hash } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if (!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < method.min || amountNum > method.max)
      return res.status(400).json({ error: 'المبلغ بين ' + method.min + ' و ' + method.max });
    const amountSyp = Math.floor(amountNum * method.rate);
    const pending = await pool.query(
      "SELECT id FROM deposit_requests WHERE uid = $1 AND status = 'pending' LIMIT 1",
      [req.user.uid]
    );
    if (pending.rows.length) return res.status(400).json({ error: 'لديك طلب إيداع معلق' });
    await pool.query(`
      INSERT INTO deposit_requests (uid, method_code, amount, amount_syp, tx_hash, status, created_at)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
    `, [req.user.uid, method_code, amountNum, amountSyp, tx_hash || '', Date.now()]);
    res.json({ success: true, message: 'تم استلام الطلب، سيتم مراجعته قريباً', amount_syp: amountSyp });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/wallet/withdraw', authUser, rateLimit(5, 60000), async (req, res) => {
  try {
    const { method_code, amount, wallet_to } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if (!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    if (!wallet_to || wallet_to.length < 5) return res.status(400).json({ error: 'أدخل عنوان المحفظة' });
    const amountNum = parseFloat(amount);
    if (isNaN(amountNum) || amountNum < method.min || amountNum > method.max)
      return res.status(400).json({ error: 'المبلغ بين ' + method.min + ' و ' + method.max });
    const amountSyp = Math.floor(amountNum * method.rate);
    if (Number(req.user.balance) < amountSyp) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    const pending = await pool.query(
      "SELECT id FROM withdraw_requests WHERE uid = $1 AND status = 'pending' LIMIT 1",
      [req.user.uid]
    );
    if (pending.rows.length) return res.status(400).json({ error: 'لديك طلب سحب معلق' });
    const newBal = Number(req.user.balance) - amountSyp;
    await pool.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBal, req.user.uid]);
    await pool.query(`
      INSERT INTO withdraw_requests (uid, method_code, amount, amount_syp, wallet_to, status, created_at)
      VALUES ($1,$2,$3,$4,$5,'pending',$6)
    `, [req.user.uid, method_code, amountNum, amountSyp, wallet_to, Date.now()]);
    res.json({ success: true, message: 'تم استلام الطلب، سيعالج خلال 1-24 ساعة', amount_syp: amountSyp });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/wallet/history', authUser, async (req, res) => {
  const deposits = await pool.query(
    'SELECT * FROM deposit_requests WHERE uid = $1 ORDER BY id DESC LIMIT 30', [req.user.uid]);
  const withdraws = await pool.query(
    'SELECT * FROM withdraw_requests WHERE uid = $1 ORDER BY id DESC LIMIT 30', [req.user.uid]);
  res.json({ deposits: deposits.rows, withdraws: withdraws.rows });
});

/* ===== Agent ===== */
app.get('/api/agent/info', authUser, async (req, res) => {
  const u = req.user;
  const referrals = await pool.query(
    'SELECT uid, first_name, last_name, balance, laps, wagered, won, created_at, last_login FROM users WHERE referred_by = $1 ORDER BY created_at DESC',
    [u.uid]);
  const commissions = await pool.query(
    'SELECT * FROM commissions WHERE agent_uid = $1 ORDER BY id DESC LIMIT 100', [u.uid]);
  const refs = referrals.rows.map(r => ({
    uid: r.uid, first_name: r.first_name, last_name: r.last_name,
    balance: Number(r.balance), laps: r.laps, wagered: Number(r.wagered),
    won: Number(r.won), created_at: Number(r.created_at), last_login: Number(r.last_login)
  }));
  const totalRefWagered = refs.reduce((s, r) => s + r.wagered, 0);
  const totalRefWon = refs.reduce((s, r) => s + r.won, 0);
  const totalRefLost = Math.max(0, totalRefWagered - totalRefWon);
  res.json({
    invite_code: u.invite_code, agent_level: u.agent_level,
    total_commission: Number(u.total_commission),
    referrals_count: refs.length, referrals: refs,
    commissions: commissions.rows.map(c => ({ ...c, amount: Number(c.amount), created_at: Number(c.created_at) })),
    stats: { total_ref_wagered: totalRefWagered, total_ref_won: totalRefWon, total_ref_lost: totalRefLost }
  });
});

app.post('/api/agent/become', authUser, async (req, res) => {
  if (req.user.agent_level > 0) return res.status(400).json({ error: 'أنت وكيل بالفعل' });
  await pool.query('UPDATE users SET agent_level = 1 WHERE uid = $1', [req.user.uid]);
  res.json({ success: true, message: 'تم ترقيتك إلى وكيل المستوى 1' });
});

/* ===== RTP info ===== */
app.get('/api/rtp', (req, res) => {
  res.json({ rtp: RTP, houseEdge: 1 - RTP, maxWinMult: MAX_WIN_MULT });
});

/* ===== Admin ===== */
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
    const activeToday = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE last_login > $1', [Date.now() - 86400000]);
    const banned = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE banned = 1');
    const pendingDeposits = await pool.query("SELECT COUNT(*)::int AS c FROM deposit_requests WHERE status='pending'");
    const pendingWithdraws = await pool.query("SELECT COUNT(*)::int AS c FROM withdraw_requests WHERE status='pending'");
    const agents = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE agent_level > 0');
    const totalCommission = await pool.query('SELECT COALESCE(SUM(amount),0)::bigint AS s FROM commissions');
    const tw = Number(totalWagered.rows[0].s);
    const wn = Number(totalWon.rows[0].s);
    res.json({
      totalUsers: users.rows[0].c, totalBalance: Number(totalBalance.rows[0].s),
      totalWagered: tw, totalWon: wn, totalSpins: spins.rows[0].c,
      activeToday: activeToday.rows[0].c, banned: banned.rows[0].c,
      pendingDeposits: pendingDeposits.rows[0].c, pendingWithdraws: pendingWithdraws.rows[0].c,
      agents: agents.rows[0].c, totalCommission: Number(totalCommission.rows[0].s),
      houseProfit: tw - wn,
      rtp: tw > 0 ? (wn / tw * 100).toFixed(2) + '%' : '—'
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/users', authAdmin, async (req, res) => {
  try {
    const { search, sort, limit = 100, offset = 0 } = req.query;
    let whereSql = '';
    const params = [];
    if (search) {
      params.push('%' + search.toLowerCase() + '%');
      whereSql = `WHERE LOWER(uid) LIKE $1 OR LOWER(phone) LIKE $1 OR LOWER(email) LIKE $1
                       OR LOWER(first_name) LIKE $1 OR LOWER(last_name) LIKE $1 OR LOWER(invite_code) LIKE $1`;
    }
    const sortMap = {
      balance: 'balance DESC', balance_asc: 'balance ASC', laps: 'laps DESC',
      best: 'best_win DESC', recent: 'last_login DESC', created: 'created_at DESC',
      commission: 'total_commission DESC'
    };
    const orderBy = sortMap[sort] || sortMap.created;
    const total = await pool.query(`SELECT COUNT(*)::int AS c FROM users ${whereSql}`, params);
    params.push(parseInt(limit));
    params.push(parseInt(offset));
    const users = await pool.query(
      `SELECT * FROM users ${whereSql} ORDER BY ${orderBy} LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params);
    const mapped = users.rows.map(u => ({
      id: u.id, uid: u.uid, first_name: u.first_name, last_name: u.last_name,
      phone: u.phone, email: u.email, balance: Number(u.balance), laps: u.laps,
      best_win: Number(u.best_win), wagered: Number(u.wagered), won: Number(u.won),
      banned: u.banned, referred_by: u.referred_by, agent_level: u.agent_level,
      invite_code: u.invite_code, total_commission: Number(u.total_commission),
      notes: u.notes, created_at: Number(u.created_at), last_login: Number(u.last_login),
      last_ip: u.last_ip
    }));
    res.json({ users: mapped, total: total.rows[0].c });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/admin/user/:uid', authAdmin, async (req, res) => {
  try {
    const r = await pool.query('SELECT * FROM users WHERE uid = $1 OR phone = $1 LIMIT 1', [req.params.uid]);
    if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
    const user = r.rows[0];
    const spins = await pool.query('SELECT * FROM spins WHERE uid = $1 ORDER BY id DESC LIMIT 100', [user.uid]);
    const transactions = await pool.query('SELECT * FROM transactions WHERE uid = $1 ORDER BY id DESC LIMIT 100', [user.uid]);
    const logins = await pool.query('SELECT * FROM login_log WHERE uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    const deposits = await pool.query('SELECT * FROM deposit_requests WHERE uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    const withdraws = await pool.query('SELECT * FROM withdraw_requests WHERE uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    const referrals = await pool.query('SELECT uid, first_name, last_name, created_at FROM users WHERE referred_by = $1', [user.uid]);
    const commissions = await pool.query('SELECT * FROM commissions WHERE agent_uid = $1 ORDER BY id DESC LIMIT 50', [user.uid]);
    res.json({
      user, spins: spins.rows, transactions: transactions.rows,
      logins: logins.rows, deposits: deposits.rows, withdraws: withdraws.rows,
      referrals: referrals.rows, commissions: commissions.rows
    });
  } catch (e) { console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/admin/update-balance', authAdmin, async (req, res) => {
  const { uid, newBalance, note } = req.body;
  if (typeof newBalance !== 'number') return res.status(400).json({ error: 'قيمة غير صحيحة' });
  const r = await pool.query('SELECT balance FROM users WHERE uid = $1', [uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
  const diff = newBalance - Number(r.rows[0].balance);
  await pool.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBalance, uid]);
  await pool.query(`
    INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
    VALUES ($1,$2,$3,$4,$5,'admin',$6)
  `, [uid, diff >= 0 ? 'admin_credit' : 'admin_debit', diff, newBalance, note || '', Date.now()]);
  res.json({ success: true, newBalance });
});

app.post('/api/admin/adjust-balance', authAdmin, async (req, res) => {
  const { uid, amount, note } = req.body;
  if (typeof amount !== 'number') return res.status(400).json({ error: 'قيمة غير صحيحة' });
  const r = await pool.query('SELECT balance FROM users WHERE uid = $1', [uid]);
  if (!r.rows.length) return res.status(404).json({ error: 'غير موجود' });
  const newBal = Math.max(0, Number(r.rows[0].balance) + amount);
  await pool.query('UPDATE users SET balance = $1 WHERE uid = $2', [newBal, uid]);
  await pool.query(`
    INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
    VALUES ($1,$2,$3,$4,$5,'admin',$6)
  `, [uid, amount >= 0 ? 'admin_credit' : 'admin_debit', amount, newBal, note || '', Date.now()]);
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

app.get('/api/admin/deposits', authAdmin, async (req, res) => {
  const { status = 'pending' } = req.query;
  const r = await pool.query(`
    SELECT d.*, u.first_name, u.last_name, u.phone
      FROM deposit_requests d LEFT JOIN users u ON u.uid = d.uid
     WHERE d.status = $1 ORDER BY d.id DESC LIMIT 200
  `, [status]);
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
      await client.query(`
        INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
        VALUES ($1,'deposit',$2,$3,$4,'admin',$5)
      `, [deposit.uid, deposit.amount_syp, newBal,
          'إيداع ' + deposit.method_code + ' — ' + deposit.amount, Date.now()]);
    }
    await client.query(
      'UPDATE deposit_requests SET status = $1, admin_note = $2, processed_at = $3, processed_by = $4 WHERE id = $5',
      [action === 'approve' ? 'approved' : 'rejected', admin_note || '', Date.now(), 'admin', id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'خطأ' });
  } finally { client.release(); }
});

app.get('/api/admin/withdraws', authAdmin, async (req, res) => {
  const { status = 'pending' } = req.query;
  const r = await pool.query(`
    SELECT w.*, u.first_name, u.last_name, u.phone, u.balance AS user_balance
      FROM withdraw_requests w LEFT JOIN users u ON u.uid = w.uid
     WHERE w.status = $1 ORDER BY w.id DESC LIMIT 200
  `, [status]);
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
        await client.query(`
          INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
          VALUES ($1,'withdraw_refund',$2,$3,$4,'admin',$5)
        `, [withdraw.uid, withdraw.amount_syp, newBal, 'إعادة رصيد سحب مرفوض', Date.now()]);
      }
    }
    await client.query(
      'UPDATE withdraw_requests SET status = $1, admin_note = $2, processed_at = $3, processed_by = $4 WHERE id = $5',
      [action === 'approve' ? 'approved' : 'rejected', admin_note || '', Date.now(), 'admin', id]);
    await client.query('COMMIT');
    res.json({ success: true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error(e);
    res.status(500).json({ error: 'خطأ' });
  } finally { client.release(); }
});

app.get('/api/admin/recent-spins', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT s.*, u.first_name, u.last_name
      FROM spins s LEFT JOIN users u ON u.uid = s.uid
     ORDER BY s.id DESC LIMIT 100
  `);
  res.json({ spins: r.rows });
});

app.get('/api/admin/recent-logins', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT l.*, u.first_name, u.last_name
      FROM login_log l LEFT JOIN users u ON u.uid = l.uid
     ORDER BY l.id DESC LIMIT 100
  `);
  res.json({ logins: r.rows });
});

app.get('/api/admin/agents', authAdmin, async (req, res) => {
  const r = await pool.query(`
    SELECT u.uid, u.first_name, u.last_name, u.phone, u.agent_level,
           u.total_commission, u.balance, u.created_at,
           (SELECT COUNT(*)::int FROM users x WHERE x.referred_by = u.uid) AS referrals
      FROM users u WHERE u.agent_level > 0
      ORDER BY u.total_commission DESC LIMIT 200
  `);
  res.json({ agents: r.rows });
});

/* ===== Routes ===== */
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

/* ===== Startup ===== */
(async () => {
  try {
    console.log('🚀 بدء التشغيل...');
    await initDB();
    app.listen(PORT, () => {
      console.log('⚡ STORMCROWN SERVER');
      console.log('Port:', PORT);
      console.log('RTP:', (RTP * 100).toFixed(2) + '%');
      console.log('MaxWin:', MAX_WIN_MULT + 'x');
      console.log('Game:  http://localhost:' + PORT + '/');
      console.log('Admin: http://localhost:' + PORT + '/admin');
    });
  } catch (e) {
    console.error('❌ فشل تشغيل السيرفر:');
    console.error(e && e.stack ? e.stack : e);
    console.error('DATABASE_URL set?', !!process.env.DATABASE_URL);
    console.error('JWT_SECRET set?', !!process.env.JWT_SECRET);
    console.error('NODE_ENV =', process.env.NODE_ENV);
    setTimeout(() => process.exit(1), 3000);
  }
})();

process.on('SIGTERM', async () => { await pool.end(); process.exit(0); });
process.on('SIGINT', async () => { await pool.end(); process.exit(0); });

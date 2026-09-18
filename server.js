const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'SC_' + crypto.randomBytes(32).toString('hex');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'ADMIN_' + crypto.randomBytes(16).toString('hex');

const USDT_TO_SYP = 15000;
const USD_TO_SYP = 15000;

const COMPANY_WALLETS = {
  sham_syp: 'SYR-SHAMCASH-001',
  sham_usd: 'SYR-SHAMCASH-USD-001',
  usdt_bep20: '0x1234567890abcdef1234567890abcdef12345678',
  usdt_trc20: 'TXYZ1234567890abcdef1234567890abcdef'
};

const db = new Database(path.join(__dirname, 'stormcrown.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT UNIQUE NOT NULL,
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  phone TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  balance INTEGER DEFAULT 500000,
  laps INTEGER DEFAULT 0,
  best_win INTEGER DEFAULT 0,
  wagered INTEGER DEFAULT 0,
  won INTEGER DEFAULT 0,
  banned INTEGER DEFAULT 0,
  referred_by TEXT,
  agent_level INTEGER DEFAULT 0,
  invite_code TEXT UNIQUE,
  total_commission INTEGER DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_login INTEGER,
  last_ip TEXT,
  notes TEXT DEFAULT ''
);
CREATE TABLE IF NOT EXISTS spins (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  uid TEXT NOT NULL, bet INTEGER NOT NULL, won INTEGER NOT NULL,
  net INTEGER NOT NULL, created_at INTEGER NOT NULL, ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_spins_uid ON spins(uid);
CREATE TABLE IF NOT EXISTS login_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT, phone TEXT,
  success INTEGER, ip TEXT, user_agent TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL, type TEXT NOT NULL,
  amount INTEGER NOT NULL, balance_after INTEGER NOT NULL,
  note TEXT, admin TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS user_wallets (
  uid TEXT PRIMARY KEY, sham_syp TEXT, sham_usd TEXT,
  usdt_bep20 TEXT, usdt_trc20 TEXT, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS deposit_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL,
  method_code TEXT NOT NULL, amount INTEGER NOT NULL, amount_syp INTEGER,
  tx_hash TEXT, status TEXT DEFAULT 'pending', admin_note TEXT,
  created_at INTEGER NOT NULL, processed_at INTEGER, processed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_dep_uid ON deposit_requests(uid);
CREATE INDEX IF NOT EXISTS idx_dep_status ON deposit_requests(status);
CREATE TABLE IF NOT EXISTS withdraw_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT, uid TEXT NOT NULL,
  method_code TEXT NOT NULL, amount INTEGER NOT NULL, amount_syp INTEGER,
  wallet_to TEXT NOT NULL, status TEXT DEFAULT 'pending', admin_note TEXT,
  created_at INTEGER NOT NULL, processed_at INTEGER, processed_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_wd_uid ON withdraw_requests(uid);
CREATE INDEX IF NOT EXISTS idx_wd_status ON withdraw_requests(status);
CREATE TABLE IF NOT EXISTS commissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, agent_uid TEXT NOT NULL,
  source_uid TEXT NOT NULL, amount INTEGER NOT NULL, type TEXT,
  note TEXT, created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comm_agent ON commissions(agent_uid);
`);

const PAYMENT_METHODS = [
  { code: 'sham_syp',   name: 'شام كاش - ليرة سورية', currency: 'SYP',  min: 5000, max: 5000000, rate: 1 },
  { code: 'sham_usd',   name: 'شام كاش - دولار',       currency: 'USD',  min: 5,    max: 5000,    rate: USD_TO_SYP },
  { code: 'usdt_bep20', name: 'USDT (BEP20)',          currency: 'USDT', min: 5,    max: 5000,    rate: USDT_TO_SYP },
  { code: 'usdt_trc20', name: 'USDT (TRC20)',          currency: 'USDT', min: 5,    max: 5000,    rate: USDT_TO_SYP }
];

function genUID(){
  let uid = '';
  for(let i = 0; i < 15; i++) uid += Math.floor(Math.random() * 10);
  while(uid[0] === '0') uid = uid.slice(1) + Math.floor(Math.random() * 10);
  return uid;
}
function genInviteCode(){
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'SC';
  for(let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}
function getClientIP(req){
  return (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').replace('::ffff:', '');
}

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const rateLimits = new Map();
function rateLimit(maxReq, windowMs){
  return (req, res, next) => {
    const key = getClientIP(req) + ':' + req.path;
    const now = Date.now();
    const data = rateLimits.get(key) || { count: 0, reset: now + windowMs };
    if(now > data.reset){ data.count = 0; data.reset = now + windowMs; }
    data.count++;
    rateLimits.set(key, data);
    if(data.count > maxReq) return res.status(429).json({ error: 'كثير من الطلبات' });
    next();
  };
}
function authUser(req, res, next){
  const token = req.headers.authorization?.replace('Bearer ', '');
  if(!token) return res.status(401).json({ error: 'غير مصرح' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(payload.uid);
    if(!user) return res.status(401).json({ error: 'المستخدم غير موجود' });
    if(user.banned) return res.status(403).json({ error: 'الحساب محظور' });
    req.user = user;
    next();
  } catch(e){ return res.status(401).json({ error: 'جلسة منتهية' }); }
}
function authAdmin(req, res, next){
  const token = req.headers['x-admin-token'] || req.query.adminToken;
  if(token !== ADMIN_TOKEN) return res.status(401).json({ error: 'غير مصرح' });
  next();
}

app.post('/api/register', rateLimit(10, 60000), (req, res) => {
  try {
    const { first, last, phone, email, password, inviteCode } = req.body;
    const ip = getClientIP(req);
    if(!first || first.length < 2) return res.status(400).json({ error: 'الاسم مطلوب' });
    if(!last || last.length < 2) return res.status(400).json({ error: 'الكنية مطلوبة' });
    if(!phone || phone.length < 8) return res.status(400).json({ error: 'رقم الهاتف غير صحيح' });
    if(!email || !email.includes('@')) return res.status(400).json({ error: 'البريد غير صحيح' });
    if(!password || password.length < 4) return res.status(400).json({ error: 'كلمة المرور قصيرة' });

    const exists = db.prepare('SELECT uid FROM users WHERE phone = ? OR email = ?').get(phone, email);
    if(exists) return res.status(409).json({ error: 'مسجل مسبقاً' });

    let referrerUid = null;
    if(inviteCode){
      const ref = db.prepare('SELECT uid FROM users WHERE invite_code = ?').get(inviteCode.toUpperCase());
      if(ref) referrerUid = ref.uid;
    }

    let uid;
    do { uid = genUID(); } while(db.prepare('SELECT uid FROM users WHERE uid = ?').get(uid));
    let code;
    do { code = genInviteCode(); } while(db.prepare('SELECT uid FROM users WHERE invite_code = ?').get(code));

    const hash = bcrypt.hashSync(password, 10);

    db.prepare(`INSERT INTO users (uid, first_name, last_name, phone, email, password_hash,
      balance, invite_code, referred_by, created_at, last_login, last_ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(uid, first, last, phone, email, hash, 500000, code, referrerUid,
           Date.now(), Date.now(), ip);

    db.prepare(`INSERT INTO transactions (uid, type, amount, balance_after, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?)`).run(uid, 'initial', 500000, 500000, 'رصيد ترحيبي', Date.now());

    const token = jwt.sign({ uid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true, token,
      user: { uid, first, last, phone, email, balance: 500000, laps: 0, best: 0,
              wagered: 0, won: 0, invite_code: code, agent_level: 0, total_commission: 0 }
    });
  } catch(e){ console.error(e); res.status(500).json({ error: 'خطأ في السيرفر' }); }
});

app.post('/api/login', rateLimit(10, 60000), (req, res) => {
  try {
    const { id, password } = req.body;
    const ip = getClientIP(req);
    if(!id || !password) return res.status(400).json({ error: 'أدخل البيانات' });

    const user = db.prepare('SELECT * FROM users WHERE phone = ? OR email = ? OR uid = ?').get(id, id, id);
    if(!user) return res.status(401).json({ error: 'الحساب غير موجود' });
    if(!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error: 'كلمة المرور خاطئة' });
    if(user.banned) return res.status(403).json({ error: 'الحساب محظور' });

    db.prepare('UPDATE users SET last_login = ?, last_ip = ? WHERE uid = ?')
      .run(Date.now(), ip, user.uid);
    db.prepare('INSERT INTO login_log (uid, phone, success, ip, user_agent, created_at) VALUES (?, ?, 1, ?, ?, ?)')
      .run(user.uid, id, ip, req.headers['user-agent'] || '', Date.now());

    const token = jwt.sign({ uid: user.uid }, JWT_SECRET, { expiresIn: '30d' });
    res.json({
      success: true, token,
      user: { uid: user.uid, first: user.first_name, last: user.last_name,
        phone: user.phone, email: user.email, balance: user.balance, laps: user.laps,
        best: user.best_win, wagered: user.wagered, won: user.won,
        invite_code: user.invite_code, agent_level: user.agent_level,
        total_commission: user.total_commission }
    });
  } catch(e){ console.error(e); res.status(500).json({ error: 'خطأ في السيرفر' }); }
});

app.get('/api/me', authUser, (req, res) => {
  const u = req.user;
  const w = db.prepare('SELECT * FROM user_wallets WHERE uid = ?').get(u.uid) || {};
  res.json({
    uid: u.uid, first: u.first_name, last: u.last_name,
    phone: u.phone, email: u.email, balance: u.balance, laps: u.laps,
    best: u.best_win, wagered: u.wagered, won: u.won,
    invite_code: u.invite_code, agent_level: u.agent_level,
    total_commission: u.total_commission, created: u.created_at, lastLogin: u.last_login,
    wallets: {
      sham_syp: w.sham_syp || '', sham_usd: w.sham_usd || '',
      usdt_bep20: w.usdt_bep20 || '', usdt_trc20: w.usdt_trc20 || ''
    }
  });
});

app.post('/api/spin', authUser, rateLimit(180, 60000), (req, res) => {
  try {
    const { bet, won } = req.body;
    const u = req.user;
    const ip = getClientIP(req);
    if(typeof bet !== 'number' || bet <= 0) return res.status(400).json({ error: 'invalid bet' });
    if(typeof won !== 'number' || won < 0) return res.status(400).json({ error: 'invalid won' });
    if(u.balance < bet && won === 0) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const net = won - bet;
    const newBalance = u.balance + net;
    if(newBalance < 0) return res.status(400).json({ error: 'رصيد غير كافٍ' });

    const tx = db.transaction(() => {
      db.prepare(`UPDATE users SET balance = ?, laps = laps + 1,
        wagered = wagered + ?, won = won + ?, best_win = MAX(best_win, ?)
        WHERE uid = ?`).run(newBalance, bet, won, won, u.uid);
      db.prepare('INSERT INTO spins (uid, bet, won, net, created_at, ip) VALUES (?, ?, ?, ?, ?, ?)')
        .run(u.uid, bet, won, net, Date.now(), ip);

      if(net < 0 && u.referred_by){
        const ref = db.prepare('SELECT uid, agent_level FROM users WHERE uid = ?').get(u.referred_by);
        if(ref && ref.agent_level > 0){
          const rate = ref.agent_level === 1 ? 0.03 : ref.agent_level === 2 ? 0.05 : 0.08;
          const commission = Math.floor(Math.abs(net) * rate);
          if(commission > 0){
            db.prepare('UPDATE users SET balance = balance + ?, total_commission = total_commission + ? WHERE uid = ?')
              .run(commission, commission, ref.uid);
            db.prepare('INSERT INTO commissions (agent_uid, source_uid, amount, type, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
              .run(ref.uid, u.uid, commission, 'loss_commission', `عمولة من خسارة ${Math.abs(net)}`, Date.now());
          }
        }
      }
    });
    tx();
    res.json({ success: true, balance: newBalance, net });
  } catch(e){ console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/buy-bonus', authUser, rateLimit(30, 60000), (req, res) => {
  try {
    const { price, type } = req.body;
    const u = req.user;
    if(typeof price !== 'number' || price <= 0) return res.status(400).json({ error: 'invalid price' });
    if(u.balance < price) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    const newBalance = u.balance - price;
    db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(newBalance, u.uid);
    db.prepare('INSERT INTO transactions (uid, type, amount, balance_after, note, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u.uid, 'bonus_buy', -price, newBalance, `بونص ${type}`, Date.now());
    res.json({ success: true, balance: newBalance });
  } catch(e){ res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/wallet/methods', (req, res) => {
  res.json({ methods: PAYMENT_METHODS.map(m => ({ ...m, company_wallet: COMPANY_WALLETS[m.code] || '' })) });
});
app.get('/api/wallet/my-addresses', authUser, (req, res) => {
  const w = db.prepare('SELECT * FROM user_wallets WHERE uid = ?').get(req.user.uid) || {};
  res.json({ sham_syp: w.sham_syp || '', sham_usd: w.sham_usd || '',
    usdt_bep20: w.usdt_bep20 || '', usdt_trc20: w.usdt_trc20 || '' });
});
app.post('/api/wallet/save-address', authUser, (req, res) => {
  const { sham_syp, sham_usd, usdt_bep20, usdt_trc20 } = req.body;
  db.prepare(`INSERT INTO user_wallets (uid, sham_syp, sham_usd, usdt_bep20, usdt_trc20, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(uid) DO UPDATE SET
      sham_syp = excluded.sham_syp, sham_usd = excluded.sham_usd,
      usdt_bep20 = excluded.usdt_bep20, usdt_trc20 = excluded.usdt_trc20,
      updated_at = excluded.updated_at`)
    .run(req.user.uid, sham_syp || '', sham_usd || '', usdt_bep20 || '', usdt_trc20 || '', Date.now());
  res.json({ success: true });
});
app.post('/api/wallet/deposit', authUser, rateLimit(15, 60000), (req, res) => {
  try {
    const { method_code, amount, tx_hash } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if(!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    const amountNum = parseFloat(amount);
    if(isNaN(amountNum) || amountNum < method.min || amountNum > method.max)
      return res.status(400).json({ error: `المبلغ بين ${method.min} و ${method.max}` });
    const amountSyp = Math.floor(amountNum * method.rate);
    const pending = db.prepare(`SELECT id FROM deposit_requests WHERE uid = ? AND status = 'pending'`).get(req.user.uid);
    if(pending) return res.status(400).json({ error: 'لديك طلب إيداع معلق' });
    db.prepare(`INSERT INTO deposit_requests (uid, method_code, amount, amount_syp, tx_hash, status, created_at)
      VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
      .run(req.user.uid, method_code, amountNum, amountSyp, tx_hash || '', Date.now());
    res.json({ success: true, message: 'تم استلام الطلب، سيتم مراجعته قريباً', amount_syp: amountSyp });
  } catch(e){ res.status(500).json({ error: 'خطأ' }); }
});
app.post('/api/wallet/withdraw', authUser, rateLimit(5, 60000), (req, res) => {
  try {
    const { method_code, amount, wallet_to } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if(!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    if(!wallet_to || wallet_to.length < 5) return res.status(400).json({ error: 'أدخل عنوان المحفظة' });
    const amountNum = parseFloat(amount);
    if(isNaN(amountNum) || amountNum < method.min || amountNum > method.max)
      return res.status(400).json({ error: `المبلغ بين ${method.min} و ${method.max}` });
    const amountSyp = Math.floor(amountNum * method.rate);
    if(req.user.balance < amountSyp) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    const pending = db.prepare(`SELECT id FROM withdraw_requests WHERE uid = ? AND status = 'pending'`).get(req.user.uid);
    if(pending) return res.status(400).json({ error: 'لديك طلب سحب معلق' });
    const tx = db.transaction(() => {
      db.prepare('UPDATE users SET balance = balance - ? WHERE uid = ?').run(amountSyp, req.user.uid);
      db.prepare(`INSERT INTO withdraw_requests (uid, method_code, amount, amount_syp, wallet_to, status, created_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
        .run(req.user.uid, method_code, amountNum, amountSyp, wallet_to, Date.now());
    });
    tx();
    res.json({ success: true, message: 'تم استلام الطلب، سيعالج خلال 1-24 ساعة', amount_syp: amountSyp });
  } catch(e){ res.status(500).json({ error: 'خطأ' }); }
});
app.get('/api/wallet/history', authUser, (req, res) => {
  const deposits = db.prepare('SELECT * FROM deposit_requests WHERE uid = ? ORDER BY id DESC LIMIT 30').all(req.user.uid);
  const withdraws = db.prepare('SELECT * FROM withdraw_requests WHERE uid = ? ORDER BY id DESC LIMIT 30').all(req.user.uid);
  res.json({ deposits, withdraws });
});

app.get('/api/agent/info', authUser, (req, res) => {
  const u = req.user;
  const referrals = db.prepare(`SELECT uid, first_name, last_name, balance, laps, wagered, won, created_at, last_login
    FROM users WHERE referred_by = ? ORDER BY created_at DESC`).all(u.uid);
  const commissions = db.prepare('SELECT * FROM commissions WHERE agent_uid = ? ORDER BY id DESC LIMIT 100').all(u.uid);
  const totalRefWagered = referrals.reduce((s, r) => s + (r.wagered || 0), 0);
  const totalRefWon = referrals.reduce((s, r) => s + (r.won || 0), 0);
  const totalRefLost = Math.max(0, totalRefWagered - totalRefWon);
  res.json({
    invite_code: u.invite_code, agent_level: u.agent_level,
    total_commission: u.total_commission, referrals_count: referrals.length,
    referrals, commissions,
    stats: { total_ref_wagered: totalRefWagered, total_ref_won: totalRefWon, total_ref_lost: totalRefLost }
  });
});
app.post('/api/agent/become', authUser, (req, res) => {
  if(req.user.agent_level > 0) return res.status(400).json({ error: 'أنت وكيل بالفعل' });
  db.prepare('UPDATE users SET agent_level = 1 WHERE uid = ?').run(req.user.uid);
  res.json({ success: true, message: 'تم ترقيتك إلى وكيل المستوى 1' });
});

app.post('/api/admin/login', rateLimit(5, 60000), (req, res) => {
  const { password } = req.body;
  if(password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'كلمة مرور خاطئة' });
  res.json({ success: true, token: ADMIN_TOKEN });
});
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalBalance = db.prepare('SELECT SUM(balance) as s FROM users').get().s || 0;
  const totalWagered = db.prepare('SELECT SUM(wagered) as s FROM users').get().s || 0;
  const totalWon = db.prepare('SELECT SUM(won) as s FROM users').get().s || 0;
  const totalSpins = db.prepare('SELECT COUNT(*) as c FROM spins').get().c;
  const activeToday = db.prepare('SELECT COUNT(*) as c FROM users WHERE last_login > ?').get(Date.now() - 86400000).c;
  const banned = db.prepare('SELECT COUNT(*) as c FROM users WHERE banned = 1').get().c;
  const pendingDeposits = db.prepare(`SELECT COUNT(*) as c FROM deposit_requests WHERE status = 'pending'`).get().c;
  const pendingWithdraws = db.prepare(`SELECT COUNT(*) as c FROM withdraw_requests WHERE status = 'pending'`).get().c;
  const agents = db.prepare('SELECT COUNT(*) as c FROM users WHERE agent_level > 0').get().c;
  const totalCommission = db.prepare('SELECT SUM(amount) as s FROM commissions').get().s || 0;
  res.json({ totalUsers, totalBalance, totalWagered, totalWon, totalSpins, activeToday, banned,
    pendingDeposits, pendingWithdraws, agents, totalCommission,
    houseProfit: totalWagered - totalWon,
    rtp: totalWagered > 0 ? (totalWon / totalWagered * 100).toFixed(2) + '%' : '—' });
});
app.get('/api/admin/users', authAdmin, (req, res) => {
  const { search, sort, limit = 100, offset = 0 } = req.query;
  let query = 'SELECT * FROM users';
  const params = [];
  if(search){
    query += ' WHERE uid LIKE ? OR phone LIKE ? OR email LIKE ? OR first_name LIKE ? OR last_name LIKE ? OR invite_code LIKE ?';
    const s = `%${search}%`;
    params.push(s, s, s, s, s, s);
  }
  const sortMap = { balance: 'balance DESC', balance_asc: 'balance ASC', laps: 'laps DESC',
    best: 'best_win DESC', recent: 'last_login DESC', created: 'created_at DESC', commission: 'total_commission DESC' };
  query += ` ORDER BY ${sortMap[sort] || 'created_at DESC'} LIMIT ? OFFSET ?`;
  params.push(parseInt(limit), parseInt(offset));
  const users = db.prepare(query).all(...params);
  const total = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  res.json({ users, total });
});
app.get('/api/admin/user/:uid', authAdmin, (req, res) => {
  const user = db.prepare('SELECT * FROM users WHERE uid = ? OR phone = ?').get(req.params.uid, req.params.uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  const spins = db.prepare('SELECT * FROM spins WHERE uid = ? ORDER BY id DESC LIMIT 100').all(user.uid);
  const transactions = db.prepare('SELECT * FROM transactions WHERE uid = ? ORDER BY id DESC LIMIT 100').all(user.uid);
  const logins = db.prepare('SELECT * FROM login_log WHERE uid = ? ORDER BY id DESC LIMIT 50').all(user.uid);
  const deposits = db.prepare('SELECT * FROM deposit_requests WHERE uid = ? ORDER BY id DESC LIMIT 50').all(user.uid);
  const withdraws = db.prepare('SELECT * FROM withdraw_requests WHERE uid = ? ORDER BY id DESC LIMIT 50').all(user.uid);
  const referrals = db.prepare('SELECT uid, first_name, last_name, created_at FROM users WHERE referred_by = ? ORDER BY created_at DESC').all(user.uid);
  const commissions = db.prepare('SELECT * FROM commissions WHERE agent_uid = ? ORDER BY id DESC LIMIT 50').all(user.uid);
  res.json({ user, spins, transactions, logins, deposits, withdraws, referrals, commissions });
});
app.post('/api/admin/update-balance', authAdmin, (req, res) => {
  const { uid, newBalance, note } = req.body;
  if(typeof newBalance !== 'number') return res.status(400).json({ error: 'invalid balance' });
  const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  const diff = newBalance - user.balance;
  db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(newBalance, uid);
  db.prepare(`INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
    VALUES (?, ?, ?, ?, ?, 'admin', ?)`)
    .run(uid, diff >= 0 ? 'admin_credit' : 'admin_debit', diff, newBalance, note || '', Date.now());
  res.json({ success: true, newBalance });
});
app.post('/api/admin/adjust-balance', authAdmin, (req, res) => {
  const { uid, amount, note } = req.body;
  if(typeof amount !== 'number') return res.status(400).json({ error: 'invalid amount' });
  const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  const newBalance = Math.max(0, user.balance + amount);
  db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(newBalance, uid);
  db.prepare(`INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
    VALUES (?, ?, ?, ?, ?, 'admin', ?)`)
    .run(uid, amount >= 0 ? 'admin_credit' : 'admin_debit', amount, newBalance, note || '', Date.now());
  res.json({ success: true, newBalance });
});
app.post('/api/admin/toggle-ban', authAdmin, (req, res) => {
  const { uid } = req.body;
  const user = db.prepare('SELECT banned FROM users WHERE uid = ?').get(uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  const newBanned = user.banned ? 0 : 1;
  db.prepare('UPDATE users SET banned = ? WHERE uid = ?').run(newBanned, uid);
  res.json({ success: true, banned: newBanned });
});
app.post('/api/admin/set-note', authAdmin, (req, res) => {
  const { uid, note } = req.body;
  db.prepare('UPDATE users SET notes = ? WHERE uid = ?').run(note || '', uid);
  res.json({ success: true });
});
app.post('/api/admin/set-agent-level', authAdmin, (req, res) => {
  const { uid, level } = req.body;
  const lvl = Math.max(0, Math.min(3, parseInt(level) || 0));
  db.prepare('UPDATE users SET agent_level = ? WHERE uid = ?').run(lvl, uid);
  res.json({ success: true, level: lvl });
});
app.get('/api/admin/deposits', authAdmin, (req, res) => {
  const { status = 'pending' } = req.query;
  const deposits = db.prepare(`SELECT d.*, u.first_name, u.last_name, u.phone
    FROM deposit_requests d LEFT JOIN users u ON d.uid = u.uid
    WHERE d.status = ? ORDER BY d.id DESC LIMIT 200`).all(status);
  res.json({ deposits });
});
app.post('/api/admin/deposits/process', authAdmin, (req, res) => {
  try {
    const { id, action, admin_note } = req.body;
    const deposit = db.prepare('SELECT * FROM deposit_requests WHERE id = ?').get(id);
    if(!deposit) return res.status(404).json({ error: 'غير موجود' });
    if(deposit.status !== 'pending') return res.status(400).json({ error: 'تمت معالجته' });
    if(action === 'approve'){
      const user = db.prepare('SELECT balance FROM users WHERE uid = ?').get(deposit.uid);
      if(!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
      const newBalance = user.balance + deposit.amount_syp;
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(newBalance, deposit.uid);
        db.prepare(`INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
          VALUES (?, 'deposit', ?, ?, ?, 'admin', ?)`)
          .run(deposit.uid, deposit.amount_syp, newBalance,
               `إيداع ${deposit.method_code} — ${deposit.amount}`, Date.now());
      });
      tx();
    }
    db.prepare(`UPDATE deposit_requests SET status = ?, admin_note = ?, processed_at = ?, processed_by = 'admin' WHERE id = ?`)
      .run(action === 'approve' ? 'approved' : 'rejected', admin_note || '', Date.now(), id);
    res.json({ success: true });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdraws', authAdmin, (req, res) => {
  const { status = 'pending' } = req.query;
  const withdraws = db.prepare(`SELECT w.*, u.first_name, u.last_name, u.phone, u.balance as user_balance
    FROM withdraw_requests w LEFT JOIN users u ON w.uid = u.uid
    WHERE w.status = ? ORDER BY w.id DESC LIMIT 200`).all(status);
  res.json({ withdraws });
});
app.post('/api/admin/withdraws/process', authAdmin, (req, res) => {
  try {
    const { id, action, admin_note } = req.body;
    const withdraw = db.prepare('SELECT * FROM withdraw_requests WHERE id = ?').get(id);
    if(!withdraw) return res.status(404).json({ error: 'غير موجود' });
    if(withdraw.status !== 'pending') return res.status(400).json({ error: 'تمت معالجته' });
    if(action === 'reject'){
      const user = db.prepare('SELECT balance FROM users WHERE uid = ?').get(withdraw.uid);
      const newBalance = user.balance + withdraw.amount_syp;
      const tx = db.transaction(() => {
        db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(newBalance, withdraw.uid);
        db.prepare(`INSERT INTO transactions (uid, type, amount, balance_after, note, admin, created_at)
          VALUES (?, 'withdraw_refund', ?, ?, ?, 'admin', ?)`)
          .run(withdraw.uid, withdraw.amount_syp, newBalance, 'إعادة رصيد سحب مرفوض', Date.now());
      });
      tx();
    }
    db.prepare(`UPDATE withdraw_requests SET status = ?, admin_note = ?, processed_at = ?, processed_by = 'admin' WHERE id = ?`)
      .run(action === 'approve' ? 'approved' : 'rejected', admin_note || '', Date.now(), id);
    res.json({ success: true });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/recent-spins', authAdmin, (req, res) => {
  const spins = db.prepare(`SELECT s.*, u.first_name, u.last_name FROM spins s
    LEFT JOIN users u ON s.uid = u.uid ORDER BY s.id DESC LIMIT 100`).all();
  res.json({ spins });
});
app.get('/api/admin/recent-logins', authAdmin, (req, res) => {
  const logins = db.prepare(`SELECT l.*, u.first_name, u.last_name FROM login_log l
    LEFT JOIN users u ON l.uid = u.uid ORDER BY l.id DESC LIMIT 100`).all();
  res.json({ logins });
});
app.get('/api/admin/agents', authAdmin, (req, res) => {
  const agents = db.prepare(`SELECT u.uid, u.first_name, u.last_name, u.phone, u.agent_level,
    u.total_commission, u.balance, u.created_at,
    (SELECT COUNT(*) FROM users WHERE referred_by = u.uid) as referrals
    FROM users u WHERE u.agent_level > 0 ORDER BY u.total_commission DESC LIMIT 200`).all();
  res.json({ agents });
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.listen(PORT, () => {
  console.log('⚡ STORMCROWN SERVER');
  console.log('Port: ' + PORT);
  console.log('Game: http://localhost:' + PORT + '/');
  console.log('Admin: http://localhost:' + PORT + '/admin');
  console.log('Admin password: ' + ADMIN_PASSWORD);
  console.log('Admin token: ' + ADMIN_TOKEN);
});
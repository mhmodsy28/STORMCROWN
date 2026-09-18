const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
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

const DATA_FILE = path.join(__dirname, 'data.json');

let DB = {
  users: [],
  spins: [],
  login_log: [],
  transactions: [],
  user_wallets: [],
  deposit_requests: [],
  withdraw_requests: [],
  commissions: [],
  _seq: { users: 0, spins: 0, login_log: 0, transactions: 0,
          deposit_requests: 0, withdraw_requests: 0, commissions: 0 }
};

function loadDB(){
  try {
    if(fs.existsSync(DATA_FILE)){
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      DB = { ...DB, ...parsed };
      if(!DB._seq) DB._seq = { users: 0, spins: 0, login_log: 0, transactions: 0, deposit_requests: 0, withdraw_requests: 0, commissions: 0 };
    }
  } catch(e){ console.error('loadDB error:', e); }
}
function saveDB(){
  try { fs.writeFileSync(DATA_FILE, JSON.stringify(DB), 'utf8'); }
  catch(e){ console.error('saveDB error:', e); }
}
loadDB();
setInterval(saveDB, 3000);

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
    const user = DB.users.find(u => u.uid === payload.uid);
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

    if(DB.users.find(u => u.phone === phone)) return res.status(409).json({ error: 'رقم الهاتف مسجل مسبقاً' });
    if(DB.users.find(u => u.email === email)) return res.status(409).json({ error: 'البريد مسجل مسبقاً' });

    let referrerUid = null;
    if(inviteCode){
      const ref = DB.users.find(u => u.invite_code === inviteCode.toUpperCase());
      if(ref) referrerUid = ref.uid;
    }

    let uid;
    do { uid = genUID(); } while(DB.users.find(u => u.uid === uid));
    let code;
    do { code = genInviteCode(); } while(DB.users.find(u => u.invite_code === code));

    const hash = bcrypt.hashSync(password, 10);
    const user = {
      id: ++DB._seq.users,
      uid, first_name: first, last_name: last, phone, email,
      password_hash: hash,
      balance: 500000, laps: 0, best_win: 0, wagered: 0, won: 0,
      banned: 0, referred_by: referrerUid, agent_level: 0,
      invite_code: code, total_commission: 0,
      created_at: Date.now(), last_login: Date.now(), last_ip: ip, notes: ''
    };
    DB.users.push(user);
    DB.transactions.push({
      id: ++DB._seq.transactions, uid, type: 'initial',
      amount: 500000, balance_after: 500000,
      note: 'رصيد ترحيبي', admin: null, created_at: Date.now()
    });
    DB.login_log.push({
      id: ++DB._seq.login_log, uid, phone, success: 1, ip,
      user_agent: req.headers['user-agent'] || '', created_at: Date.now()
    });
    saveDB();

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

    const user = DB.users.find(u => u.phone === id || u.email === id || u.uid === id);
    if(!user){
      DB.login_log.push({ id: ++DB._seq.login_log, uid: null, phone: id, success: 0, ip,
        user_agent: req.headers['user-agent'] || '', created_at: Date.now() });
      saveDB();
      return res.status(401).json({ error: 'الحساب غير موجود' });
    }
    if(!bcrypt.compareSync(password, user.password_hash)){
      DB.login_log.push({ id: ++DB._seq.login_log, uid: user.uid, phone: id, success: 0, ip,
        user_agent: req.headers['user-agent'] || '', created_at: Date.now() });
      saveDB();
      return res.status(401).json({ error: 'كلمة المرور خاطئة' });
    }
    if(user.banned) return res.status(403).json({ error: 'الحساب محظور' });

    user.last_login = Date.now();
    user.last_ip = ip;
    DB.login_log.push({ id: ++DB._seq.login_log, uid: user.uid, phone: id, success: 1, ip,
      user_agent: req.headers['user-agent'] || '', created_at: Date.now() });
    saveDB();

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
  const w = DB.user_wallets.find(x => x.uid === u.uid) || {};
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

    u.balance = newBalance;
    u.laps += 1;
    u.wagered += bet;
    u.won += won;
    if(won > u.best_win) u.best_win = won;

    DB.spins.push({ id: ++DB._seq.spins, uid: u.uid, bet, won, net, created_at: Date.now(), ip });

    if(net < 0 && u.referred_by){
      const ref = DB.users.find(x => x.uid === u.referred_by);
      if(ref && ref.agent_level > 0){
        const rate = ref.agent_level === 1 ? 0.03 : ref.agent_level === 2 ? 0.05 : 0.08;
        const commission = Math.floor(Math.abs(net) * rate);
        if(commission > 0){
          ref.balance += commission;
          ref.total_commission += commission;
          DB.commissions.push({ id: ++DB._seq.commissions, agent_uid: ref.uid,
            source_uid: u.uid, amount: commission, type: 'loss_commission',
            note: 'عمولة من خسارة ' + Math.abs(net), created_at: Date.now() });
        }
      }
    }
    saveDB();
    res.json({ success: true, balance: newBalance, net });
  } catch(e){ console.error(e); res.status(500).json({ error: 'خطأ' }); }
});

app.post('/api/buy-bonus', authUser, rateLimit(30, 60000), (req, res) => {
  try {
    const { price, type } = req.body;
    const u = req.user;
    if(typeof price !== 'number' || price <= 0) return res.status(400).json({ error: 'invalid price' });
    if(u.balance < price) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    u.balance -= price;
    DB.transactions.push({ id: ++DB._seq.transactions, uid: u.uid, type: 'bonus_buy',
      amount: -price, balance_after: u.balance, note: 'بونص ' + type,
      admin: null, created_at: Date.now() });
    saveDB();
    res.json({ success: true, balance: u.balance });
  } catch(e){ res.status(500).json({ error: 'خطأ' }); }
});

app.get('/api/wallet/methods', (req, res) => {
  res.json({ methods: PAYMENT_METHODS.map(m => ({ ...m, company_wallet: COMPANY_WALLETS[m.code] || '' })) });
});
app.get('/api/wallet/my-addresses', authUser, (req, res) => {
  const w = DB.user_wallets.find(x => x.uid === req.user.uid) || {};
  res.json({ sham_syp: w.sham_syp || '', sham_usd: w.sham_usd || '',
    usdt_bep20: w.usdt_bep20 || '', usdt_trc20: w.usdt_trc20 || '' });
});
app.post('/api/wallet/save-address', authUser, (req, res) => {
  const { sham_syp, sham_usd, usdt_bep20, usdt_trc20 } = req.body;
  let w = DB.user_wallets.find(x => x.uid === req.user.uid);
  if(!w){ w = { uid: req.user.uid }; DB.user_wallets.push(w); }
  w.sham_syp = sham_syp || '';
  w.sham_usd = sham_usd || '';
  w.usdt_bep20 = usdt_bep20 || '';
  w.usdt_trc20 = usdt_trc20 || '';
  w.updated_at = Date.now();
  saveDB();
  res.json({ success: true });
});
app.post('/api/wallet/deposit', authUser, rateLimit(15, 60000), (req, res) => {
  try {
    const { method_code, amount, tx_hash } = req.body;
    const method = PAYMENT_METHODS.find(m => m.code === method_code);
    if(!method) return res.status(400).json({ error: 'وسيلة غير صحيحة' });
    const amountNum = parseFloat(amount);
    if(isNaN(amountNum) || amountNum < method.min || amountNum > method.max)
      return res.status(400).json({ error: 'المبلغ بين ' + method.min + ' و ' + method.max });
    const amountSyp = Math.floor(amountNum * method.rate);
    const pending = DB.deposit_requests.find(d => d.uid === req.user.uid && d.status === 'pending');
    if(pending) return res.status(400).json({ error: 'لديك طلب إيداع معلق' });
    DB.deposit_requests.push({ id: ++DB._seq.deposit_requests, uid: req.user.uid,
      method_code, amount: amountNum, amount_syp: amountSyp, tx_hash: tx_hash || '',
      status: 'pending', admin_note: '', created_at: Date.now(),
      processed_at: null, processed_by: null });
    saveDB();
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
      return res.status(400).json({ error: 'المبلغ بين ' + method.min + ' و ' + method.max });
    const amountSyp = Math.floor(amountNum * method.rate);
    if(req.user.balance < amountSyp) return res.status(400).json({ error: 'رصيد غير كافٍ' });
    const pending = DB.withdraw_requests.find(d => d.uid === req.user.uid && d.status === 'pending');
    if(pending) return res.status(400).json({ error: 'لديك طلب سحب معلق' });
    req.user.balance -= amountSyp;
    DB.withdraw_requests.push({ id: ++DB._seq.withdraw_requests, uid: req.user.uid,
      method_code, amount: amountNum, amount_syp: amountSyp, wallet_to,
      status: 'pending', admin_note: '', created_at: Date.now(),
      processed_at: null, processed_by: null });
    saveDB();
    res.json({ success: true, message: 'تم استلام الطلب، سيعالج خلال 1-24 ساعة', amount_syp: amountSyp });
  } catch(e){ res.status(500).json({ error: 'خطأ' }); }
});
app.get('/api/wallet/history', authUser, (req, res) => {
  const deposits = DB.deposit_requests.filter(d => d.uid === req.user.uid).slice(-30).reverse();
  const withdraws = DB.withdraw_requests.filter(d => d.uid === req.user.uid).slice(-30).reverse();
  res.json({ deposits, withdraws });
});

app.get('/api/agent/info', authUser, (req, res) => {
  const u = req.user;
  const referrals = DB.users.filter(x => x.referred_by === u.uid)
    .sort((a, b) => b.created_at - a.created_at)
    .map(x => ({ uid: x.uid, first_name: x.first_name, last_name: x.last_name,
      balance: x.balance, laps: x.laps, wagered: x.wagered, won: x.won,
      created_at: x.created_at, last_login: x.last_login }));
  const commissions = DB.commissions.filter(c => c.agent_uid === u.uid).slice(-100).reverse();
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
  req.user.agent_level = 1;
  saveDB();
  res.json({ success: true, message: 'تم ترقيتك إلى وكيل المستوى 1' });
});

app.post('/api/admin/login', rateLimit(5, 60000), (req, res) => {
  const { password } = req.body;
  if(password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'كلمة مرور خاطئة' });
  res.json({ success: true, token: ADMIN_TOKEN });
});
app.get('/api/admin/stats', authAdmin, (req, res) => {
  const totalUsers = DB.users.length;
  const totalBalance = DB.users.reduce((s, u) => s + (u.balance || 0), 0);
  const totalWagered = DB.users.reduce((s, u) => s + (u.wagered || 0), 0);
  const totalWon = DB.users.reduce((s, u) => s + (u.won || 0), 0);
  const totalSpins = DB.spins.length;
  const activeToday = DB.users.filter(u => u.last_login > Date.now() - 86400000).length;
  const banned = DB.users.filter(u => u.banned).length;
  const pendingDeposits = DB.deposit_requests.filter(d => d.status === 'pending').length;
  const pendingWithdraws = DB.withdraw_requests.filter(d => d.status === 'pending').length;
  const agents = DB.users.filter(u => u.agent_level > 0).length;
  const totalCommission = DB.commissions.reduce((s, c) => s + c.amount, 0);
  res.json({ totalUsers, totalBalance, totalWagered, totalWon, totalSpins, activeToday, banned,
    pendingDeposits, pendingWithdraws, agents, totalCommission,
    houseProfit: totalWagered - totalWon,
    rtp: totalWagered > 0 ? (totalWon / totalWagered * 100).toFixed(2) + '%' : '—' });
});
app.get('/api/admin/users', authAdmin, (req, res) => {
  const { search, sort, limit = 100, offset = 0 } = req.query;
  let list = [...DB.users];
  if(search){
    const s = search.toLowerCase();
    list = list.filter(u =>
      (u.uid || '').includes(s) || (u.phone || '').includes(s) ||
      (u.email || '').toLowerCase().includes(s) ||
      (u.first_name || '').toLowerCase().includes(s) ||
      (u.last_name || '').toLowerCase().includes(s) ||
      (u.invite_code || '').toLowerCase().includes(s));
  }
  const sortMap = {
    balance: (a, b) => b.balance - a.balance,
    balance_asc: (a, b) => a.balance - b.balance,
    laps: (a, b) => b.laps - a.laps,
    best: (a, b) => b.best_win - a.best_win,
    recent: (a, b) => (b.last_login || 0) - (a.last_login || 0),
    created: (a, b) => b.created_at - a.created_at,
    commission: (a, b) => b.total_commission - a.total_commission
  };
  list.sort(sortMap[sort] || sortMap.created);
  const total = list.length;
  const users = list.slice(parseInt(offset), parseInt(offset) + parseInt(limit));
  res.json({ users, total });
});
app.get('/api/admin/user/:uid', authAdmin, (req, res) => {
  const user = DB.users.find(u => u.uid === req.params.uid || u.phone === req.params.uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  const spins = DB.spins.filter(s => s.uid === user.uid).slice(-100).reverse();
  const transactions = DB.transactions.filter(t => t.uid === user.uid).slice(-100).reverse();
  const logins = DB.login_log.filter(l => l.uid === user.uid).slice(-50).reverse();
  const deposits = DB.deposit_requests.filter(d => d.uid === user.uid).slice(-50).reverse();
  const withdraws = DB.withdraw_requests.filter(d => d.uid === user.uid).slice(-50).reverse();
  const referrals = DB.users.filter(u => u.referred_by === user.uid)
    .map(r => ({ uid: r.uid, first_name: r.first_name, last_name: r.last_name, created_at: r.created_at }));
  const commissions = DB.commissions.filter(c => c.agent_uid === user.uid).slice(-50).reverse();
  res.json({ user, spins, transactions, logins, deposits, withdraws, referrals, commissions });
});
app.post('/api/admin/update-balance', authAdmin, (req, res) => {
  const { uid, newBalance, note } = req.body;
  if(typeof newBalance !== 'number') return res.status(400).json({ error: 'invalid balance' });
  const user = DB.users.find(u => u.uid === uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  const diff = newBalance - user.balance;
  user.balance = newBalance;
  DB.transactions.push({ id: ++DB._seq.transactions, uid, type: diff >= 0 ? 'admin_credit' : 'admin_debit',
    amount: diff, balance_after: newBalance, note: note || '', admin: 'admin', created_at: Date.now() });
  saveDB();
  res.json({ success: true, newBalance });
});
app.post('/api/admin/adjust-balance', authAdmin, (req, res) => {
  const { uid, amount, note } = req.body;
  if(typeof amount !== 'number') return res.status(400).json({ error: 'invalid amount' });
  const user = DB.users.find(u => u.uid === uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  user.balance = Math.max(0, user.balance + amount);
  DB.transactions.push({ id: ++DB._seq.transactions, uid, type: amount >= 0 ? 'admin_credit' : 'admin_debit',
    amount, balance_after: user.balance, note: note || '', admin: 'admin', created_at: Date.now() });
  saveDB();
  res.json({ success: true, newBalance: user.balance });
});
app.post('/api/admin/toggle-ban', authAdmin, (req, res) => {
  const { uid } = req.body;
  const user = DB.users.find(u => u.uid === uid);
  if(!user) return res.status(404).json({ error: 'غير موجود' });
  user.banned = user.banned ? 0 : 1;
  saveDB();
  res.json({ success: true, banned: user.banned });
});
app.post('/api/admin/set-note', authAdmin, (req, res) => {
  const { uid, note } = req.body;
  const user = DB.users.find(u => u.uid === uid);
  if(user){ user.notes = note || ''; saveDB(); }
  res.json({ success: true });
});
app.post('/api/admin/set-agent-level', authAdmin, (req, res) => {
  const { uid, level } = req.body;
  const lvl = Math.max(0, Math.min(3, parseInt(level) || 0));
  const user = DB.users.find(u => u.uid === uid);
  if(user){ user.agent_level = lvl; saveDB(); }
  res.json({ success: true, level: lvl });
});
app.get('/api/admin/deposits', authAdmin, (req, res) => {
  const { status = 'pending' } = req.query;
  const deposits = DB.deposit_requests.filter(d => d.status === status).slice(-200).reverse()
    .map(d => {
      const u = DB.users.find(x => x.uid === d.uid) || {};
      return { ...d, first_name: u.first_name, last_name: u.last_name, phone: u.phone };
    });
  res.json({ deposits });
});
app.post('/api/admin/deposits/process', authAdmin, (req, res) => {
  try {
    const { id, action, admin_note } = req.body;
    const deposit = DB.deposit_requests.find(d => d.id === id);
    if(!deposit) return res.status(404).json({ error: 'غير موجود' });
    if(deposit.status !== 'pending') return res.status(400).json({ error: 'تمت معالجته' });
    if(action === 'approve'){
      const user = DB.users.find(u => u.uid === deposit.uid);
      if(!user) return res.status(404).json({ error: 'المستخدم غير موجود' });
      user.balance += deposit.amount_syp;
      DB.transactions.push({ id: ++DB._seq.transactions, uid: deposit.uid, type: 'deposit',
        amount: deposit.amount_syp, balance_after: user.balance,
        note: 'إيداع ' + deposit.method_code + ' — ' + deposit.amount,
        admin: 'admin', created_at: Date.now() });
    }
    deposit.status = action === 'approve' ? 'approved' : 'rejected';
    deposit.admin_note = admin_note || '';
    deposit.processed_at = Date.now();
    deposit.processed_by = 'admin';
    saveDB();
    res.json({ success: true });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/withdraws', authAdmin, (req, res) => {
  const { status = 'pending' } = req.query;
  const withdraws = DB.withdraw_requests.filter(d => d.status === status).slice(-200).reverse()
    .map(d => {
      const u = DB.users.find(x => x.uid === d.uid) || {};
      return { ...d, first_name: u.first_name, last_name: u.last_name, phone: u.phone, user_balance: u.balance };
    });
  res.json({ withdraws });
});
app.post('/api/admin/withdraws/process', authAdmin, (req, res) => {
  try {
    const { id, action, admin_note } = req.body;
    const withdraw = DB.withdraw_requests.find(d => d.id === id);
    if(!withdraw) return res.status(404).json({ error: 'غير موجود' });
    if(withdraw.status !== 'pending') return res.status(400).json({ error: 'تمت معالجته' });
    if(action === 'reject'){
      const user = DB.users.find(u => u.uid === withdraw.uid);
      if(user){
        user.balance += withdraw.amount_syp;
        DB.transactions.push({ id: ++DB._seq.transactions, uid: withdraw.uid,
          type: 'withdraw_refund', amount: withdraw.amount_syp,
          balance_after: user.balance, note: 'إعادة رصيد سحب مرفوض',
          admin: 'admin', created_at: Date.now() });
      }
    }
    withdraw.status = action === 'approve' ? 'approved' : 'rejected';
    withdraw.admin_note = admin_note || '';
    withdraw.processed_at = Date.now();
    withdraw.processed_by = 'admin';
    saveDB();
    res.json({ success: true });
  } catch(e){ console.error(e); res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/recent-spins', authAdmin, (req, res) => {
  const spins = DB.spins.slice(-100).reverse().map(s => {
    const u = DB.users.find(x => x.uid === s.uid) || {};
    return { ...s, first_name: u.first_name, last_name: u.last_name };
  });
  res.json({ spins });
});
app.get('/api/admin/recent-logins', authAdmin, (req, res) => {
  const logins = DB.login_log.slice(-100).reverse().map(l => {
    const u = l.uid ? DB.users.find(x => x.uid === l.uid) : null;
    return { ...l, first_name: u?.first_name, last_name: u?.last_name };
  });
  res.json({ logins });
});
app.get('/api/admin/agents', authAdmin, (req, res) => {
  const agents = DB.users.filter(u => u.agent_level > 0)
    .sort((a, b) => b.total_commission - a.total_commission)
    .slice(0, 200)
    .map(u => ({
      uid: u.uid, first_name: u.first_name, last_name: u.last_name, phone: u.phone,
      agent_level: u.agent_level, total_commission: u.total_commission,
      balance: u.balance, created_at: u.created_at,
      referrals: DB.users.filter(x => x.referred_by === u.uid).length
    }));
  res.json({ agents });
});
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.use((req, res) => res.status(404).json({ error: 'Not found' }));

process.on('SIGTERM', () => { saveDB(); process.exit(0); });
process.on('SIGINT', () => { saveDB(); process.exit(0); });

app.listen(PORT, () => {
  console.log('⚡ STORMCROWN SERVER');
  console.log('Port: ' + PORT);
  console.log('Game: http://localhost:' + PORT + '/');
  console.log('Admin: http://localhost:' + PORT + '/admin');
  console.log('Admin password: ' + ADMIN_PASSWORD);
  console.log('Admin token: ' + ADMIN_TOKEN);
});

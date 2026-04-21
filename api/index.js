// api/index.js — Clan Fly Backend
// Деплой: Vercel. База: in-memory (для прода замени на Turso/PlanetScale)
// npm install express cors

const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'clanfly_admin_2024';

// ─── IN-MEMORY STORE ─────────────────────────────────────────────────────────
// Для Vercel Free используй Vercel KV или Upstash Redis вместо Map
// (Map сбрасывается при cold start)
const users = new Map();    // tg_id (string) → user object
const requests = [];        // array of request objects

function getUser(tgId, data = {}) {
  const id = String(tgId);
  if (!users.has(id)) {
    users.set(id, {
      tg_id: id,
      username: data.username || 'unknown',
      first_name: data.first_name || 'Player',
      balance: 0,
      total_won: 0,
      games_played: 0,
      created_at: new Date().toISOString(),
    });
  }
  const u = users.get(id);
  // Update name/username if provided
  if (data.username) u.username = data.username;
  if (data.first_name) u.first_name = data.first_name;
  return u;
}

function isAdmin(req) {
  return req.headers['x-admin-token'] === ADMIN_TOKEN;
}

// ─── USER ROUTES ─────────────────────────────────────────────────────────────

// GET /api/user/:tgId — получить профиль + баланс
app.get('/api/user/:tgId', (req, res) => {
  const user = getUser(req.params.tgId);
  res.json({ ok: true, user });
});

// POST /api/user/init — инициализировать пользователя при входе в Mini App
app.post('/api/user/init', (req, res) => {
  const { tg_id, username, first_name } = req.body;
  if (!tg_id) return res.status(400).json({ ok: false, error: 'tg_id required' });
  const user = getUser(tg_id, { username, first_name });

  // Check if there's a pending payout notification for this user
  const pendingPayout = requests.find(
    r => r.tg_id === String(tg_id) && r.type === 'withdraw' && r.status === 'paid_notify'
  );
  if (pendingPayout) {
    pendingPayout.status = 'paid_shown'; // Mark as shown
  }

  res.json({ ok: true, user, payout_notify: pendingPayout || null });
});

// POST /api/game/result — записать результат игры
app.post('/api/game/result', (req, res) => {
  const { tg_id, bet, winnings, multiplier } = req.body;
  if (!tg_id) return res.status(400).json({ ok: false, error: 'tg_id required' });

  const user = getUser(tg_id);

  if (bet > user.balance) {
    return res.status(400).json({ ok: false, error: 'Insufficient balance' });
  }

  user.balance -= bet;
  if (winnings > 0) {
    user.balance += winnings;
    user.total_won += winnings;
  }
  user.games_played += 1;

  res.json({ ok: true, user });
});

// ─── REQUEST ROUTES ───────────────────────────────────────────────────────────

// POST /api/request — создать заявку на пополнение или вывод
app.post('/api/request', (req, res) => {
  const { tg_id, username, first_name, type, amount } = req.body;
  if (!tg_id || !type || !amount) {
    return res.status(400).json({ ok: false, error: 'Missing fields' });
  }
  if (!['deposit', 'withdraw'].includes(type)) {
    return res.status(400).json({ ok: false, error: 'Invalid type' });
  }

  const user = getUser(tg_id, { username, first_name });

  if (type === 'withdraw') {
    if (amount > user.balance) {
      return res.status(400).json({ ok: false, error: 'Insufficient balance' });
    }
    user.balance -= amount; // Freeze on request
  }

  const request = {
    id: Date.now().toString(),
    type,
    tg_id: String(tg_id),
    username: user.username,
    first_name: user.first_name,
    amount: Number(amount),
    status: 'pending',
    created_at: new Date().toISOString(),
  };

  requests.unshift(request);
  res.json({ ok: true, request, user });
});

// ─── ADMIN ROUTES ─────────────────────────────────────────────────────────────

// GET /api/admin/requests — все заявки
app.get('/api/admin/requests', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  res.json({ ok: true, requests });
});

// POST /api/admin/approve — одобрить заявку
app.post('/api/admin/approve', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const { id } = req.body;
  const r = requests.find(x => x.id === id);
  if (!r) return res.status(404).json({ ok: false, error: 'Not found' });
  if (r.status !== 'pending') return res.status(400).json({ ok: false, error: 'Already processed' });

  const user = getUser(r.tg_id);

  if (r.type === 'deposit') {
    user.balance += r.amount;
    r.status = 'approved';
  } else if (r.type === 'withdraw') {
    // Balance already frozen, just mark for notification
    r.status = 'paid_notify';
  }

  res.json({ ok: true, request: r, user });
});

// POST /api/admin/reject — отклонить заявку
app.post('/api/admin/reject', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const { id } = req.body;
  const r = requests.find(x => x.id === id);
  if (!r) return res.status(404).json({ ok: false, error: 'Not found' });

  const user = getUser(r.tg_id);

  if (r.type === 'withdraw' && r.status === 'pending') {
    user.balance += r.amount; // Refund frozen balance
  }

  r.status = 'rejected';
  res.json({ ok: true, request: r, user });
});

// POST /api/admin/credit — вручную начислить баланс
app.post('/api/admin/credit', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });

  const { tg_id, amount } = req.body;
  if (!tg_id || !amount) return res.status(400).json({ ok: false, error: 'Missing fields' });

  const user = getUser(tg_id);
  user.balance += Number(amount);
  res.json({ ok: true, user });
});

// GET /api/admin/users — все пользователи
app.get('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  res.json({ ok: true, users: Array.from(users.values()) });
});

// ─── HEALTH ───────────────────────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ ok: true, users: users.size, requests: requests.length });
});

module.exports = app;

// For local dev:
if (require.main === module) {
  app.listen(PORT || 3000, () => console.log(`Server on http://localhost:${PORT || 3000}`));
}

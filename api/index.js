const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors({ origin: '*' }));
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || 'clanfly_admin_2024';
const users = new Map();
const requests = [];

function getUser(tgId, data = {}) {
  const id = String(tgId);
  if (!users.has(id)) {
    users.set(id, { tg_id: id, username: data.username || 'unknown', first_name: data.first_name || 'Player', balance: 0, total_won: 0, games_played: 0 });
  }
  const u = users.get(id);
  if (data.username) u.username = data.username;
  if (data.first_name) u.first_name = data.first_name;
  return u;
}

function isAdmin(req) { return req.headers['x-admin-token'] === ADMIN_TOKEN; }

app.get('/api/health', (req, res) => res.json({ ok: true, users: users.size, requests: requests.length }));

app.post('/api/user/init', (req, res) => {
  const { tg_id, username, first_name } = req.body;
  if (!tg_id) return res.status(400).json({ ok: false, error: 'tg_id required' });
  const user = getUser(tg_id, { username, first_name });
  const pendingPayout = requests.find(r => r.tg_id === String(tg_id) && r.type === 'withdraw' && r.status === 'paid_notify');
  if (pendingPayout) pendingPayout.status = 'paid_shown';
  res.json({ ok: true, user, payout_notify: pendingPayout || null });
});

app.get('/api/user/:tgId', (req, res) => res.json({ ok: true, user: getUser(req.params.tgId) }));

app.post('/api/game/result', (req, res) => {
  const { tg_id, bet, winnings } = req.body;
  if (!tg_id) return res.status(400).json({ ok: false, error: 'tg_id required' });
  const user = getUser(tg_id);
  if (bet > user.balance) return res.status(400).json({ ok: false, error: 'Insufficient balance' });
  user.balance -= bet;
  if (winnings > 0) { user.balance += winnings; user.total_won += winnings; }
  user.games_played += 1;
  res.json({ ok: true, user });
});

app.post('/api/request', (req, res) => {
  const { tg_id, username, first_name, type, amount } = req.body;
  if (!tg_id || !type || !amount) return res.status(400).json({ ok: false, error: 'Missing fields' });
  const user = getUser(tg_id, { username, first_name });
  if (type === 'withdraw' && amount > user.balance) return res.status(400).json({ ok: false, error: 'Insufficient balance' });
  if (type === 'withdraw') user.balance -= amount;
  const request = { id: Date.now().toString(), type, tg_id: String(tg_id), username: user.username, first_name: user.first_name, amount: Number(amount), status: 'pending', created_at: new Date().toISOString() };
  requests.unshift(request);
  res.json({ ok: true, request, user });
});

app.get('/api/admin/requests', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  res.json({ ok: true, requests });
});

app.post('/api/admin/approve', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const r = requests.find(x => x.id === req.body.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Not found' });
  const user = getUser(r.tg_id);
  if (r.type === 'deposit') { user.balance += r.amount; r.status = 'approved'; }
  else { r.status = 'paid_notify'; }
  res.json({ ok: true, request: r, user });
});

app.post('/api/admin/reject', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const r = requests.find(x => x.id === req.body.id);
  if (!r) return res.status(404).json({ ok: false, error: 'Not found' });
  const user = getUser(r.tg_id);
  if (r.type === 'withdraw' && r.status === 'pending') user.balance += r.amount;
  r.status = 'rejected';
  res.json({ ok: true, request: r, user });
});

app.post('/api/admin/credit', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  const { tg_id, amount } = req.body;
  if (!tg_id || !amount) return res.status(400).json({ ok: false, error: 'Missing fields' });
  const user = getUser(tg_id);
  user.balance += Number(amount);
  res.json({ ok: true, user });
});

app.get('/api/admin/users', (req, res) => {
  if (!isAdmin(req)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  res.json({ ok: true, users: Array.from(users.values()) });
});

module.exports = app;

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Server running on port ' + PORT));

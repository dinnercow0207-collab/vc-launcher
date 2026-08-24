const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');

const db = require('./db');
const { registerUser, verifyUser } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ---- セッション設定 ----
// SESSION_SECRETはRenderの環境変数で好きな文字列を設定してください
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30日
    sameSite: 'lax',
  },
});
app.use(sessionMiddleware);
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (req, res) => {
  res.redirect(req.session.userId ? '/app.html' : '/login.html');
});

// socket.ioでも同じセッションを読めるようにする
io.engine.use(sessionMiddleware);

function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'ログインが必要です' });
  // BANされていたら、その場でセッションを切ってログアウトさせる
  const user = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(req.session.userId);
  if (!user || user.is_banned) {
    req.session.destroy(() => {});
    return res.status(403).json({ error: 'このアカウントは利用停止されています' });
  }
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.userId || !req.session.isAdmin) {
    return res.status(403).json({ error: '管理者のみアクセスできます' });
  }
  next();
}

// ---------------- 認証API ----------------
app.post('/api/register', (req, res) => {
  try {
    const { username, password } = req.body;
    const user = registerUser(username, password);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    const user = verifyUser(username, password);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  res.json({ user: { id: req.session.userId, username: req.session.username, is_admin: !!req.session.isAdmin } });
});

// socket.idのオンライン管理(統計・強制切断用)。userId -> Set of socket.id
const userSockets = new Map();

// ---------------- サーバー(コミュニティ)API ----------------
function genInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

app.get('/api/servers', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT s.* FROM servers s
    JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = ?
  `).all(req.session.userId);
  res.json({ servers: rows });
});

app.post('/api/servers', requireLogin, (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'サーバー名を入力してください' });

  const inviteCode = genInviteCode();
  const info = db.prepare('INSERT INTO servers (name, owner_id, invite_code) VALUES (?, ?, ?)')
    .run(name, req.session.userId, inviteCode);
  const serverId = info.lastInsertRowid;

  db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(serverId, req.session.userId);
  db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, '雑談', 'text');
  db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)').run(serverId, '通話', 'voice');

  res.json({ ok: true, server: { id: serverId, name, owner_id: req.session.userId, invite_code: inviteCode } });
});

app.post('/api/servers/join', requireLogin, (req, res) => {
  const code = (req.body.invite_code || '').trim();
  const srv = db.prepare('SELECT * FROM servers WHERE invite_code = ?').get(code);
  if (!srv) return res.status(404).json({ error: '招待コードが見つかりません' });

  const already = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(srv.id, req.session.userId);
  if (!already) {
    db.prepare('INSERT INTO server_members (server_id, user_id) VALUES (?, ?)').run(srv.id, req.session.userId);
  }
  res.json({ ok: true, server: srv });
});

app.get('/api/servers/:id/channels', requireLogin, (req, res) => {
  const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'このサーバーのメンバーではありません' });

  const channels = db.prepare('SELECT * FROM channels WHERE server_id = ? ORDER BY id').all(req.params.id);
  res.json({ channels });
});

app.post('/api/servers/:id/channels', requireLogin, (req, res) => {
  const member = db.prepare('SELECT 1 FROM server_members WHERE server_id = ? AND user_id = ?')
    .get(req.params.id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'このサーバーのメンバーではありません' });

  const { name, type } = req.body;
  if (!name || !['text', 'voice'].includes(type)) {
    return res.status(400).json({ error: 'チャンネル名とタイプ(text/voice)を指定してください' });
  }
  const info = db.prepare('INSERT INTO channels (server_id, name, type) VALUES (?, ?, ?)')
    .run(req.params.id, name.trim(), type);
  res.json({ ok: true, channel: { id: info.lastInsertRowid, server_id: Number(req.params.id), name, type } });
});

app.get('/api/channels/:id/messages', requireLogin, (req, res) => {
  const rows = db.prepare(`
    SELECT messages.id, messages.content, messages.created_at, users.username, users.id as user_id
    FROM messages
    JOIN users ON users.id = messages.user_id
    WHERE channel_id = ?
    ORDER BY messages.id DESC LIMIT 50
  `).all(req.params.id);
  res.json({ messages: rows.reverse() });
});

// ---------------- 管理者API ----------------
app.get('/api/admin/stats', requireAdmin, (req, res) => {
  const totalUsers = db.prepare('SELECT COUNT(*) AS c FROM users').get().c;
  const bannedUsers = db.prepare('SELECT COUNT(*) AS c FROM users WHERE is_banned = 1').get().c;
  const totalServers = db.prepare('SELECT COUNT(*) AS c FROM servers').get().c;
  const totalMessages = db.prepare('SELECT COUNT(*) AS c FROM messages').get().c;
  res.json({
    totalUsers,
    bannedUsers,
    totalServers,
    totalMessages,
    onlineUsers: userSockets.size,
  });
});

app.get('/api/admin/users', requireAdmin, (req, res) => {
  const rows = db.prepare(`
    SELECT id, username, is_admin, is_banned, created_at
    FROM users
    ORDER BY id DESC
  `).all();
  const users = rows.map((u) => ({ ...u, online: userSockets.has(u.id) }));
  res.json({ users });
});

app.post('/api/admin/users/:id/ban', requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: '自分自身はBANできません' });
  }
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.is_admin) {
    return res.status(400).json({ error: '管理者アカウントはBANできません' });
  }

  db.prepare('UPDATE users SET is_banned = 1 WHERE id = ?').run(targetId);

  // 今まさに接続中なら、その場で強制切断する
  const sockets = userSockets.get(targetId);
  if (sockets) {
    sockets.forEach((socketId) => {
      const s = io.sockets.sockets.get(socketId);
      if (s) {
        s.emit('force-disconnect', { reason: 'banned' });
        s.disconnect(true);
      }
    });
  }

  res.json({ ok: true });
});

app.post('/api/admin/users/:id/unban', requireAdmin, (req, res) => {
  const targetId = Number(req.params.id);
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(targetId);
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  db.prepare('UPDATE users SET is_banned = 0 WHERE id = ?').run(targetId);
  res.json({ ok: true });
});

// ---------------- Socket.io: チャット + VCシグナリング ----------------
const voiceRooms = new Map(); // channelId -> Set of socket.id

io.on('connection', (socket) => {
  const session = socket.request.session;
  if (!session || !session.userId) {
    socket.disconnect();
    return;
  }
  const userRow = db.prepare('SELECT is_banned FROM users WHERE id = ?').get(session.userId);
  if (!userRow || userRow.is_banned) {
    socket.disconnect();
    return;
  }
  const userId = session.userId;
  const username = session.username;

  if (!userSockets.has(userId)) userSockets.set(userId, new Set());
  userSockets.get(userId).add(socket.id);

  // ---- テキストチャット ----
  socket.on('chat:join', (channelId) => {
    socket.join(`text:${channelId}`);
  });

  socket.on('chat:leave', (channelId) => {
    socket.leave(`text:${channelId}`);
  });

  socket.on('chat:send', ({ channelId, content }) => {
    content = (content || '').trim();
    if (!content) return;
    const info = db.prepare('INSERT INTO messages (channel_id, user_id, content) VALUES (?, ?, ?)')
      .run(channelId, userId, content);
    const msg = {
      id: info.lastInsertRowid,
      channel_id: channelId,
      user_id: userId,
      username,
      content,
      created_at: new Date().toISOString(),
    };
    io.to(`text:${channelId}`).emit('chat:message', msg);
  });

  // ---- VC(WebRTCシグナリング)----
  // メッシュ接続方式: 同じボイスチャンネルの全員が互いに直接つながる
  // 少人数向け(目安4〜6人)。人数が増えるとPC負荷が上がるので注意
  socket.on('voice:join', (channelId) => {
    socket.data.voiceChannel = channelId;
    if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Set());
    const room = voiceRooms.get(channelId);

    // 既存メンバーの一覧を新規参加者に送る
    const existing = Array.from(room).map((id) => ({
      socketId: id,
      username: io.sockets.sockets.get(id)?.request.session.username,
    }));
    socket.emit('voice:existing-members', existing);

    room.add(socket.id);
    socket.join(`voice:${channelId}`);
    socket.to(`voice:${channelId}`).emit('voice:user-joined', { socketId: socket.id, username });
  });

  socket.on('voice:leave', () => {
    leaveVoice(socket);
  });

  // WebRTCのオファー/アンサー/ICE candidateを、指定した相手にだけ中継する
  socket.on('voice:offer', ({ to, offer }) => {
    io.to(to).emit('voice:offer', { from: socket.id, offer, username });
  });
  socket.on('voice:answer', ({ to, answer }) => {
    io.to(to).emit('voice:answer', { from: socket.id, answer });
  });
  socket.on('voice:ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('voice:ice-candidate', { from: socket.id, candidate });
  });

  // 画面共有の開始/終了を、同じ通話メンバーに通知するだけ(映像自体はWebRTCのtrackで送る)
  socket.on('voice:screen-share-start', () => {
    const channelId = socket.data.voiceChannel;
    if (channelId) socket.to(`voice:${channelId}`).emit('voice:screen-share-start', { socketId: socket.id });
  });
  socket.on('voice:screen-share-stop', () => {
    const channelId = socket.data.voiceChannel;
    if (channelId) socket.to(`voice:${channelId}`).emit('voice:screen-share-stop', { socketId: socket.id });
  });

  socket.on('disconnect', () => {
    leaveVoice(socket);
    const set = userSockets.get(userId);
    if (set) {
      set.delete(socket.id);
      if (set.size === 0) userSockets.delete(userId);
    }
  });

  function leaveVoice(socket) {
    const channelId = socket.data.voiceChannel;
    if (!channelId) return;
    const room = voiceRooms.get(channelId);
    if (room) {
      room.delete(socket.id);
      if (room.size === 0) voiceRooms.delete(channelId);
    }
    socket.leave(`voice:${channelId}`);
    socket.to(`voice:${channelId}`).emit('voice:user-left', { socketId: socket.id });
    socket.data.voiceChannel = null;
  }
});

server.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
});

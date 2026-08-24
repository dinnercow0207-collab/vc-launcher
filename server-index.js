const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');
const multer = require('multer');

const { pool, init } = require('./db');
const { registerUser, verifyUser } = require('./auth');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// Supabase Storageへのアップロード用設定
const SUPABASE_URL = process.env.SUPABASE_URL; // 例: https://xxxx.supabase.co
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const STORAGE_BUCKET = 'uploads';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } }); // 50MBまで

// ---- セッション設定 ----
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

io.engine.use(sessionMiddleware);

// socket.idのオンライン管理(統計・強制切断用)。userId -> Set of socket.id
const userSockets = new Map();

async function requireLogin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'ログインが必要です' });
  const result = await pool.query('SELECT is_banned FROM users WHERE id = $1', [req.session.userId]);
  const user = result.rows[0];
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
app.post('/api/register', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await registerUser(username, password);
    req.session.userId = user.id;
    req.session.username = user.username;
    req.session.isAdmin = user.is_admin;
    res.json({ ok: true, user });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const user = await verifyUser(username, password);
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

// ---------------- サーバー(コミュニティ)API ----------------
function genInviteCode() {
  return crypto.randomBytes(4).toString('hex');
}

app.get('/api/servers', requireLogin, async (req, res) => {
  const result = await pool.query(`
    SELECT s.* FROM servers s
    JOIN server_members m ON m.server_id = s.id
    WHERE m.user_id = $1
  `, [req.session.userId]);
  res.json({ servers: result.rows });
});

app.post('/api/servers', requireLogin, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'サーバー名を入力してください' });

  const inviteCode = genInviteCode();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const srvResult = await client.query(
      'INSERT INTO servers (name, owner_id, invite_code) VALUES ($1, $2, $3) RETURNING id',
      [name, req.session.userId, inviteCode]
    );
    const serverId = srvResult.rows[0].id;
    await client.query('INSERT INTO server_members (server_id, user_id) VALUES ($1, $2)', [serverId, req.session.userId]);
    await client.query("INSERT INTO channels (server_id, name, type) VALUES ($1, '雑談', 'text')", [serverId]);
    await client.query("INSERT INTO channels (server_id, name, type) VALUES ($1, '通話', 'voice')", [serverId]);
    await client.query('COMMIT');
    res.json({ ok: true, server: { id: serverId, name, owner_id: req.session.userId, invite_code: inviteCode } });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'サーバー作成に失敗しました' });
  } finally {
    client.release();
  }
});

app.post('/api/servers/join', requireLogin, async (req, res) => {
  const code = (req.body.invite_code || '').trim();
  const srvResult = await pool.query('SELECT * FROM servers WHERE invite_code = $1', [code]);
  const srv = srvResult.rows[0];
  if (!srv) return res.status(404).json({ error: '招待コードが見つかりません' });

  await pool.query(
    'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [srv.id, req.session.userId]
  );
  res.json({ ok: true, server: srv });
});

app.get('/api/servers/:id/channels', requireLogin, async (req, res) => {
  const memberResult = await pool.query(
    'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (memberResult.rows.length === 0) return res.status(403).json({ error: 'このサーバーのメンバーではありません' });

  const result = await pool.query('SELECT * FROM channels WHERE server_id = $1 ORDER BY id', [req.params.id]);
  res.json({ channels: result.rows });
});

app.post('/api/servers/:id/channels', requireLogin, async (req, res) => {
  const memberResult = await pool.query(
    'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (memberResult.rows.length === 0) return res.status(403).json({ error: 'このサーバーのメンバーではありません' });

  const { name, type } = req.body;
  if (!name || !['text', 'voice'].includes(type)) {
    return res.status(400).json({ error: 'チャンネル名とタイプ(text/voice)を指定してください' });
  }
  const result = await pool.query(
    'INSERT INTO channels (server_id, name, type) VALUES ($1, $2, $3) RETURNING id',
    [req.params.id, name.trim(), type]
  );
  res.json({ ok: true, channel: { id: result.rows[0].id, server_id: Number(req.params.id), name, type } });
});

app.get('/api/channels/:id/messages', requireLogin, async (req, res) => {
  const result = await pool.query(`
    SELECT messages.id, messages.content, messages.attachment_url, messages.attachment_type,
           messages.created_at, users.username, users.id as user_id
    FROM messages
    JOIN users ON users.id = messages.user_id
    WHERE channel_id = $1
    ORDER BY messages.id DESC LIMIT 50
  `, [req.params.id]);
  res.json({ messages: result.rows.reverse() });
});

// ---------------- ファイルアップロードAPI(画像・動画) ----------------
app.post('/api/upload', requireLogin, upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'ファイルが見つかりません' });
    if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
      return res.status(500).json({ error: 'サーバー側のストレージ設定が未完了です' });
    }
    const ext = (req.file.originalname.split('.').pop() || 'bin').toLowerCase();
    const key = `${req.session.userId}/${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${ext}`;

    const uploadRes = await fetch(
      `${SUPABASE_URL}/storage/v1/object/${STORAGE_BUCKET}/${key}`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
          apikey: SUPABASE_SERVICE_ROLE_KEY,
          'Content-Type': req.file.mimetype,
        },
        body: req.file.buffer,
      }
    );

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('Supabase upload error:', errText);
      return res.status(500).json({ error: 'アップロードに失敗しました' });
    }

    const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/${STORAGE_BUCKET}/${key}`;
    const attachmentType = req.file.mimetype.startsWith('video/') ? 'video' : 'image';
    res.json({ ok: true, url: publicUrl, type: attachmentType });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'アップロード中にエラーが発生しました' });
  }
});

// ---------------- 管理者API ----------------
app.get('/api/admin/stats', requireAdmin, async (req, res) => {
  const totalUsers = (await pool.query('SELECT COUNT(*) AS c FROM users')).rows[0].c;
  const bannedUsers = (await pool.query('SELECT COUNT(*) AS c FROM users WHERE is_banned = true')).rows[0].c;
  const totalServers = (await pool.query('SELECT COUNT(*) AS c FROM servers')).rows[0].c;
  const totalMessages = (await pool.query('SELECT COUNT(*) AS c FROM messages')).rows[0].c;
  res.json({
    totalUsers: Number(totalUsers),
    bannedUsers: Number(bannedUsers),
    totalServers: Number(totalServers),
    totalMessages: Number(totalMessages),
    onlineUsers: userSockets.size,
  });
});

app.get('/api/admin/users', requireAdmin, async (req, res) => {
  const result = await pool.query(`
    SELECT id, username, is_admin, is_banned, created_at
    FROM users
    ORDER BY id DESC
  `);
  const users = result.rows.map((u) => ({ ...u, online: userSockets.has(u.id) }));
  res.json({ users });
});

app.post('/api/admin/users/:id/ban', requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  if (targetId === req.session.userId) {
    return res.status(400).json({ error: '自分自身はBANできません' });
  }
  const targetResult = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
  const target = targetResult.rows[0];
  if (!target) return res.status(404).json({ error: 'ユーザーが見つかりません' });
  if (target.is_admin) {
    return res.status(400).json({ error: '管理者アカウントはBANできません' });
  }

  await pool.query('UPDATE users SET is_banned = true WHERE id = $1', [targetId]);

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

app.post('/api/admin/users/:id/unban', requireAdmin, async (req, res) => {
  const targetId = Number(req.params.id);
  const targetResult = await pool.query('SELECT * FROM users WHERE id = $1', [targetId]);
  if (!targetResult.rows[0]) return res.status(404).json({ error: 'ユーザーが見つかりません' });

  await pool.query('UPDATE users SET is_banned = false WHERE id = $1', [targetId]);
  res.json({ ok: true });
});

// ---------------- Socket.io: チャット + VCシグナリング ----------------
const voiceRooms = new Map(); // channelId -> Set of socket.id

io.on('connection', async (socket) => {
  const session = socket.request.session;
  if (!session || !session.userId) {
    socket.disconnect();
    return;
  }
  const userRow = (await pool.query('SELECT is_banned FROM users WHERE id = $1', [session.userId])).rows[0];
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

  socket.on('chat:send', async ({ channelId, content, attachmentUrl, attachmentType }) => {
    content = (content || '').trim();
    if (!content && !attachmentUrl) return;
    const result = await pool.query(
      'INSERT INTO messages (channel_id, user_id, content, attachment_url, attachment_type) VALUES ($1, $2, $3, $4, $5) RETURNING id, created_at',
      [channelId, userId, content, attachmentUrl || null, attachmentType || null]
    );
    const msg = {
      id: result.rows[0].id,
      channel_id: channelId,
      user_id: userId,
      username,
      content,
      attachment_url: attachmentUrl || null,
      attachment_type: attachmentType || null,
      created_at: result.rows[0].created_at,
    };
    io.to(`text:${channelId}`).emit('chat:message', msg);
  });

  // ---- VC(WebRTCシグナリング)----
  socket.on('voice:join', (channelId) => {
    socket.data.voiceChannel = channelId;
    if (!voiceRooms.has(channelId)) voiceRooms.set(channelId, new Set());
    const room = voiceRooms.get(channelId);

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

  socket.on('voice:offer', ({ to, offer }) => {
    io.to(to).emit('voice:offer', { from: socket.id, offer, username });
  });
  socket.on('voice:answer', ({ to, answer }) => {
    io.to(to).emit('voice:answer', { from: socket.id, answer });
  });
  socket.on('voice:ice-candidate', ({ to, candidate }) => {
    io.to(to).emit('voice:ice-candidate', { from: socket.id, candidate });
  });

  // 音声ファイル共有(音楽など)の開始/終了通知
  socket.on('voice:audioshare-start', ({ label }) => {
    const channelId = socket.data.voiceChannel;
    if (channelId) socket.to(`voice:${channelId}`).emit('voice:audioshare-start', { socketId: socket.id, label });
  });
  socket.on('voice:audioshare-stop', () => {
    const channelId = socket.data.voiceChannel;
    if (channelId) socket.to(`voice:${channelId}`).emit('voice:audioshare-stop', { socketId: socket.id });
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

init()
  .then(() => {
    server.listen(PORT, () => {
      console.log(`サーバー起動: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('データベース初期化に失敗しました:', e);
    process.exit(1);
  });

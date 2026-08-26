const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { Server } = require('socket.io');
const http = require('http');
const multer = require('multer');

const { pool, init, migrate } = require('./db');
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

// サーバー内でのそのユーザーの役割を判定するヘルパー
// 'owner' | 'moderator' | 'member' | null(メンバーではない)
async function getMemberRole(serverId, userId) {
  const srvResult = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [serverId]);
  const srv = srvResult.rows[0];
  if (!srv) return null;
  if (srv.owner_id === userId) return 'owner';
  const memResult = await pool.query(
    'SELECT is_moderator FROM server_members WHERE server_id = $1 AND user_id = $2',
    [serverId, userId]
  );
  const mem = memResult.rows[0];
  if (!mem) return null;
  return mem.is_moderator ? 'moderator' : 'member';
}

app.get('/api/servers/:id/channels', requireLogin, async (req, res) => {
  const memberResult = await pool.query(
    'SELECT 1 FROM server_members WHERE server_id = $1 AND user_id = $2',
    [req.params.id, req.session.userId]
  );
  if (memberResult.rows.length === 0) return res.status(403).json({ error: 'このサーバーのメンバーではありません' });

  const result = await pool.query('SELECT * FROM channels WHERE server_id = $1 ORDER BY position, id', [req.params.id]);
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
  const maxPosResult = await pool.query('SELECT COALESCE(MAX(position), -1) AS m FROM channels WHERE server_id = $1', [req.params.id]);
  const nextPos = Number(maxPosResult.rows[0].m) + 1;
  const result = await pool.query(
    'INSERT INTO channels (server_id, name, type, position) VALUES ($1, $2, $3, $4) RETURNING id',
    [req.params.id, name.trim(), type, nextPos]
  );
  res.json({ ok: true, channel: { id: result.rows[0].id, server_id: Number(req.params.id), name, type, position: nextPos } });
});

// チャンネル名の変更(owner・moderatorのみ)
app.patch('/api/channels/:id', requireLogin, async (req, res) => {
  const chResult = await pool.query('SELECT * FROM channels WHERE id = $1', [req.params.id]);
  const channel = chResult.rows[0];
  if (!channel) return res.status(404).json({ error: 'チャンネルが見つかりません' });

  const role = await getMemberRole(channel.server_id, req.session.userId);
  if (role !== 'owner' && role !== 'moderator') {
    return res.status(403).json({ error: 'この操作を行う権限がありません' });
  }

  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'チャンネル名を入力してください' });

  await pool.query('UPDATE channels SET name = $1 WHERE id = $2', [name, req.params.id]);
  res.json({ ok: true });
});

// チャンネルの削除(owner・moderatorのみ)
app.delete('/api/channels/:id', requireLogin, async (req, res) => {
  const chResult = await pool.query('SELECT * FROM channels WHERE id = $1', [req.params.id]);
  const channel = chResult.rows[0];
  if (!channel) return res.status(404).json({ error: 'チャンネルが見つかりません' });

  // チャンネルの削除はそのサーバーのメンバーなら誰でも行える
  const role = await getMemberRole(channel.server_id, req.session.userId);
  if (!role) {
    return res.status(403).json({ error: 'このサーバーのメンバーではありません' });
  }

  await pool.query('DELETE FROM messages WHERE channel_id = $1', [req.params.id]);
  await pool.query('DELETE FROM channels WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
});

// チャンネルの並び替え(owner・moderatorのみ)。orderedIds は表示したい順のチャンネルID配列
app.post('/api/servers/:id/channels/reorder', requireLogin, async (req, res) => {
  const role = await getMemberRole(req.params.id, req.session.userId);
  if (role !== 'owner' && role !== 'moderator') {
    return res.status(403).json({ error: 'この操作を行う権限がありません' });
  }
  const { orderedIds } = req.body;
  if (!Array.isArray(orderedIds)) return res.status(400).json({ error: 'orderedIdsが不正です' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (let i = 0; i < orderedIds.length; i++) {
      await client.query(
        'UPDATE channels SET position = $1 WHERE id = $2 AND server_id = $3',
        [i, orderedIds[i], req.params.id]
      );
    }
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: '並び替えに失敗しました' });
  } finally {
    client.release();
  }
});

// サーバーの削除(owner本人のみ)
app.delete('/api/servers/:id', requireLogin, async (req, res) => {
  const srvResult = await pool.query('SELECT * FROM servers WHERE id = $1', [req.params.id]);
  const srv = srvResult.rows[0];
  if (!srv) return res.status(404).json({ error: 'サーバーが見つかりません' });
  if (srv.is_system) {
    return res.status(400).json({ error: 'この特別なサーバーは削除できません' });
  }
  if (srv.owner_id !== req.session.userId) {
    return res.status(403).json({ error: 'サーバー作成者のみ削除できます' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const chResult = await client.query('SELECT id FROM channels WHERE server_id = $1', [req.params.id]);
    for (const ch of chResult.rows) {
      await client.query('DELETE FROM messages WHERE channel_id = $1', [ch.id]);
    }
    await client.query('DELETE FROM channels WHERE server_id = $1', [req.params.id]);
    await client.query('DELETE FROM server_members WHERE server_id = $1', [req.params.id]);
    await client.query('DELETE FROM servers WHERE id = $1', [req.params.id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (e) {
    await client.query('ROLLBACK');
    res.status(500).json({ error: 'サーバー削除に失敗しました' });
  } finally {
    client.release();
  }
});

// サーバーのメンバー一覧(オンライン状況・役割つき)
app.get('/api/servers/:id/members', requireLogin, async (req, res) => {
  const role = await getMemberRole(req.params.id, req.session.userId);
  if (!role) return res.status(403).json({ error: 'このサーバーのメンバーではありません' });

  const srvResult = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [req.params.id]);
  const ownerId = srvResult.rows[0]?.owner_id;

  const result = await pool.query(`
    SELECT u.id, u.username, sm.is_moderator
    FROM server_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.server_id = $1
  `, [req.params.id]);

  const members = result.rows.map((m) => ({
    id: m.id,
    username: m.username,
    online: userSockets.has(m.id),
    role: m.id === ownerId ? 'owner' : (m.is_moderator ? 'moderator' : 'member'),
  }));
  res.json({ members, myRole: role });
});

// メンバーのキック(owner・moderatorのみ)
app.post('/api/servers/:id/members/:userId/kick', requireLogin, async (req, res) => {
  const role = await getMemberRole(req.params.id, req.session.userId);
  if (role !== 'owner' && role !== 'moderator') {
    return res.status(403).json({ error: 'この操作を行う権限がありません' });
  }
  const targetId = Number(req.params.userId);
  const srvResult = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [req.params.id]);
  if (srvResult.rows[0]?.owner_id === targetId) {
    return res.status(400).json({ error: 'サーバー作成者はキックできません' });
  }

  await pool.query('DELETE FROM server_members WHERE server_id = $1 AND user_id = $2', [req.params.id, targetId]);

  const sockets = userSockets.get(targetId);
  if (sockets) {
    sockets.forEach((socketId) => {
      io.to(socketId).emit('server:kicked', { serverId: Number(req.params.id) });
    });
  }
  res.json({ ok: true });
});

// モデレーター権限の付与・剥奪(owner本人のみ)
app.patch('/api/servers/:id/members/:userId/role', requireLogin, async (req, res) => {
  const srvResult = await pool.query('SELECT owner_id FROM servers WHERE id = $1', [req.params.id]);
  const srv = srvResult.rows[0];
  if (!srv) return res.status(404).json({ error: 'サーバーが見つかりません' });
  if (srv.owner_id !== req.session.userId) {
    return res.status(403).json({ error: 'サーバー作成者のみ変更できます' });
  }
  const targetId = Number(req.params.userId);
  const isModerator = !!req.body.isModerator;
  await pool.query(
    'UPDATE server_members SET is_moderator = $1 WHERE server_id = $2 AND user_id = $3',
    [isModerator, req.params.id, targetId]
  );
  res.json({ ok: true });
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

// プロフィール変更(ユーザー名・パスワード)
app.post('/api/me/update', requireLogin, async (req, res) => {
  try {
    const { newUsername, currentPassword, newPassword } = req.body;
    const userResult = await pool.query('SELECT * FROM users WHERE id = $1', [req.session.userId]);
    const user = userResult.rows[0];
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });

    const bcrypt = require('bcryptjs');
    if (!currentPassword || !bcrypt.compareSync(currentPassword, user.password_hash)) {
      return res.status(400).json({ error: '現在のパスワードが正しくありません' });
    }

    let username = user.username;
    if (newUsername && newUsername.trim() && newUsername.trim() !== user.username) {
      username = newUsername.trim();
      if (username.length < 3 || username.length > 20) {
        return res.status(400).json({ error: 'ユーザー名は3〜20文字にしてください' });
      }
      const exists = await pool.query('SELECT id FROM users WHERE username = $1 AND id != $2', [username, user.id]);
      if (exists.rows.length > 0) {
        return res.status(400).json({ error: 'そのユーザー名はすでに使われています' });
      }
    }

    let passwordHash = user.password_hash;
    if (newPassword) {
      if (newPassword.length < 4) return res.status(400).json({ error: '新しいパスワードは4文字以上にしてください' });
      passwordHash = bcrypt.hashSync(newPassword, 10);
    }

    await pool.query('UPDATE users SET username = $1, password_hash = $2 WHERE id = $3', [username, passwordHash, user.id]);
    req.session.username = username;
    res.json({ ok: true, username });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: '更新に失敗しました' });
  }
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
  .then(() => migrate())
  .then(() => {
    server.listen(PORT, () => {
      console.log(`サーバー起動: http://localhost:${PORT}`);
    });
  })
  .catch((e) => {
    console.error('データベース初期化に失敗しました:', e);
    process.exit(1);
  });

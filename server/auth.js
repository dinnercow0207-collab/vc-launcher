const bcrypt = require('bcryptjs');
const { pool, ensureSystemServerAndJoin } = require('./db');

async function registerUser(username, password) {
  username = (username || '').trim();
  if (username.length < 3 || username.length > 20) {
    throw new Error('ユーザー名は3〜20文字にしてください');
  }
  if (!password || password.length < 4) {
    throw new Error('パスワードは4文字以上にしてください');
  }
  const exists = await pool.query('SELECT id FROM users WHERE username = $1', [username]);
  if (exists.rows.length > 0) {
    throw new Error('そのユーザー名はすでに使われています');
  }
  const hash = bcrypt.hashSync(password, 10);
  const isAdmin = process.env.ADMIN_USERNAME && username === process.env.ADMIN_USERNAME;
  const result = await pool.query(
    'INSERT INTO users (username, password_hash, is_admin) VALUES ($1, $2, $3) RETURNING id',
    [username, hash, isAdmin]
  );
  const newUserId = result.rows[0].id;

  try {
    await ensureSystemServerAndJoin(newUserId);
  } catch (e) {
    console.error('運営お知らせサーバーへの参加に失敗しました:', e);
  }

  return { id: newUserId, username, is_admin: !!isAdmin };
}

async function verifyUser(username, password) {
  const result = await pool.query('SELECT * FROM users WHERE username = $1', [(username || '').trim()]);
  const user = result.rows[0];
  if (!user) throw new Error('ユーザー名またはパスワードが違います');
  const ok = bcrypt.compareSync(password || '', user.password_hash);
  if (!ok) throw new Error('ユーザー名またはパスワードが違います');
  if (user.is_banned) throw new Error('このアカウントは利用停止されています');

  try {
    await ensureSystemServerAndJoin(user.id);
  } catch (e) {
    console.error('運営お知らせサーバーへの参加に失敗しました:', e);
  }

  return { id: user.id, username: user.username, is_admin: !!user.is_admin };
}

module.exports = { registerUser, verifyUser };

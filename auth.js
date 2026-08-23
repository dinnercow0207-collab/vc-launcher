const bcrypt = require('bcryptjs');
const db = require('./db');

function registerUser(username, password) {
  username = (username || '').trim();
  if (username.length < 3 || username.length > 20) {
    throw new Error('ユーザー名は3〜20文字にしてください');
  }
  if (!password || password.length < 4) {
    throw new Error('パスワードは4文字以上にしてください');
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    throw new Error('そのユーザー名はすでに使われています');
  }
  const hash = bcrypt.hashSync(password, 10);
  // Renderの環境変数 ADMIN_USERNAME に登録したユーザー名と一致する場合、
  // 自動的に管理者権限を付与する
  const isAdmin = process.env.ADMIN_USERNAME && username === process.env.ADMIN_USERNAME ? 1 : 0;
  const info = db.prepare('INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)')
    .run(username, hash, isAdmin);
  return { id: info.lastInsertRowid, username, is_admin: !!isAdmin };
}

function verifyUser(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get((username || '').trim());
  if (!user) throw new Error('ユーザー名またはパスワードが違います');
  const ok = bcrypt.compareSync(password || '', user.password_hash);
  if (!ok) throw new Error('ユーザー名またはパスワードが違います');
  if (user.is_banned) throw new Error('このアカウントは利用停止されています');
  return { id: user.id, username: user.username, is_admin: !!user.is_admin };
}

module.exports = { registerUser, verifyUser };

const { Pool } = require('pg');

// RenderのEnvironmentに DATABASE_URL を設定してください
// 例: postgresql://postgres:あなたのパスワード@db.xxxx.supabase.co:5432/postgres
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabaseへの接続にはSSLが必要
});

async function init() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      is_admin BOOLEAN NOT NULL DEFAULT FALSE,
      is_banned BOOLEAN NOT NULL DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS servers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      invite_code TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS server_members (
      server_id INTEGER NOT NULL REFERENCES servers(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      is_moderator BOOLEAN NOT NULL DEFAULT FALSE,
      PRIMARY KEY (server_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES servers(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text','voice')),
      position INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      channel_id INTEGER NOT NULL REFERENCES channels(id),
      user_id INTEGER NOT NULL REFERENCES users(id),
      content TEXT NOT NULL DEFAULT '',
      attachment_url TEXT,
      attachment_type TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id),
      endpoint TEXT UNIQUE NOT NULL,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
}

async function ensureColumn(table, column, definition) {
  try {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS ${column} ${definition}`);
  } catch (e) {
    // すでにカラムが存在する場合などはここに来る(問題なし)
  }
}

async function migrate() {
  await ensureColumn('users', 'is_admin', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await ensureColumn('users', 'is_banned', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await ensureColumn('server_members', 'is_moderator', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await ensureColumn('channels', 'position', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('servers', 'is_system', 'BOOLEAN NOT NULL DEFAULT FALSE');
  await ensureColumn('users', 'avatar_url', 'TEXT');
}

// 「運営からのお知らせ」サーバーを(無ければ)作成し、指定ユーザーを参加させる。
// 管理者アカウントがまだ存在しない場合は何もしない(その管理者が登録された時に作られる)。
async function ensureSystemServerAndJoin(userId) {
  const crypto = require('crypto');
  let result = await pool.query('SELECT * FROM servers WHERE is_system = TRUE LIMIT 1');
  let sys = result.rows[0];

  if (!sys) {
    const adminResult = await pool.query('SELECT id FROM users WHERE is_admin = TRUE ORDER BY id LIMIT 1');
    const admin = adminResult.rows[0];
    if (!admin) return; // 管理者がまだいないので、あとで作られる

    const inviteCode = crypto.randomBytes(4).toString('hex');
    const srvResult = await pool.query(
      "INSERT INTO servers (name, owner_id, invite_code, is_system) VALUES ('📢 運営からのお知らせ', $1, $2, TRUE) RETURNING *",
      [admin.id, inviteCode]
    );
    sys = srvResult.rows[0];
    await pool.query(
      "INSERT INTO channels (server_id, name, type, position) VALUES ($1, 'お知らせ・要望', 'text', 0)",
      [sys.id]
    );
    // すでに登録済みの全ユーザーもまとめて参加させる
    const allUsers = await pool.query('SELECT id FROM users');
    for (const u of allUsers.rows) {
      await pool.query(
        'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [sys.id, u.id]
      );
    }
  }

  await pool.query(
    'INSERT INTO server_members (server_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
    [sys.id, userId]
  );
}

module.exports = { pool, init, migrate, ensureSystemServerAndJoin };

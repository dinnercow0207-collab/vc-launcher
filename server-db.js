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
      PRIMARY KEY (server_id, user_id)
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS channels (
      id SERIAL PRIMARY KEY,
      server_id INTEGER NOT NULL REFERENCES servers(id),
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('text','voice')),
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
}

module.exports = { pool, init };

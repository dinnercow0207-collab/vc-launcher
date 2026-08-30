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
  await ensureColumn('users', 'points', 'INTEGER NOT NULL DEFAULT 0');
  await ensureColumn('users', 'last_bonus_date', 'DATE');
  await ensureColumn('users', 'equipped_item_id', 'INTEGER');
}

// ---------------- ショップ・ポイント関連 ----------------
async function ensureShopTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS shop_items (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      price INTEGER NOT NULL,
      badge TEXT NOT NULL DEFAULT '✨',
      frame_color TEXT NOT NULL DEFAULT '#7c8cff',
      tier TEXT NOT NULL DEFAULT 'normal',
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `);
  await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS frame_color TEXT NOT NULL DEFAULT '#7c8cff'`);
  await pool.query(`ALTER TABLE shop_items ADD COLUMN IF NOT EXISTS theme_bg TEXT NOT NULL DEFAULT ''`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS user_items (
      user_id INTEGER NOT NULL REFERENCES users(id),
      item_id INTEGER NOT NULL REFERENCES shop_items(id),
      purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (user_id, item_id)
    );
  `);

  // デフォルトのログインボーナス額(未設定なら100pt)
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('daily_bonus_amount', '100') ON CONFLICT (key) DO NOTHING`
  );

  // 初期アイテム(トーク画面の背景+アイコンの枠がセットになった「着せ替えテーマ」)
  const existing = await pool.query('SELECT COUNT(*) AS c FROM shop_items');
  if (Number(existing.rows[0].c) === 0) {
    const trialItems = [
      ['スカイテーマ', 'さわやかな水色でまとめた、お試しの着せ替えテーマ', '🔹', '#5eb4ff', 'linear-gradient(160deg, #0d1a2b, #12203a)'],
      ['サンライズテーマ', 'あたたかいオレンジでまとめた、お試しの着せ替えテーマ', '⭐', '#ffb15e', 'linear-gradient(160deg, #2a1a10, #33200f)'],
      ['ローズテーマ', 'やさしいピンクでまとめた、お試しの着せ替えテーマ', '💗', '#ff6fa5', 'linear-gradient(160deg, #2a1420, #331726)'],
      ['エンバーテーマ', '情熱的な赤でまとめた、お試しの着せ替えテーマ', '🔥', '#ff5e5e', 'linear-gradient(160deg, #2a1212, #341414)'],
      ['クローバーテーマ', '幸運の緑でまとめた、お試しの着せ替えテーマ', '🍀', '#5eda8a', 'linear-gradient(160deg, #0f2418, #12291c)'],
      ['アメジストテーマ', '気品ある紫でまとめた、人気ナンバーワンの着せ替えテーマ', '💜', '#b47bff', 'linear-gradient(160deg, #1e1230, #2a1a42)'],
    ];
    for (const [name, desc, badge, frameColor, themeBg] of trialItems) {
      await pool.query(
        'INSERT INTO shop_items (name, description, price, badge, frame_color, theme_bg, tier) VALUES ($1, $2, 500, $3, $4, $5, $6)',
        [name, desc, badge, frameColor, themeBg, 'trial']
      );
    }
    await pool.query(
      `INSERT INTO shop_items (name, description, price, badge, frame_color, theme_bg, tier)
       VALUES ('完成記念ゴールドテーマ', 'このサイトの完成を記念した、金色に輝く最上級の着せ替えテーマ。トーク画面全体が豪華なゴールドの輝きに包まれ、アイコンの周りもゴールドで縁取られる、特別な存在の証。', 3000, '👑', '#ffd778', 'linear-gradient(160deg, #4a3510, #7a5a18 55%, #4a3510)', 'legendary')`
    );
  }

  // すでに古い「バッジ」「リング」名で入っているアイテムがあれば、新しいテーマ内容に上書きする
  const renameMap = [
    ['シンプルバッジ', 'スカイテーマ', 'さわやかな水色でまとめた、お試しの着せ替えテーマ', '#5eb4ff', 'linear-gradient(160deg, #0d1a2b, #12203a)'],
    ['スターバッジ', 'サンライズテーマ', 'あたたかいオレンジでまとめた、お試しの着せ替えテーマ', '#ffb15e', 'linear-gradient(160deg, #2a1a10, #33200f)'],
    ['ハートバッジ', 'ローズテーマ', 'やさしいピンクでまとめた、お試しの着せ替えテーマ', '#ff6fa5', 'linear-gradient(160deg, #2a1420, #331726)'],
    ['フレイムバッジ', 'エンバーテーマ', '情熱的な赤でまとめた、お試しの着せ替えテーマ', '#ff5e5e', 'linear-gradient(160deg, #2a1212, #341414)'],
    ['クローバーバッジ', 'クローバーテーマ', '幸運の緑でまとめた、お試しの着せ替えテーマ', '#5eda8a', 'linear-gradient(160deg, #0f2418, #12291c)'],
    ['👑 完成記念クラウン', '完成記念ゴールドテーマ', 'このサイトの完成を記念した、金色に輝く最上級の着せ替えテーマ。トーク画面全体が豪華なゴールドの輝きに包まれ、アイコンの周りもゴールドで縁取られる、特別な存在の証。', '#ffd778', 'linear-gradient(160deg, #4a3510, #7a5a18 55%, #4a3510)'],
    ['スカイリング', 'スカイテーマ', 'さわやかな水色でまとめた、お試しの着せ替えテーマ', '#5eb4ff', 'linear-gradient(160deg, #0d1a2b, #12203a)'],
    ['サンライズリング', 'サンライズテーマ', 'あたたかいオレンジでまとめた、お試しの着せ替えテーマ', '#ffb15e', 'linear-gradient(160deg, #2a1a10, #33200f)'],
    ['ローズリング', 'ローズテーマ', 'やさしいピンクでまとめた、お試しの着せ替えテーマ', '#ff6fa5', 'linear-gradient(160deg, #2a1420, #331726)'],
    ['エンバーリング', 'エンバーテーマ', '情熱的な赤でまとめた、お試しの着せ替えテーマ', '#ff5e5e', 'linear-gradient(160deg, #2a1212, #341414)'],
    ['クローバーリング', 'クローバーテーマ', '幸運の緑でまとめた、お試しの着せ替えテーマ', '#5eda8a', 'linear-gradient(160deg, #0f2418, #12291c)'],
    ['完成記念ゴールドリング', '完成記念ゴールドテーマ', 'このサイトの完成を記念した、金色に輝く最上級の着せ替えテーマ。トーク画面全体が豪華なゴールドの輝きに包まれ、アイコンの周りもゴールドで縁取られる、特別な存在の証。', '#ffd778', 'linear-gradient(160deg, #4a3510, #7a5a18 55%, #4a3510)'],
    ['完成記念ゴールドテーマ', '完成記念ゴールドテーマ', 'このサイトの完成を記念した、金色に輝く最上級の着せ替えテーマ。トーク画面全体が豪華なゴールドの輝きに包まれ、アイコンの周りもゴールドで縁取られる、特別な存在の証。', '#ffd778', 'linear-gradient(160deg, #4a3510, #7a5a18 55%, #4a3510)'],
  ];
  for (const [oldName, newName, newDesc, frameColor, themeBg] of renameMap) {
    await pool.query(
      'UPDATE shop_items SET name = $1, description = $2, frame_color = $3, theme_bg = $4 WHERE name = $5',
      [newName, newDesc, frameColor, themeBg, oldName]
    );
  }

  // 紫テーマがまだ無ければ追加する(既存データベース向け)
  const hasAmethyst = await pool.query(`SELECT 1 FROM shop_items WHERE name = 'アメジストテーマ'`);
  if (hasAmethyst.rows.length === 0) {
    await pool.query(
      `INSERT INTO shop_items (name, description, price, badge, frame_color, theme_bg, tier)
       VALUES ('アメジストテーマ', '気品ある紫でまとめた、人気ナンバーワンの着せ替えテーマ', 500, '💜', '#b47bff', 'linear-gradient(160deg, #1e1230, #2a1a42)', 'trial')`
    );
  }
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

module.exports = { pool, init, migrate, ensureSystemServerAndJoin, ensureShopTables };

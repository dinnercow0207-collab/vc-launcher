// ===================================================================
// 管理画面 - クライアント側ロジック
// ===================================================================

let mySuperAdmin = false;

init();

async function init() {
  const meRes = await fetch('/api/me');
  const meData = await meRes.json();
  if (!meData.user) {
    window.location.href = '/login.html';
    return;
  }
  if (!meData.user.is_admin) {
    document.getElementById('deniedBox').style.display = 'block';
    return;
  }
  mySuperAdmin = !!meData.user.is_super_admin;

  document.getElementById('adminBody').style.display = 'block';
  await loadStats();
  await loadUsers();
}

async function loadStats() {
  const res = await fetch('/api/admin/stats');
  if (!res.ok) return;
  const s = await res.json();
  const grid = document.getElementById('statGrid');
  grid.innerHTML = '';
  const items = [
    { label: '登録ユーザー数', num: s.totalUsers },
    { label: '現在オンライン', num: s.onlineUsers },
    { label: 'BAN中のアカウント', num: s.bannedUsers },
    { label: 'サーバー数', num: s.totalServers },
    { label: '総メッセージ数', num: s.totalMessages },
  ];
  items.forEach((it) => {
    const el = document.createElement('div');
    el.className = 'stat-card';
    el.innerHTML = `<div class="num">${it.num}</div><div class="label">${it.label}</div>`;
    grid.appendChild(el);
  });
}

async function loadUsers() {
  const res = await fetch('/api/admin/users');
  if (!res.ok) return;
  const data = await res.json();
  const tbody = document.getElementById('userRows');
  tbody.innerHTML = '';

  data.users.forEach((u) => {
    const tr = document.createElement('tr');

    const badges = [];
    if (u.is_admin) badges.push('<span class="badge admin">管理者</span>');
    if (u.is_banned) badges.push('<span class="badge banned">BAN中</span>');
    else badges.push(u.online ? '<span class="badge online">オンライン</span>' : '<span class="badge offline">オフライン</span>');

    const dateStr = new Date(u.created_at.replace(' ', 'T') + 'Z').toLocaleDateString('ja-JP');

    const actions = [];

    // BAN・BAN解除: 管理者アカウントに対しては特別管理者だけがボタンを使える
    const canModerateThisUser = !u.is_admin || mySuperAdmin;
    if (canModerateThisUser) {
      if (u.is_banned) {
        actions.push(`<button class="row-btn" data-action="unban" data-id="${u.id}">BAN解除</button>`);
      } else {
        actions.push(`<button class="row-btn danger" data-action="ban" data-id="${u.id}">BANする</button>`);
      }
    }

    // 管理者権限の付与・剥奪: 特別管理者のみに表示
    if (mySuperAdmin) {
      if (u.is_admin) {
        actions.push(`<button class="row-btn" data-action="demote" data-id="${u.id}">管理者を外す</button>`);
      } else {
        actions.push(`<button class="row-btn" data-action="promote" data-id="${u.id}">管理者にする</button>`);
      }
    }

    if (actions.length === 0) actions.push('<button class="row-btn" disabled>―</button>');

    tr.innerHTML = `
      <td>${escapeHtml(u.username)}</td>
      <td>${badges.join(' ')}</td>
      <td>${dateStr}</td>
      <td>${actions.join(' ')}</td>
    `;
    tbody.appendChild(tr);
  });

  tbody.querySelectorAll('[data-action]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const id = btn.dataset.id;
      const confirmMessages = {
        ban: 'このユーザーをBANします。よろしいですか？',
        demote: 'この人の管理者権限を外します。よろしいですか？',
        promote: 'この人に管理者権限を付与します。よろしいですか？',
      };
      if (confirmMessages[action] && !confirm(confirmMessages[action])) return;

      btn.disabled = true;
      const res = await fetch(`/api/admin/users/${id}/${action}`, { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        alert(data.error || '操作に失敗しました');
        btn.disabled = false;
        return;
      }
      await loadStats();
      await loadUsers();
    });
  });
}

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

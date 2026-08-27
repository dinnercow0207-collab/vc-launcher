// ===================================================================
// VC Launcher - クライアント側メインロジック
// ===================================================================

let me = null;
let servers = [];
let currentServer = null;
let currentMyRole = null; // 'owner' | 'moderator' | 'member' | null
let channels = [];
let currentTextChannel = null;
let currentVoiceChannel = null;
let socket = null;

// ---- WebRTCまわりの状態 ----
// STUNサーバーは無料の公開サーバーを使用。
// 相手の回線によっては接続できないケースがあるので、
// 本格運用する場合はTURNサーバー(例: metered.ca の無料枠)を
// iceServers に追加してください。
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    // { urls: 'turn:あなたのTURNサーバー', username: '...', credential: '...' },
  ],
};

let localStream = null;       // マイク音声
const peers = new Map();      // socketId -> RTCPeerConnection
const remoteMeta = new Map(); // socketId -> { username, sharingScreen }

// ---- 音声ファイル共有 ----
let audioShareEl = null;      // <audio>要素(再生中のファイル)
let audioShareCtx = null;     // AudioContext
let audioShareTrack = null;   // 送信中の音声トラック

// ---- 添付ファイル(画像・動画) ----
let pendingAttachment = null; // { url, type }

// ---- 未読管理 ----
const unreadChannels = new Set();   // 未読があるチャンネルID
const channelServerMap = {};        // channelId -> serverId (未読をどのサーバーに反映するか判定用)

// ===================================================================
// 初期化
// ===================================================================
init();

async function init() {
  const res = await fetch('/api/me');
  const data = await res.json();
  if (!data.user) {
    window.location.href = '/login.html';
    return;
  }
  me = data.user;
  document.getElementById('meName').textContent = me.username;
  renderMyAvatar();
  if (me.is_admin) {
    document.getElementById('adminLink').style.display = 'block';
  }

  socket = io();

  socket.on('force-disconnect', () => {
    alert('このアカウントは利用停止されました。');
    window.location.href = '/login.html';
  });

  socket.on('chat:message', (msg) => {
    if (msg.server_id) channelServerMap[msg.channel_id] = msg.server_id;

    if (currentTextChannel && msg.channel_id === currentTextChannel.id) {
      appendMessage(msg);
    } else if (msg.user_id !== me.id) {
      unreadChannels.add(msg.channel_id);
      updateUnreadIndicators();
    }
  });

  setupVoiceSocketHandlers();
  bindUI();
  await loadServers();
  await setupPushNotifications();
}

// ===================================================================
// プッシュ通知(Web Push)
// ===================================================================
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
}

async function setupPushNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    return; // このブラウザは非対応(iPadはホーム画面追加時のみ対応)
  }
  try {
    const reg = await navigator.serviceWorker.register('/sw.js');

    const keyRes = await fetch('/api/push/public-key');
    const keyData = await keyRes.json();
    if (!keyData.publicKey) return;

    if (Notification.permission === 'default') {
      await Notification.requestPermission();
    }
    if (Notification.permission !== 'granted') return;

    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(keyData.publicKey),
      });
    }
    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(sub),
    });
  } catch (e) {
    console.log('通知のセットアップをスキップしました:', e.message);
  }
}

// ===================================================================
// サーバー一覧・作成・参加
// ===================================================================
async function loadServers() {
  const res = await fetch('/api/servers');
  const data = await res.json();
  servers = data.servers || [];
  renderServerList();
}

function renderServerList() {
  const list = document.getElementById('serverList');
  list.innerHTML = '';
  servers.forEach((s) => {
    const el = document.createElement('div');
    el.className = 'server-pill' + (currentServer && currentServer.id === s.id ? ' active' : '');
    el.title = `招待コード: ${s.invite_code}`;
    el.innerHTML = `<span>${escapeHtml(s.name)}</span>`;
    if (hasUnreadInServer(s.id)) {
      el.innerHTML += `<span class="unread-dot"></span>`;
    }
    el.addEventListener('click', () => selectServer(s));
    list.appendChild(el);
  });
}

function hasUnreadInServer(serverId) {
  for (const channelId of unreadChannels) {
    if (channelServerMap[channelId] === serverId) return true;
  }
  return false;
}

function updateUnreadIndicators() {
  renderServerList();
  renderChannelLists();
}

async function selectServer(server) {
  currentServer = server;
  leaveCurrentViews();
  renderServerList();

  document.getElementById('channelRail').style.display = 'flex';
  document.getElementById('currentServerName').textContent = server.name;
  document.getElementById('emptyState').style.display = 'flex';
  document.getElementById('emptyState').textContent = `#${server.name} のチャンネルを選んでください`;

  const inviteBox = document.getElementById('inviteCodeBox');
  inviteBox.innerHTML = `<span>招待コード: <span class="code">${escapeHtml(server.invite_code)}</span></span><button id="copyInviteBtn">コピー</button>`;
  document.getElementById('copyInviteBtn').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(server.invite_code);
      const btn = document.getElementById('copyInviteBtn');
      btn.textContent = 'コピーした！';
      setTimeout(() => { btn.textContent = 'コピー'; }, 1500);
    } catch (e) {
      alert(`招待コード: ${server.invite_code}`);
    }
  });

  const res = await fetch(`/api/servers/${server.id}/channels`);
  const data = await res.json();
  channels = data.channels || [];

  try {
    const memRes = await fetch(`/api/servers/${server.id}/members`);
    const memData = await memRes.json();
    currentMyRole = memData.myRole || null;
  } catch (e) {
    currentMyRole = null;
  }

  document.getElementById('deleteServerBtn').style.display = currentMyRole === 'owner' ? 'block' : 'none';

  renderChannelLists();
  setMobileView('channels');
}

function renderChannelLists() {
  const textList = document.getElementById('textChannelList');
  const voiceList = document.getElementById('voiceChannelList');
  textList.innerHTML = '';
  voiceList.innerHTML = '';

  // 「⋮」メニュー自体はメンバー全員に表示(削除は全員可能なため)。名前変更はモーダル側で権限を見て出し分ける
  const isMember = !!currentMyRole;

  channels.filter((c) => c.type === 'text').forEach((c) => {
    if (currentServer) channelServerMap[c.id] = currentServer.id;
    const el = document.createElement('div');
    el.className = 'chan-item' + (currentTextChannel && currentTextChannel.id === c.id ? ' active' : '');
    const unreadDot = unreadChannels.has(c.id) ? '<span class="unread-dot"></span>' : '';
    el.innerHTML = `
      <span class="chan-label"><span class="icon">#</span> ${escapeHtml(c.name)}${unreadDot}</span>
      ${isMember ? `<button type="button" class="chan-menu-btn" data-id="${c.id}" title="操作">⋮</button>` : ''}`;
    el.querySelector('.chan-label').addEventListener('click', () => openTextChannel(c));
    textList.appendChild(el);
  });

  channels.filter((c) => c.type === 'voice').forEach((c) => {
    const el = document.createElement('div');
    el.className = 'chan-item' + (currentVoiceChannel && currentVoiceChannel.id === c.id ? ' active' : '');
    el.innerHTML = `
      <span class="chan-label"><span class="icon">🔊</span> ${escapeHtml(c.name)}</span>
      ${isMember ? `<button type="button" class="chan-menu-btn" data-id="${c.id}" title="操作">⋮</button>` : ''}`;
    el.querySelector('.chan-label').addEventListener('click', () => openVoiceChannel(c));
    voiceList.appendChild(el);
  });

  document.querySelectorAll('.chan-menu-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openChannelActionModal(btn.dataset.id);
    });
  });
}

let channelActionTargetId = null;

function openChannelActionModal(channelId) {
  channelActionTargetId = channelId;
  const canRename = !!currentMyRole; // サーバーのメンバーなら誰でも名前変更できる
  document.getElementById('channelActionRename').style.display = canRename ? 'block' : 'none';
  openModal('channelActionModal');
}

async function refreshChannels() {
  if (!currentServer) return;
  const res = await fetch(`/api/servers/${currentServer.id}/channels`);
  const data = await res.json();
  channels = data.channels || [];
  renderChannelLists();
}

// ===================================================================
// スマホなど小さい画面向けの表示切り替え
// ===================================================================
function setMobileView(view) {
  const root = document.getElementById('appRoot');
  if (root) root.dataset.mobileView = view;
}

// ===================================================================
// テキストチャット
// ===================================================================
async function openTextChannel(channel) {
  if (currentVoiceChannel) leaveVoice();

  if (currentTextChannel) socket.emit('chat:leave', currentTextChannel.id);
  currentTextChannel = channel;
  unreadChannels.delete(channel.id);
  renderChannelLists();
  renderServerList();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('voiceView').style.display = 'none';
  document.getElementById('textView').style.display = 'flex';
  document.getElementById('textChanTitle').textContent = `# ${channel.name}`;
  setMobileView('main');

  socket.emit('chat:join', channel.id);

  const res = await fetch(`/api/channels/${channel.id}/messages`);
  const data = await res.json();
  const scroll = document.getElementById('chatScroll');
  scroll.innerHTML = '';
  (data.messages || []).forEach(appendMessage);
}

function appendMessage(msg) {
  const scroll = document.getElementById('chatScroll');
  const el = document.createElement('div');
  el.className = 'msg';
  const initial = (msg.username || '?').slice(0, 1).toUpperCase();
  const time = formatMessageTime(msg.created_at);

  let attachmentHtml = '';
  if (msg.attachment_url) {
    if (msg.attachment_type === 'video') {
      attachmentHtml = `<div class="attachment"><video src="${escapeHtml(msg.attachment_url)}" controls playsinline></video></div>`;
    } else {
      attachmentHtml = `<div class="attachment"><img src="${escapeHtml(msg.attachment_url)}" alt="添付画像"></div>`;
    }
  }

  const avatarHtml = msg.avatar_url
    ? `<img class="avatar" src="${escapeHtml(msg.avatar_url)}" alt="">`
    : `<div class="avatar">${escapeHtml(initial)}</div>`;

  el.innerHTML = `
    ${avatarHtml}
    <div class="body">
      <div class="meta"><span class="name">${escapeHtml(msg.username)}</span>${time}</div>
      ${msg.content ? `<div class="content">${escapeHtml(msg.content)}</div>` : ''}
      ${attachmentHtml}
    </div>`;
  scroll.appendChild(el);
  scroll.scrollTop = scroll.scrollHeight;
}

// 今日のメッセージは時刻のみ、それ以外は日付も表示して昨日・今日を区別できるようにする
function formatMessageTime(createdAt) {
  const d = new Date(createdAt);
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const timeStr = d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return timeStr;

  const dateStr = d.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
  return `${dateStr} ${timeStr}`;
}

// ===================================================================
// ボイスチャンネル(VC) + 画面共有
// ===================================================================
async function openVoiceChannel(channel) {
  if (currentVoiceChannel && currentVoiceChannel.id === channel.id) return;
  if (currentVoiceChannel) leaveVoice();

  currentVoiceChannel = channel;
  renderChannelLists();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('textView').style.display = 'none';
  document.getElementById('voiceView').style.display = 'flex';
  document.getElementById('voiceChanTitle').textContent = `🔊 ${channel.name}`;
  document.getElementById('voiceStatusText').textContent = 'マイクへのアクセスを許可してください...';
  document.getElementById('voiceMembers').innerHTML = '';
  setMobileView('main');

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    document.getElementById('voiceStatusText').textContent = 'マイクを使用できませんでした。ブラウザの権限設定を確認してください。';
    return;
  }

  addOrUpdateTile(me.id + ':me', me.username, true);
  document.getElementById('voiceStatusText').textContent = '通話中';

  socket.emit('voice:join', channel.id);
}

function leaveVoice() {
  if (!currentVoiceChannel) return;
  socket.emit('voice:leave');

  if (audioShareTrack) stopAudioShare();

  peers.forEach((pc) => pc.close());
  peers.clear();
  remoteMeta.clear();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }

  currentVoiceChannel = null;
  document.getElementById('voiceMembers').innerHTML = '';
  document.getElementById('muteBtn').classList.remove('active');
  renderChannelLists();
}

function leaveCurrentViews() {
  if (currentVoiceChannel) leaveVoice();
  if (currentTextChannel) {
    socket.emit('chat:leave', currentTextChannel.id);
    currentTextChannel = null;
  }
  document.getElementById('textView').style.display = 'none';
  document.getElementById('voiceView').style.display = 'none';
}

function setupVoiceSocketHandlers() {
  socket.on('voice:existing-members', (members) => {
    // 自分が新規参加者側 -> 既存メンバー全員にオファーを送る(自分がinitiator)
    members.forEach(({ socketId, username }) => {
      remoteMeta.set(socketId, { username, sharingScreen: false });
      createPeerConnection(socketId, true);
      addOrUpdateTile(socketId, username, false);
    });
  });

  socket.on('voice:user-joined', ({ socketId, username }) => {
    remoteMeta.set(socketId, { username, sharingScreen: false });
    addOrUpdateTile(socketId, username, false);
    // 相手(新規参加者)側からオファーが飛んでくるのでここでは何もしない
  });

  socket.on('voice:offer', async ({ from, offer, username }) => {
    if (username && !remoteMeta.has(from)) remoteMeta.set(from, { username, sharingScreen: false });
    let pc = peers.get(from);
    if (!pc) {
      pc = createPeerConnection(from, false);
      addOrUpdateTile(from, remoteMeta.get(from)?.username || '通話参加者', false);
    }
    await pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    socket.emit('voice:answer', { to: from, answer });
  });

  socket.on('voice:answer', async ({ from, answer }) => {
    const pc = peers.get(from);
    if (pc) await pc.setRemoteDescription(new RTCSessionDescription(answer));
  });

  socket.on('voice:ice-candidate', async ({ from, candidate }) => {
    const pc = peers.get(from);
    if (pc && candidate) {
      try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e) { /* 無視 */ }
    }
  });

  socket.on('voice:user-left', ({ socketId }) => {
    const pc = peers.get(socketId);
    if (pc) pc.close();
    peers.delete(socketId);
    remoteMeta.delete(socketId);
    const tile = document.getElementById('tile-' + socketId);
    if (tile) tile.remove();
  });

  socket.on('voice:audioshare-start', ({ socketId, label }) => {
    const tile = document.getElementById('tile-' + socketId);
    if (!tile) return;
    let badge = tile.querySelector('.audio-share-badge');
    if (!badge) {
      badge = document.createElement('div');
      badge.className = 'audio-share-badge';
      tile.appendChild(badge);
    }
    badge.textContent = `🎵 ${label || 'ファイル'} を再生中`;
  });

  socket.on('voice:audioshare-stop', ({ socketId }) => {
    const tile = document.getElementById('tile-' + socketId);
    const badge = tile?.querySelector('.audio-share-badge');
    if (badge) badge.remove();
  });
}

function createPeerConnection(remoteSocketId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(remoteSocketId, pc);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }
  if (audioShareTrack) {
    pc.addTrack(audioShareTrack, audioShareTrack._stream || new MediaStream([audioShareTrack]));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      socket.emit('voice:ice-candidate', { to: remoteSocketId, candidate: e.candidate });
    }
  };

  pc.ontrack = (e) => {
    const stream = e.streams[0];
    if (e.track.kind === 'video') {
      attachRemoteVideo(remoteSocketId, stream);
    } else {
      attachRemoteAudio(e.track.id, stream, e.track);
    }
  };

  if (isInitiator) {
    negotiate(pc, remoteSocketId);
  }

  return pc;
}

async function negotiate(pc, remoteSocketId) {
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  socket.emit('voice:offer', { to: remoteSocketId, offer });
}

// ---- 画面まわりのUI ----
function addOrUpdateTile(id, username, isMe) {
  let tile = document.getElementById('tile-' + id);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.className = 'voice-tile';
  tile.id = 'tile-' + id;
  const initial = (username || '?').slice(0, 1).toUpperCase();
  tile.innerHTML = `
    <div class="avatar">${escapeHtml(initial)}</div>
    <div class="name">${escapeHtml(username)}${isMe ? '（あなた）' : ''}</div>`;
  document.getElementById('voiceMembers').appendChild(tile);
  return tile;
}

function attachRemoteAudio(trackId, stream, track) {
  let audioEl = document.getElementById('audio-' + trackId);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = 'audio-' + trackId;
    audioEl.autoplay = true;
    document.body.appendChild(audioEl); // 音声再生用。画面には表示しない
  }
  audioEl.srcObject = stream;
  if (track) {
    track.onended = () => {
      audioEl.remove();
    };
  }
}

function attachRemoteVideo(socketId, stream) {
  const tile = document.getElementById('tile-' + socketId);
  if (!tile) return;
  let video = tile.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true;
    video.playsInline = true;
    tile.appendChild(video);
  }
  video.srcObject = stream;
}

// ---- ミュート ----
function toggleMute() {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  document.getElementById('muteBtn').classList.toggle('active', !track.enabled);
  document.getElementById('muteBtn').textContent = track.enabled ? '🎤 ミュート' : '🔇 ミュート中';
}

// ---- 音声ファイル共有(音楽などをVC相手に流す) ----
function startAudioShare(file) {
  if (audioShareTrack) stopAudioShare();

  audioShareEl = new Audio(URL.createObjectURL(file));
  audioShareEl.loop = false;

  audioShareCtx = new (window.AudioContext || window.webkitAudioContext)();
  const source = audioShareCtx.createMediaElementSource(audioShareEl);
  const dest = audioShareCtx.createMediaStreamDestination();
  source.connect(dest);
  source.connect(audioShareCtx.destination); // 自分にも聞こえるようにする

  audioShareTrack = dest.stream.getAudioTracks()[0];
  audioShareTrack._stream = dest.stream;

  peers.forEach((pc, remoteSocketId) => {
    pc.addTrack(audioShareTrack, dest.stream);
    negotiate(pc, remoteSocketId);
  });

  audioShareEl.play();
  audioShareEl.addEventListener('ended', stopAudioShare);

  const btn = document.getElementById('audioShareBtn');
  btn.classList.add('active');
  btn.textContent = `⏹ 停止 (${file.name})`;

  socket.emit('voice:audioshare-start', { label: file.name });
}

function stopAudioShare() {
  if (!audioShareTrack) return;

  peers.forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track === audioShareTrack);
    if (sender) pc.removeTrack(sender);
  });

  if (audioShareEl) {
    audioShareEl.pause();
    audioShareEl = null;
  }
  if (audioShareCtx) {
    audioShareCtx.close();
    audioShareCtx = null;
  }
  audioShareTrack = null;

  const btn = document.getElementById('audioShareBtn');
  btn.classList.remove('active');
  btn.textContent = '🎵 音声ファイル共有';

  socket.emit('voice:audioshare-stop');
}

// ---- 添付ファイル(画像・動画)のアップロード ----
async function handleFileSelect(file) {
  if (!file) return;
  const preview = document.getElementById('attachPreview');
  preview.style.display = 'flex';
  preview.innerHTML = `アップロード中... (${escapeHtml(file.name)})`;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました');
    pendingAttachment = { url: data.url, type: data.type };
    preview.innerHTML = `<span>📎 ${escapeHtml(file.name)}</span><button type="button" id="removeAttachBtn">✕</button>`;
    document.getElementById('removeAttachBtn').addEventListener('click', () => {
      pendingAttachment = null;
      preview.style.display = 'none';
      preview.innerHTML = '';
      document.getElementById('fileInput').value = '';
    });
  } catch (e) {
    preview.innerHTML = `アップロード失敗: ${escapeHtml(e.message)}`;
    pendingAttachment = null;
  }
}

// ===================================================================
// UIイベント結線
// ===================================================================
// ===================================================================
// プロフィール設定
// ===================================================================
function renderMyAvatar() {
  const img = document.getElementById('meAvatarImg');
  const fallback = document.getElementById('meAvatarInitial');
  if (me.avatar_url) {
    img.src = me.avatar_url;
    img.style.display = 'block';
    fallback.style.display = 'none';
  } else {
    img.style.display = 'none';
    fallback.style.display = 'flex';
    fallback.textContent = (me.username || '?').slice(0, 1).toUpperCase();
  }
}

let pendingAvatarUrl = undefined; // undefined=未変更, null=削除, 文字列=新しいURL

function openProfileModal() {
  document.getElementById('profileUsernameInput').value = me.username;
  document.getElementById('profileCurrentPasswordInput').value = '';
  document.getElementById('profileNewPasswordInput').value = '';
  document.getElementById('profileError').classList.remove('show');
  pendingAvatarUrl = undefined;

  const preview = document.getElementById('profileAvatarPreview');
  const previewFallback = document.getElementById('profileAvatarPreviewFallback');
  if (me.avatar_url) {
    preview.src = me.avatar_url;
    preview.style.display = 'block';
    previewFallback.style.display = 'none';
  } else {
    preview.style.display = 'none';
    previewFallback.style.display = 'flex';
    previewFallback.textContent = (me.username || '?').slice(0, 1).toUpperCase();
  }

  openModal('profileModal');
}

async function handleAvatarSelect(file) {
  if (!file) return;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload', { method: 'POST', body: formData });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'アップロードに失敗しました');
    pendingAvatarUrl = data.url;
    const preview = document.getElementById('profileAvatarPreview');
    document.getElementById('profileAvatarPreviewFallback').style.display = 'none';
    preview.src = data.url;
    preview.style.display = 'block';
  } catch (e) {
    alert('画像のアップロードに失敗しました: ' + e.message);
  }
}

function bindUI() {
  document.getElementById('createServerBtn').addEventListener('click', () => openModal('createModal'));
  document.getElementById('joinServerBtn').addEventListener('click', () => openModal('joinModal'));
  document.getElementById('addChannelBtn').addEventListener('click', () => openModal('channelModal'));

  document.querySelectorAll('[data-close]').forEach((btn) => {
    btn.addEventListener('click', () => closeModal(btn.dataset.close));
  });

  document.getElementById('confirmCreateServer').addEventListener('click', async () => {
    const name = document.getElementById('newServerName').value.trim();
    if (!name) return;
    const res = await fetch('/api/servers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('newServerName').value = '';
      closeModal('createModal');
      await loadServers();
      const created = servers.find((s) => s.id === data.server.id);
      if (created) selectServer(created);
    }
  });

  document.getElementById('confirmJoinServer').addEventListener('click', async () => {
    const code = document.getElementById('inviteCodeInput').value.trim();
    if (!code) return;
    const res = await fetch('/api/servers/join', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ invite_code: code }),
    });
    const data = await res.json();
    if (res.ok) {
      document.getElementById('inviteCodeInput').value = '';
      closeModal('joinModal');
      await loadServers();
      const joined = servers.find((s) => s.id === data.server.id);
      if (joined) selectServer(joined);
    } else {
      alert(data.error || '参加に失敗しました');
    }
  });

  function submitNewChannel(type) {
    const name = document.getElementById('newChannelName').value.trim();
    if (!name || !currentServer) return;
    fetch(`/api/servers/${currentServer.id}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type }),
    }).then(async (res) => {
      if (res.ok) {
        document.getElementById('newChannelName').value = '';
        const r2 = await fetch(`/api/servers/${currentServer.id}/channels`);
        const d2 = await r2.json();
        channels = d2.channels || [];
        renderChannelLists();
      }
    });
  }
  document.getElementById('typeText').addEventListener('click', () => submitNewChannel('text'));
  document.getElementById('typeVoice').addEventListener('click', () => submitNewChannel('voice'));

  document.getElementById('channelActionRename').addEventListener('click', async () => {
    const channelId = channelActionTargetId;
    if (!channelId) return;
    const target = channels.find((c) => String(c.id) === String(channelId));
    const newName = prompt('新しいチャンネル名を入力してください', target?.name || '');
    closeModal('channelActionModal');
    if (!newName || !newName.trim()) return;
    const res = await fetch(`/api/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newName.trim() }),
    });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '変更に失敗しました'); return; }
    await refreshChannels();
  });

  document.getElementById('channelActionDelete').addEventListener('click', async () => {
    const channelId = channelActionTargetId;
    closeModal('channelActionModal');
    if (!channelId) return;
    if (!confirm('このチャンネルを削除します。よろしいですか？(中のメッセージも消えます)')) return;
    const res = await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '削除に失敗しました'); return; }
    if (currentTextChannel && String(currentTextChannel.id) === String(channelId)) {
      currentTextChannel = null;
      document.getElementById('textView').style.display = 'none';
      document.getElementById('emptyState').style.display = 'flex';
    }
    if (currentVoiceChannel && String(currentVoiceChannel.id) === String(channelId)) {
      leaveVoice();
      document.getElementById('emptyState').style.display = 'flex';
    }
    await refreshChannels();
  });

  document.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const content = input.value.trim();
    if ((!content && !pendingAttachment) || !currentTextChannel) return;
    socket.emit('chat:send', {
      channelId: currentTextChannel.id,
      content,
      attachmentUrl: pendingAttachment?.url,
      attachmentType: pendingAttachment?.type,
    });
    input.value = '';
    pendingAttachment = null;
    document.getElementById('attachPreview').style.display = 'none';
    document.getElementById('attachPreview').innerHTML = '';
    document.getElementById('fileInput').value = '';
  });

  document.getElementById('fileInput').addEventListener('change', (e) => {
    handleFileSelect(e.target.files[0]);
  });

  document.getElementById('muteBtn').addEventListener('click', toggleMute);
  document.getElementById('leaveVoiceBtn').addEventListener('click', leaveVoice);

  document.getElementById('audioShareBtn').addEventListener('click', () => {
    if (audioShareTrack) {
      stopAudioShare();
    } else {
      document.getElementById('audioFileInput').click();
    }
  });
  document.getElementById('audioFileInput').addEventListener('change', (e) => {
    if (e.target.files[0]) startAudioShare(e.target.files[0]);
    e.target.value = '';
  });

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });

  document.getElementById('meInfoBtn').addEventListener('click', openProfileModal);

  document.getElementById('profileAvatarInput').addEventListener('change', (e) => {
    handleAvatarSelect(e.target.files[0]);
  });

  document.getElementById('profileSaveBtn').addEventListener('click', async () => {
    const errBox = document.getElementById('profileError');
    errBox.classList.remove('show');

    const newUsername = document.getElementById('profileUsernameInput').value.trim();
    const currentPassword = document.getElementById('profileCurrentPasswordInput').value;
    const newPassword = document.getElementById('profileNewPasswordInput').value;

    if (!currentPassword) {
      errBox.textContent = '現在のパスワードを入力してください';
      errBox.classList.add('show');
      return;
    }

    const body = { newUsername, currentPassword };
    if (newPassword) body.newPassword = newPassword;
    if (pendingAvatarUrl !== undefined) body.avatarUrl = pendingAvatarUrl;

    const res = await fetch('/api/me/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      errBox.textContent = data.error || '更新に失敗しました';
      errBox.classList.add('show');
      return;
    }

    me.username = data.username;
    if (data.avatar_url !== undefined) me.avatar_url = data.avatar_url;
    document.getElementById('meName').textContent = me.username;
    renderMyAvatar();
    closeModal('profileModal');
  });

  // スマホ向け: 戻るボタン
  document.getElementById('backToServersBtn').addEventListener('click', () => {
    setMobileView('servers');
  });
  document.getElementById('backToChannelsBtnText').addEventListener('click', () => {
    setMobileView('channels');
  });
  document.getElementById('backToChannelsBtnVoice').addEventListener('click', () => {
    setMobileView('channels');
  });

  // サーバーの削除(作成者のみボタンが表示される)
  document.getElementById('deleteServerBtn').addEventListener('click', async () => {
    if (!currentServer) return;
    if (!confirm(`「${currentServer.name}」を削除します。中のチャンネル・メッセージも全て消えます。よろしいですか？`)) return;
    const res = await fetch(`/api/servers/${currentServer.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) { alert(data.error || '削除に失敗しました'); return; }

    servers = servers.filter((s) => s.id !== currentServer.id);
    currentServer = null;
    leaveCurrentViews();
    document.getElementById('channelRail').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('emptyState').textContent = '左のサーバー一覧から選ぶか、新しいサーバーを作ってはじめましょう。';
    renderServerList();
    setMobileView('servers');
  });
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

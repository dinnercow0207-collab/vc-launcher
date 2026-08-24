// ===================================================================
// VC Launcher - クライアント側メインロジック
// ===================================================================

let me = null;
let servers = [];
let currentServer = null;
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
let screenStream = null;      // 画面共有中の映像
const peers = new Map();      // socketId -> RTCPeerConnection
const remoteMeta = new Map(); // socketId -> { username, sharingScreen }

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
  if (me.is_admin) {
    document.getElementById('adminLink').style.display = 'block';
  }

  socket = io();

  socket.on('force-disconnect', () => {
    alert('このアカウントは利用停止されました。');
    window.location.href = '/login.html';
  });

  socket.on('chat:message', (msg) => {
    if (currentTextChannel && msg.channel_id === currentTextChannel.id) {
      appendMessage(msg);
    }
  });

  setupVoiceSocketHandlers();
  bindUI();
  await loadServers();
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
    el.textContent = s.name;
    el.title = `招待コード: ${s.invite_code}`;
    el.addEventListener('click', () => selectServer(s));
    list.appendChild(el);
  });
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
  renderChannelLists();
}

function renderChannelLists() {
  const textList = document.getElementById('textChannelList');
  const voiceList = document.getElementById('voiceChannelList');
  textList.innerHTML = '';
  voiceList.innerHTML = '';

  channels.filter((c) => c.type === 'text').forEach((c) => {
    const el = document.createElement('div');
    el.className = 'chan-item' + (currentTextChannel && currentTextChannel.id === c.id ? ' active' : '');
    el.innerHTML = `<span class="icon">#</span> ${escapeHtml(c.name)}`;
    el.addEventListener('click', () => openTextChannel(c));
    textList.appendChild(el);
  });

  channels.filter((c) => c.type === 'voice').forEach((c) => {
    const el = document.createElement('div');
    el.className = 'chan-item' + (currentVoiceChannel && currentVoiceChannel.id === c.id ? ' active' : '');
    el.innerHTML = `<span class="icon">🔊</span> ${escapeHtml(c.name)}`;
    el.addEventListener('click', () => openVoiceChannel(c));
    voiceList.appendChild(el);
  });
}

// ===================================================================
// テキストチャット
// ===================================================================
async function openTextChannel(channel) {
  if (currentVoiceChannel) leaveVoice();

  if (currentTextChannel) socket.emit('chat:leave', currentTextChannel.id);
  currentTextChannel = channel;
  renderChannelLists();

  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('voiceView').style.display = 'none';
  document.getElementById('textView').style.display = 'flex';
  document.getElementById('textChanTitle').textContent = `# ${channel.name}`;

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
  const time = new Date(msg.created_at).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  el.innerHTML = `
    <div class="avatar">${escapeHtml(initial)}</div>
    <div class="body">
      <div class="meta"><span class="name">${escapeHtml(msg.username)}</span>${time}</div>
      <div class="content">${escapeHtml(msg.content)}</div>
    </div>`;
  scroll.appendChild(el);
  scroll.scrollTop = scroll.scrollHeight;
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

  peers.forEach((pc) => pc.close());
  peers.clear();
  remoteMeta.clear();

  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (screenStream) {
    screenStream.getTracks().forEach((t) => t.stop());
    screenStream = null;
  }

  currentVoiceChannel = null;
  document.getElementById('voiceMembers').innerHTML = '';
  document.getElementById('shareBtn').classList.remove('active');
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

  socket.on('voice:screen-share-start', ({ socketId }) => {
    const meta = remoteMeta.get(socketId);
    if (meta) meta.sharingScreen = true;
  });

  socket.on('voice:screen-share-stop', ({ socketId }) => {
    const meta = remoteMeta.get(socketId);
    if (meta) meta.sharingScreen = false;
    const tile = document.getElementById('tile-' + socketId);
    const video = tile?.querySelector('video');
    if (video) video.remove();
  });
}

function createPeerConnection(remoteSocketId, isInitiator) {
  const pc = new RTCPeerConnection(ICE_SERVERS);
  peers.set(remoteSocketId, pc);

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
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
      attachRemoteAudio(remoteSocketId, stream);
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

function attachRemoteAudio(socketId, stream) {
  let audioEl = document.getElementById('audio-' + socketId);
  if (!audioEl) {
    audioEl = document.createElement('audio');
    audioEl.id = 'audio-' + socketId;
    audioEl.autoplay = true;
    document.body.appendChild(audioEl); // 音声再生用。画面には表示しない
  }
  audioEl.srcObject = stream;
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

// ---- 画面共有 ----
async function toggleScreenShare() {
  if (screenStream) {
    stopScreenShare();
    return;
  }

  if (!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia) {
    alert('このブラウザ／端末は画面共有(getDisplayMedia)に対応していません。\niPadの場合は「設定 > Safari > 詳細 > Feature Flags」に「Screen Capture」という項目があれば有効にしてから試してください。');
    return;
  }

  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch (e) {
    if (e.name !== 'NotAllowedError') {
      // ユーザーが単にキャンセルした場合(NotAllowedError)は何も表示しない
      alert('画面共有を開始できませんでした: ' + (e.message || e.name));
    }
    return;
  }
  const screenTrack = screenStream.getVideoTracks()[0];
  screenTrack.onended = () => stopScreenShare();

  peers.forEach((pc, remoteSocketId) => {
    pc.addTrack(screenTrack, screenStream);
    negotiate(pc, remoteSocketId);
  });

  // 自分のプレビューも表示
  attachRemoteVideo(me.id + ':me', screenStream);
  document.getElementById('shareBtn').classList.add('active');
  socket.emit('voice:screen-share-start');
}

function stopScreenShare() {
  if (!screenStream) return;
  const screenTrack = screenStream.getVideoTracks()[0];

  peers.forEach((pc) => {
    const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
    if (sender) pc.removeTrack(sender);
  });

  screenStream.getTracks().forEach((t) => t.stop());
  screenStream = null;

  const myTile = document.getElementById('tile-' + me.id + ':me');
  const myVideo = myTile?.querySelector('video');
  if (myVideo) myVideo.remove();

  document.getElementById('shareBtn').classList.remove('active');
  socket.emit('voice:screen-share-stop');
}

// ===================================================================
// UIイベント結線
// ===================================================================
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

  document.getElementById('chatForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('chatInput');
    const content = input.value.trim();
    if (!content || !currentTextChannel) return;
    socket.emit('chat:send', { channelId: currentTextChannel.id, content });
    input.value = '';
  });

  document.getElementById('muteBtn').addEventListener('click', toggleMute);
  document.getElementById('shareBtn').addEventListener('click', toggleScreenShare);
  document.getElementById('leaveVoiceBtn').addEventListener('click', leaveVoice);

  document.getElementById('logoutBtn').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = '/login.html';
  });
}

function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

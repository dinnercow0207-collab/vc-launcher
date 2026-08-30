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
  renderMyPoints();
  applyMyTheme();
  if (me.is_admin) {
    document.getElementById('adminLink').style.display = 'block';
  }

  if (data.dailyBonus && data.dailyBonus.granted) {
    document.getElementById('bonusToastAmount').textContent = `+${data.dailyBonus.amount} pt`;
    document.getElementById('bonusToast').style.display = 'flex';
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

  // サーバーを切り替えてもVCは継続する(テキストチャットの購読だけ整理する)
  if (currentTextChannel) {
    socket.emit('chat:leave', currentTextChannel.id);
    currentTextChannel = null;
  }
  document.getElementById('textView').style.display = 'none';
  if (!currentVoiceChannel) {
    document.getElementById('voiceView').style.display = 'none';
  }

  renderServerList();

  document.getElementById('channelRail').style.display = 'flex';
  document.getElementById('currentServerName').textContent = server.name;
  if (!currentVoiceChannel) {
    document.getElementById('emptyState').style.display = 'flex';
    document.getElementById('emptyState').textContent = `#${server.name} のチャンネルを選んでください`;
  } else {
    document.getElementById('emptyState').style.display = 'none';
  }
  updateCallBar();

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
  // VC中でもテキストチャンネルの閲覧はできるようにする(通話は裏で継続)
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
  updateCallBar();

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
  const isMine = me && msg.user_id === me.id;
  el.className = 'msg' + (isMine ? ' mine' : '');
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

  const frameClass = msg.frame_color ? ' framed-avatar' : '';
  const frameStyle = msg.frame_color ? ` style="--frame-color: ${escapeHtml(msg.frame_color)};"` : '';
  const avatarHtml = msg.avatar_url
    ? `<img class="avatar${frameClass}"${frameStyle} src="${escapeHtml(msg.avatar_url)}" alt="">`
    : `<div class="avatar${frameClass}"${frameStyle}>${escapeHtml(initial)}</div>`;

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
  if (currentVoiceChannel && currentVoiceChannel.id === channel.id) {
    // すでにこのVCに入っている場合は、通話はそのままに画面だけ切り替える
    showVoiceView(channel);
    return;
  }
  if (currentVoiceChannel) leaveVoice(); // 別のVCに移る場合は今の通話を退出

  currentVoiceChannel = channel;
  renderChannelLists();
  showVoiceView(channel);
  document.getElementById('voiceStatusText').textContent = 'マイクへのアクセスを許可してください...';
  document.getElementById('voiceMembers').innerHTML = '';

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    document.getElementById('voiceStatusText').textContent = 'マイクを使用できませんでした。ブラウザの権限設定を確認してください。';
    return;
  }

  addOrUpdateTile(me.id + ':me', me.username, true, me.frame_color, me.avatar_url);
  document.getElementById('voiceStatusText').textContent = '通話中';

  socket.emit('voice:join', channel.id);
}

// VC画面を前面に表示する(通話の開始・終了は行わない)
function showVoiceView(channel) {
  document.getElementById('emptyState').style.display = 'none';
  document.getElementById('textView').style.display = 'none';
  document.getElementById('voiceView').style.display = 'flex';
  document.getElementById('voiceChanTitle').textContent = `🔊 ${channel.name}`;
  setMobileView('main');
  updateCallBar();
}

// テキスト画面などを見ている間、VC中であることを知らせる通話中バーの表示を更新する
function updateCallBar() {
  const bar = document.getElementById('callBar');
  const voiceViewVisible = document.getElementById('voiceView').style.display === 'flex';
  if (currentVoiceChannel && !voiceViewVisible) {
    bar.style.display = 'flex';
    document.getElementById('callBarText').textContent = `🔊 ${currentVoiceChannel.name} で通話中`;
  } else {
    bar.style.display = 'none';
  }
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
  updateCallBar();

  // どのテキストチャンネルも開いていなければ、VC画面を閉じて空状態に戻す
  if (!currentTextChannel) {
    document.getElementById('voiceView').style.display = 'none';
    document.getElementById('emptyState').style.display = 'flex';
  }
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
    members.forEach(({ socketId, username, frameColor, avatarUrl }) => {
      remoteMeta.set(socketId, { username, sharingScreen: false, frameColor, avatarUrl });
      createPeerConnection(socketId, true);
      addOrUpdateTile(socketId, username, false, frameColor, avatarUrl);
    });
  });

  socket.on('voice:user-joined', ({ socketId, username, frameColor, avatarUrl }) => {
    remoteMeta.set(socketId, { username, sharingScreen: false, frameColor, avatarUrl });
    addOrUpdateTile(socketId, username, false, frameColor, avatarUrl);
    // 相手(新規参加者)側からオファーが飛んでくるのでここでは何もしない
  });

  socket.on('voice:offer', async ({ from, offer, username }) => {
    if (username && !remoteMeta.has(from)) remoteMeta.set(from, { username, sharingScreen: false });
    let pc = peers.get(from);
    if (!pc) {
      pc = createPeerConnection(from, false);
      const meta = remoteMeta.get(from);
      addOrUpdateTile(from, meta?.username || '通話参加者', false, meta?.frameColor, meta?.avatarUrl);
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

  socket.on('voice:appearance-updated', ({ socketId, frameColor, avatarUrl }) => {
    const meta = remoteMeta.get(socketId);
    if (meta) {
      meta.frameColor = frameColor;
      meta.avatarUrl = avatarUrl;
    }
    const tile = document.getElementById('tile-' + socketId);
    if (!tile) return;
    let avatarEl = tile.querySelector('.avatar');
    if (avatarUrl) {
      if (avatarEl.tagName !== 'IMG') {
        const img = document.createElement('img');
        img.className = 'avatar';
        avatarEl.replaceWith(img);
        avatarEl = img;
      }
      avatarEl.src = avatarUrl;
    }
    avatarEl.classList.toggle('framed-avatar', !!frameColor);
    avatarEl.setAttribute('style', frameColor ? `--frame-color: ${frameColor};` : '');
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
function addOrUpdateTile(id, username, isMe, frameColor, avatarUrl) {
  let tile = document.getElementById('tile-' + id);
  if (tile) return tile;
  tile = document.createElement('div');
  tile.className = 'voice-tile';
  tile.id = 'tile-' + id;
  const initial = (username || '?').slice(0, 1).toUpperCase();
  const frameClass = frameColor ? ' framed-avatar' : '';
  const frameStyle = frameColor ? ` style="--frame-color: ${escapeHtml(frameColor)};"` : '';
  const avatarHtml = avatarUrl
    ? `<img class="avatar${frameClass}"${frameStyle} src="${escapeHtml(avatarUrl)}" alt="">`
    : `<div class="avatar${frameClass}"${frameStyle}>${escapeHtml(initial)}</div>`;
  tile.innerHTML = `
    ${avatarHtml}
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
  const hasFrame = !!me.frame_color;
  if (me.avatar_url) {
    img.src = me.avatar_url;
    img.style.display = 'block';
    img.classList.toggle('framed-avatar', hasFrame);
    img.style.setProperty('--frame-color', me.frame_color || '');
    fallback.style.display = 'none';
  } else {
    img.style.display = 'none';
    fallback.style.display = 'flex';
    fallback.classList.toggle('framed-avatar', hasFrame);
    fallback.style.setProperty('--frame-color', me.frame_color || '');
    fallback.textContent = (me.username || '?').slice(0, 1).toUpperCase();
  }
}

function renderMyPoints() {
  document.getElementById('myPointsText').textContent = me.points ?? 0;
}

// 装着中の着せ替えテーマを、自分のトーク画面の背景に反映する(自分にだけ見える)
function applyMyTheme() {
  const mainPanel = document.querySelector('.main-panel');
  if (!mainPanel) return;
  mainPanel.style.background = me.theme_bg || '';

  // チャット欄・VC欄の個別背景は消して、main-panel全体の背景がそのまま透けて見えるようにする
  const scroll = document.getElementById('chatScroll');
  if (scroll) scroll.style.background = 'transparent';
  const voicePanel = document.querySelector('.voice-panel');
  if (voicePanel) voicePanel.style.background = 'transparent';
}

// ===================================================================
// ショップ
// ===================================================================
async function openShop() {
  openModal('shopModal');
  const res = await fetch('/api/shop/items');
  const data = await res.json();
  me.points = data.myPoints;
  renderMyPoints();
  document.getElementById('shopMyPoints').textContent = data.myPoints;

  const list = document.getElementById('shopItemList');
  list.innerHTML = '';
  data.items.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'shop-item' + (item.tier === 'legendary' ? ' legendary' : '');

    let actionsHtml = '';
    if (item.owned) {
      const equipped = data.equippedItemId === item.id;
      actionsHtml = `<button class="secondary" data-action="${equipped ? 'unequip' : 'equip'}" data-id="${item.id}">${equipped ? '装着中' : '装着する'}</button>`;
    } else {
      const canAfford = data.myPoints >= item.price;
      actionsHtml = `<button data-action="buy" data-id="${item.id}" ${canAfford ? '' : 'disabled'}>購入</button>`;
    }

    const priceEditHtml = me.is_super_admin
      ? `<div class="shop-price-edit">
           <input type="number" min="0" value="${item.price}" data-price-input="${item.id}">
           <button class="row-btn" data-action="save-price" data-id="${item.id}">価格を保存</button>
         </div>`
      : '';

    el.innerHTML = `
      <div class="shop-theme-preview" style="background:${item.theme_bg || 'var(--bg-2)'};">
        <span class="shop-theme-preview-ring framed-avatar" style="--frame-color: ${item.frame_color};">${item.badge}</span>
      </div>
      <div class="shop-item-info">
        <div class="shop-item-name">${escapeHtml(item.name)}</div>
        <div class="shop-item-desc">${escapeHtml(item.description)}</div>
        <div class="shop-item-price">🪙 ${item.price} pt${item.owned ? ' ・所持済み' : ''}</div>
        ${priceEditHtml}
      </div>
      <div class="shop-item-actions">${actionsHtml}</div>`;
    list.appendChild(el);
  });

  list.querySelectorAll('[data-action="save-price"]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const input = list.querySelector(`[data-price-input="${id}"]`);
      const price = parseInt(input.value, 10);
      if (isNaN(price) || price < 0) { alert('正しい価格を入力してください'); return; }
      btn.disabled = true;
      const res = await fetch(`/api/admin/shop/items/${id}/price`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ price }),
      });
      const d = await res.json();
      btn.disabled = false;
      if (!res.ok) { alert(d.error || '保存に失敗しました'); return; }
      await openShop();
    });
  });

  list.querySelectorAll('[data-action]:not([data-action="save-price"])').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const action = btn.dataset.action;
      const itemId = btn.dataset.id;
      btn.disabled = true;
      if (action === 'buy') {
        const res = await fetch('/api/shop/purchase', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId }),
        });
        const d = await res.json();
        if (!res.ok) { alert(d.error || '購入に失敗しました'); btn.disabled = false; return; }
      } else if (action === 'equip') {
        await fetch('/api/shop/equip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId }),
        });
        const equippedItem = data.items.find((it) => String(it.id) === String(itemId));
        me.equipped_item_id = itemId;
        me.frame_color = equippedItem?.frame_color || null;
        me.theme_bg = equippedItem?.theme_bg || null;
      } else if (action === 'unequip') {
        await fetch('/api/shop/equip', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ itemId: null }),
        });
        me.equipped_item_id = null;
        me.frame_color = null;
        me.theme_bg = null;
      }
      applyMyTheme();
      socket.emit('profile:refresh'); // 他の人から見える自分の見た目もすぐ反映させる

      // VC中なら、自分のタイルの枠色もその場で更新する
      if (currentVoiceChannel) {
        const myTile = document.getElementById('tile-' + me.id + ':me');
        const myAvatarEl = myTile?.querySelector('.avatar');
        if (myAvatarEl) {
          myAvatarEl.classList.toggle('framed-avatar', !!me.frame_color);
          myAvatarEl.setAttribute('style', me.frame_color ? `--frame-color: ${me.frame_color};` : '');
        }
      }

      await openShop(); // 表示をまるごと更新
    });
  });
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

  document.getElementById('openShopBtn').addEventListener('click', openShop);
  document.getElementById('bonusToastCloseBtn').addEventListener('click', () => {
    document.getElementById('bonusToast').style.display = 'none';
  });

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
    socket.emit('profile:refresh'); // アイコン変更を他の人からも見えるように
    closeModal('profileModal');
  });

  // スマホ向け: 戻るボタン
  // 通話中バー(テキストを見ながらVC継続中に表示)
  document.getElementById('callBarReturnBtn').addEventListener('click', () => {
    if (currentVoiceChannel) showVoiceView(currentVoiceChannel);
  });
  document.getElementById('callBarLeaveBtn').addEventListener('click', () => {
    leaveVoice();
  });

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

// VC Launcher サービスワーカー
// プッシュ通知の受信・表示と、通知タップ時の画面フォーカスを担当します。

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('push', (event) => {
  let data = { title: 'VC Launcher', body: '新しいメッセージがあります' };
  try {
    if (event.data) data = event.data.json();
  } catch (e) {
    // JSONでなければそのままテキストとして扱う
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title || 'VC Launcher', {
      body: data.body || '',
      icon: '/icon.png',
      badge: '/icon.png',
      data: { channelId: data.channelId || null },
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clientList) => {
      for (const client of clientList) {
        if (client.url.includes('/app.html') && 'focus' in client) {
          return client.focus();
        }
      }
      if (self.clients.openWindow) {
        return self.clients.openWindow('/app.html');
      }
    })
  );
});

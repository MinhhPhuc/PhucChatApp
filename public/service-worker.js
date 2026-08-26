self.addEventListener('push', event => {
  let payload = {
    title: 'PhucChatApp',
    body: 'Bạn có thông báo mới',
    data: {}
  };

  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (error) {
    console.error('Push payload parse error:', error);
  }

  const title = payload.title || 'PhucChatApp';
  const options = {
    body: payload.body || 'Bạn có thông báo mới',
    tag: payload.notificationId || `${payload.type || 'notification'}-${Date.now()}`,
    renotify: true,
    data: payload.data || {},
    vibrate: [100, 50, 100]
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();

  event.waitUntil((async () => {
    const targetUrl = '/';
    const clients = await self.clients.matchAll({
      type: 'window',
      includeUncontrolled: true
    });

    for (const client of clients) {
      if ('focus' in client) {
        try {
          await client.focus();
          if ('navigate' in client && client.url !== targetUrl) {
            await client.navigate(targetUrl);
          }
          return;
        } catch (_) {}
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(targetUrl);
    }
  })());
});

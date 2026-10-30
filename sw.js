// Service worker : reçoit les notifications de rappel. Pas de cache hors ligne
// (les fichiers sont toujours lus sur le réseau, comme avant).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch (err) { data = { title: e.data ? e.data.text() : '' }; }
  const url = new URL(data.url || './#reviser', self.registration.scope).href;
  e.waitUntil(self.registration.showNotification(data.title || 'Flashcards prépa', {
    body: data.body || '',
    tag: data.tag || 'flashcards',
    icon: 'icons/icon-192.png?v=2',
    badge: 'icons/icon-192.png?v=2',
    data: { url },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || self.registration.scope;
  e.waitUntil((async () => {
    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const c of list) {
      if (c.url.startsWith(self.registration.scope) && 'focus' in c) {
        await c.focus();
        if ('navigate' in c) return c.navigate(url).catch(() => {});
        return;
      }
    }
    return self.clients.openWindow(url);
  })());
});

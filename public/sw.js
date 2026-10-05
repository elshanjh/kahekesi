// Kahekesi service worker: shows push notifications and opens the app when one is tapped.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let p = {};
  try { p = e.data ? e.data.json() : {}; } catch (x) { p = {data: {body: e.data && e.data.text()}}; }
  const d = p.data || p.notification || p;
  e.waitUntil(self.registration.showNotification(d.title || 'Kahekesi', {
    body: d.body || '',
    tag: d.tag || undefined,
    renotify: !!d.tag,
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png',
    data: {url: d.url || '/'},
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({type: 'window', includeUncontrolled: true}).then(list => {
    for (const c of list) {
      if (c.url.startsWith(self.location.origin) && 'focus' in c) {
        return c.focus().then(w => (w && 'navigate' in w ? w.navigate(url) : w)).catch(() => {});
      }
    }
    return self.clients.openWindow(url);
  }));
});

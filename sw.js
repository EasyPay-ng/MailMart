// MailMart notification worker.
//
// This does two jobs and nothing else:
//   1. Lets Android Chrome show a notification at all. Android refuses
//      `new Notification(...)` from a page; it only accepts
//      registration.showNotification(...).
//   2. Opens the orders page when a notification is tapped, reusing an open
//      MailMart tab when there is one.
//
// It is not an offline cache. There is no precache list, no fetch handler and
// no background sync: MailMart has no server to push anything, so the page
// that is open is what notices an order change (see js/notifications.js).

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();

  const target = new URL(
    (event.notification.data && event.notification.data.url) || "orders.html",
    self.location.origin
  ).href;

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (!client.url.startsWith(self.location.origin)) continue;
      await client.focus();
      if ("navigate" in client) {
        try { await client.navigate(target); } catch { /* cross-origin, ignore */ }
      }
      return;
    }
    await self.clients.openWindow(target);
  })());
});

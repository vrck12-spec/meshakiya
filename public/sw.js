// Service worker מינימלי — נדרש כדי שהדפדפן יאפשר התקנה כאפליקציה.
// לא שומר דבר במטמון: כל הבקשות הולכות לרשת, כך שהנתונים תמיד עדכניים.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (e) => {
  if (e.request.mode === 'navigate') e.respondWith(fetch(e.request));
});

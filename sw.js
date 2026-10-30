// 最小限のService Worker（PWA化用）
// 中身が空の fetch ハンドラは警告の原因になるため書いていません
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

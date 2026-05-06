// PWA에서 새로고침/오프라인 진입 시 최소 화면을 보여주기 위한 서비스 워커.
const CACHE_NAME = 'hybrid-horse-race-v2'
const APP_SHELL_PATHS = ['/', '/index.html']

self.addEventListener('install', (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_SHELL_PATHS)
    })
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames.map((cacheName) => {
          if (cacheName !== CACHE_NAME) {
            return caches.delete(cacheName)
          }
          return Promise.resolve(false)
        })
      )
    ).then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const { request } = event
  const requestUrl = new URL(request.url)
  const isSameOrigin = requestUrl.origin === self.location.origin

  // Firebase Functions 같은 외부 요청은 캐시하면 실시간 상태가 낡아질 수 있어 그대로 통과시킨다.
  if (!isSameOrigin || request.method !== 'GET') {
    return
  }

  const isNavigationRequest = request.mode === 'navigate'
  const acceptsHtml = request.headers.get('accept')?.includes('text/html') ?? false

  if (isNavigationRequest || acceptsHtml) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          const responseToCache = networkResponse.clone()
          caches.open(CACHE_NAME).then((cache) => {
            cache.put('/index.html', responseToCache)
          })
          return networkResponse
        })
        .catch(() => caches.match('/index.html'))
    )
    return
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        return cachedResponse
      }

      return fetch(request).then((networkResponse) => {
        const responseToCache = networkResponse.clone()
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, responseToCache)
        })
        return networkResponse
      })
    })
  )
})

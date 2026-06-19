const coepCredentialless = false;
const runtimeCacheName = "local-media-converter-runtime-v1";

const cacheableHosts = new Set([
  self.location.host,
  "unpkg.com",
  "huggingface.co",
  "cdn-lfs.huggingface.co",
]);

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(runtimeCacheName)
      .then((cache) => cache.addAll(["./"]).catch(() => undefined)),
  );
  self.skipWaiting();
});
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);

self.addEventListener("message", (event) => {
  if (event.data === "deregister") {
    self.registration
      .unregister()
      .then(() => self.clients.matchAll())
      .then((clients) => {
        clients.forEach((client) => client.navigate(client.url));
      });
  }
});

self.addEventListener("fetch", (event) => {
  if (
    event.request.cache === "only-if-cached" &&
    event.request.mode !== "same-origin"
  ) {
    return;
  }

  event.respondWith(handleRequest(event.request));
});

async function handleRequest(request) {
  const cacheable = isCacheable(request);
  const cache = cacheable ? await caches.open(runtimeCacheName) : null;
  const cached = cache ? await cache.match(request) : undefined;

  if (cached && shouldPreferCache(request)) {
    return addIsolationHeaders(cached);
  }

  try {
    const response = await fetch(request);
    const isolated = addIsolationHeaders(response);

    if (cache && response.ok) {
      cache.put(request, isolated.clone()).catch(() => undefined);
    }

    return isolated;
  } catch (error) {
    if (cached) {
      return addIsolationHeaders(cached);
    }

    console.error("[coi-serviceworker] fetch failed", error);
    throw error;
  }
}

function addIsolationHeaders(response) {
  if (response.status === 0) {
    return response;
  }

  const headers = new Headers(response.headers);
  headers.set("Cross-Origin-Opener-Policy", "same-origin");
  headers.set(
    "Cross-Origin-Embedder-Policy",
    coepCredentialless ? "credentialless" : "require-corp",
  );

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function isCacheable(request) {
  if (request.method !== "GET" || request.headers.has("range")) {
    return false;
  }

  const url = new URL(request.url);
  return cacheableHosts.has(url.host);
}

function shouldPreferCache(request) {
  const url = new URL(request.url);
  return (
    url.host !== self.location.host ||
    url.pathname.includes("/assets/") ||
    url.pathname.endsWith(".wasm") ||
    url.pathname.endsWith(".worker.js")
  );
}

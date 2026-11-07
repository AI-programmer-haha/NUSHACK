const CACHE_NAME = "security-management-offline-v7";
const APP_SHELL = [
    "/login-page",
    "/static/offline.html",
    "/static/js/db.js",
    "/static/js/sync-queue.js",
    "/static/js/location-cache.js",
    "/static/js/patrol-store.js",
    "/static/js/patrol-ui.js",
    "/static/js/sync-monitor.js",
    "/static/js/patrol-map.js",
    "/static/js/session.js",
    "/static/js/route-cache.js",
    "/static/js/route-follow.js",
    "/static/js/chat.js"
];

// Map tiles live in their own cache so app updates (CACHE_NAME bumps) don't
// throw away the offline map.
//
//  * Your own tiles (/tiles/..., see MAP_TILES_DIR in app.py): cache-first.
//    You may store them, and the page can pre-download a whole site.
//  * Third-party tiles (e.g. tile.openstreetmap.org): NETWORK-FIRST, so
//    every online view goes to the provider through the browser's HTTP
//    cache, which honours their caching headers. A copy of tiles the
//    officer actually viewed is kept only as an offline fallback, expires
//    after FALLBACK_MAX_AGE_MS, and is capped at MAX_TILES. Nothing is
//    ever bulk-downloaded from them.
const TILE_CACHE = "map-tiles-v2";
const OLD_TILE_CACHES = ["map-tiles-v1"];   // v1 held pre-downloaded OSM tiles
const MAX_TILES = 3000;
const FALLBACK_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TILE_PATH = /\/\d+\/\d+\/\d+(@2x)?\.(png|jpe?g|webp)$/;
let tilePutsSinceTrim = 0;

function isLocalTile(url) {
    return url.origin === self.location.origin && url.pathname.startsWith("/tiles/");
}

function isThirdPartyTile(request, url) {
    return url.origin !== self.location.origin &&
        (request.destination === "image" || request.destination === "") &&
        TILE_PATH.test(url.pathname);
}

async function storeTile(cache, url, response) {
    // Remember when we stored it, for the fallback expiry.
    const body = await response.clone().blob();
    const headers = new Headers(response.headers);
    headers.set("x-sw-stored-at", String(Date.now()));
    await cache.put(url, new Response(body, { status: response.status, headers }));

    if (++tilePutsSinceTrim >= 50) {
        tilePutsSinceTrim = 0;
        trimTileCache().catch(() => undefined);
    }
}

async function trimTileCache() {
    const cache = await caches.open(TILE_CACHE);
    const keys = await cache.keys();          // insertion order: oldest first
    const now = Date.now();
    let remaining = keys.length;

    for (const key of keys) {
        const cached = await cache.match(key);
        const storedAt = Number(cached && cached.headers.get("x-sw-stored-at")) || 0;
        const expired = !isLocalTile(new URL(key.url)) && now - storedAt > FALLBACK_MAX_AGE_MS;
        if (expired || remaining > MAX_TILES) {
            await cache.delete(key);
            remaining -= 1;
        }
    }
}

function tileUnavailable() {
    // Offline and never viewed: Leaflet shows a blank square.
    return new Response("", { status: 504, statusText: "Tile not available offline" });
}

async function serveLocalTile(request) {
    const cache = await caches.open(TILE_CACHE);
    const cached = await cache.match(request.url);
    if (cached) {
        return cached;
    }
    try {
        const response = await fetch(request);
        if (response.ok) {
            await storeTile(cache, request.url, response);
        }
        return response;
    } catch (error) {
        return tileUnavailable();
    }
}

async function serveThirdPartyTile(request) {
    const cache = await caches.open(TILE_CACHE);
    try {
        const response = await fetch(request);
        if (response.ok) {
            await storeTile(cache, request.url, response);
        }
        return response;
    } catch (error) {
        const cached = await cache.match(request.url);
        if (cached) {
            const storedAt = Number(cached.headers.get("x-sw-stored-at")) || 0;
            if (Date.now() - storedAt <= FALLBACK_MAX_AGE_MS) {
                return cached;
            }
        }
        return tileUnavailable();
    }
}

// The map library is loaded from a CDN. Without caching it, the page has no
// map offline. Version-pinned, so cache-first is safe.
const CDN_PREFIX = "https://unpkg.com/leaflet@1.9.4/dist/";
const CDN_ASSETS = [
    CDN_PREFIX + "leaflet.css",
    CDN_PREFIX + "leaflet.js",
    CDN_PREFIX + "images/marker-icon.png",
    CDN_PREFIX + "images/marker-icon-2x.png",
    CDN_PREFIX + "images/marker-shadow.png"
];

// Install: save the public app shell while the device is online.
self.addEventListener("install", (event) => {
    event.waitUntil((async () => {
        const cache = await caches.open(CACHE_NAME);
        await cache.addAll(APP_SHELL);

        // Best effort: a CDN hiccup must not stop the app shell installing.
        await Promise.all(CDN_ASSETS.map((url) =>
            cache.add(new Request(url, { mode: "cors" })).catch((error) => {
                console.warn("Could not precache", url, error);
            })
        ));

        await self.skipWaiting();
    })());
});

// Activate: remove older versions and take control of open pages.
self.addEventListener("activate", (event) => {
    event.waitUntil((async () => {
        const cacheNames = await caches.keys();
        await Promise.all(
            cacheNames
                .filter((name) =>
                    (name.startsWith("security-management-offline-") && name !== CACHE_NAME) ||
                    OLD_TILE_CACHES.includes(name))
                .map((name) => caches.delete(name))
        );
        await self.clients.claim();
    })());
});

self.addEventListener("fetch", (event) => {
    const request = event.request;
    const url = new URL(request.url);

    // Map tiles (see the strategy notes at the top of this file).
    if (request.method === "GET" && isLocalTile(url)) {
        event.respondWith(serveLocalTile(request));
        return;
    }
    if (request.method === "GET" && isThirdPartyTile(request, url)) {
        event.respondWith(serveThirdPartyTile(request));
        return;
    }

    // Pinned CDN assets (Leaflet): cache-first.
    if (request.method === "GET" && request.url.startsWith(CDN_PREFIX)) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            const cached = await cache.match(request.url);
            if (cached) {
                return cached;
            }
            try {
                const response = await fetch(request);
                if (response.ok || response.type === "opaque") {
                    await cache.put(request.url, response.clone());
                }
                return response;
            } catch (error) {
                return new Response("", { status: 503 });
            }
        })());
        return;
    }

    // Never intercept writes, other cross-origin requests, or API calls. In
    // particular, authenticated location data lives in the page's
    // IndexedDB cache (static/js/location-cache.js), not Cache Storage.
    if (request.method !== "GET" || url.origin !== self.location.origin) {
        return;
    }

    if (
        url.pathname === "/locations" ||
        url.pathname === "/me" ||
        url.pathname.startsWith("/sync/") ||
        (url.pathname.startsWith("/login") && url.pathname !== "/login-page")
    ) {
        return;
    }

    // Only these two HTML pages are part of the offline application shell.
    // Do not cache future admin or account pages without reviewing their data.
    const isAppPage = url.pathname === "/login-page" || url.pathname === "/locations-page";

    // Navigation: try the server first so authentication and fresh pages are
    // still respected. If the network or remote auth service is unavailable,
    // use the previously saved page (but never bypass an explicit 401/403).
    if (request.mode === "navigate" && isAppPage) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);

            try {
                const response = await fetch(request);
                const contentType = response.headers.get("content-type") || "";

                // Cache only successful HTML navigations. This lets an
                // authenticated /locations-page visit become available offline.
                if (response.ok && contentType.includes("text/html")) {
                    await cache.put(request, response.clone());
                    return response;
                }

                // The Flask server may still be reachable while its Supabase
                // authentication service is offline. Use the cached page for
                // server errors, but respect 401/403 authorization responses.
                if (response.status >= 500) {
                    const cachedPage = await cache.match(request, { ignoreSearch: true });
                    if (cachedPage) {
                        return cachedPage;
                    }
                }

                return response;
            } catch (error) {
                const cachedPage = await cache.match(request, { ignoreSearch: true });
                if (cachedPage) {
                    return cachedPage;
                }

                const offlinePage = await cache.match("/static/offline.html");
                if (offlinePage) {
                    return offlinePage;
                }

                return new Response(
                    "You are offline. Reconnect once to save this page for offline use.",
                    {
                        status: 503,
                        headers: { "Content-Type": "text/plain; charset=utf-8" }
                    }
                );
            }
        })());
        return;
    }

    // Static assets: NETWORK-FIRST, cached copy only as the offline fallback.
    // (Cache-first served an outdated script after every code change — e.g.
    // an old supervisor.js without "Create checkpoint" — until a 2nd reload.)
    if (url.pathname.startsWith("/static/")) {
        event.respondWith((async () => {
            const cache = await caches.open(CACHE_NAME);
            try {
                const response = await fetch(request);
                if (response.ok) {
                    event.waitUntil(cache.put(request, response.clone()).catch(() => undefined));
                }
                return response;
            } catch (error) {
                const cachedAsset = await cache.match(request);
                if (cachedAsset) {
                    return cachedAsset;
                }
                return new Response("Offline asset unavailable.", {
                    status: 503,
                    headers: { "Content-Type": "text/plain; charset=utf-8" }
                });
            }
        })());
    }
});

/*
 * route-cache.js — the officer's assigned patrol routes, kept offline,
 * plus the geometry used to tell whether someone is on their route.
 *
 * window.RouteCache
 *   load()      refresh from GET /routes when online, else use the cache;
 *               returns { routes, fromCache }
 *   refresh()   GET /routes and replace the cache
 *   getAll()    cached routes (active, not deleted), by name
 *   get(id)     one cached route
 *
 * window.RouteGeo  (same maths as public._distance_to_route_m in SQL, so
 * the officer's device and the server agree on "off route")
 *   path(route)                      [[lat, lng], ...] of mapped stops (closed if loop)
 *   distanceToRouteM(route, lat, lng)
 *   distanceM(a, b)
 *   isOffRoute(route, distance, accuracy, wasOff)   same hysteresis as the server
 */
(function () {
    "use strict";

    const DB = window.PatrolDB;
    const ENDPOINT = "/routes";

    // ------------------------------------------------------------------
    // Geometry
    // ------------------------------------------------------------------

    function stopsWithCoords(route) {
        return (route.stops || [])
            .filter((s) => s.latitude !== null && s.latitude !== undefined &&
                           s.longitude !== null && s.longitude !== undefined)
            .sort((a, b) => a.position - b.position)
            .map((s) => ({ ...s, lat: Number(s.latitude), lng: Number(s.longitude) }));
    }

    function path(route) {
        const pts = stopsWithCoords(route).map((s) => [s.lat, s.lng]);
        if (route.is_loop && pts.length > 2) pts.push(pts[0]);
        return pts;
    }

    function distanceToRouteM(route, lat, lng) {
        const stops = stopsWithCoords(route);
        if (stops.length === 0) return null;

        const kx = 111320 * Math.cos((lat * Math.PI) / 180);
        const ky = 110574;
        const pts = stops.map((s) => [(s.lng - lng) * kx, (s.lat - lat) * ky]);

        let best = Math.hypot(pts[0][0], pts[0][1]);
        const n = pts.length;
        const segments = route.is_loop && n > 2 ? n : n - 1;
        for (let i = 0; i < segments; i++) {
            const [x1, y1] = pts[i];
            const [x2, y2] = pts[(i + 1) % n];
            const dx = x2 - x1;
            const dy = y2 - y1;
            const t = dx === 0 && dy === 0
                ? 0
                : Math.max(0, Math.min(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)));
            best = Math.min(best, Math.hypot(x1 + t * dx, y1 + t * dy));
        }
        return Math.round(best * 10) / 10;
    }

    function distanceM(a, b) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.lat - a.lat);
        const dLng = toRad(b.lng - a.lng);
        const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    // Leave when beyond corridor + min(accuracy, corridor); come back only
    // within 80 % of the corridor (mirrors _track_route_point()).
    function isOffRoute(route, distance, accuracy, wasOff) {
        if (distance === null || distance === undefined) return false;
        const corridor = Number(route.corridor_m) || 50;
        if (wasOff) return distance > corridor * 0.8;
        const allowance = corridor + Math.min(Number(accuracy) || 0, corridor);
        return distance > allowance;
    }

    // ------------------------------------------------------------------
    // Cache
    // ------------------------------------------------------------------

    function usable(route) {
        return route && !route.deleted_at && route.is_active !== false;
    }

    async function replaceAll(routes) {
        await DB.tx(["routes", "meta"], "readwrite", async (s) => {
            await DB.req(s.routes.clear());
            for (const route of routes) {
                if (route && route.id) await DB.req(s.routes.put(route));
            }
            await DB.req(s.meta.put({ key: "routes_synced_at", value: new Date().toISOString() }));
        });
    }

    async function refresh() {
        const response = await fetch(ENDPOINT, { credentials: "same-origin" });
        if (!response.ok) {
            const error = new Error("Could not load routes (HTTP " + response.status + ")");
            error.status = response.status;
            throw error;
        }
        const routes = await response.json();
        await replaceAll(Array.isArray(routes) ? routes : []);
        return getAll();
    }

    async function getAll() {
        return (await DB.getAll("routes"))
            .filter(usable)
            .sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }

    function get(id) {
        return id ? DB.get("routes", id) : Promise.resolve(null);
    }

    async function load() {
        if (navigator.onLine) {
            try {
                return { routes: await refresh(), fromCache: false };
            } catch (error) {
                console.warn("Using cached routes:", error.message);
            }
        }
        return { routes: await getAll(), fromCache: true };
    }

    window.RouteGeo = { path, distanceToRouteM, distanceM, isOffRoute, stopsWithCoords };
    window.RouteCache = { load, refresh, getAll, get };
})();

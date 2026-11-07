/*
 * patrol-map.js — map, GPS tracking, patrol routes and offline tiles.
 *
 * Map tiles: the tile source comes from the server (map_config in app.py,
 * embedded as <script id="mapConfig">). "Save map for offline" is offered
 * only when that source allows offline storage — your own tiles under
 * /tiles/ or a provider whose licence permits it. It is never offered for
 * tile.openstreetmap.org: their policy forbids bulk/offline downloading.
 * With OSM, the service worker only keeps tiles the officer has actually
 * viewed, as an offline fallback (see service-worker.js).
 *
 * Routes: every accepted GPS fix is stored in IndexedDB (and uploaded
 * during a patrol). The map shows, in order of preference: the active
 * patrol's route, else the most recent finished patrol's route, else
 * free tracking. Any past patrol can be shown with showPatrolRoute(id).
 * Gaps with no GPS are drawn dashed.
 *
 * GPS in a browser has hard limits, handled here as far as a web page can:
 *   - needs HTTPS (or localhost): detected and explained;
 *   - stops when the screen locks / app is backgrounded: a Screen Wake
 *     Lock keeps the screen on during a patrol, background time is
 *     detected and reported as a GPS gap, tracking restarts on return;
 *   - watchPosition can silently stall: a watchdog restarts it;
 *   - errors are shown in a status line, not as repeated alerts.
 * Truly continuous background tracking needs a native app.
 *
 * Globals used by the page: startTracking(), stopTracking(),
 * refreshLocation(), getLastKnownPosition(). Exposes window.PatrolMap.
 */
(function () {
    "use strict";

    const OSM = {
        provider: "osm",
        tileUrl: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
        maxZoom: 19,
        offlineDownload: false,
        offlineMinZoom: 14,
        offlineMaxZoom: 19,
        offlineMaxTiles: 2000
    };

    const TILE_CACHE = "map-tiles-v2";               // shared with service-worker.js
    const AREA_PADDING_DEG = 0.003;                  // ~300 m around the sites
    const FRESH_FIX_MS = 120000;
    const WATCHDOG_INTERVAL_MS = 15000;
    const tuning = {
        stallMs: 60000,                // no fix this long while visible -> restart watch
        backgroundReportMs: 30000      // hidden longer than this -> report a GPS pause
    };

    const $ = (id) => document.getElementById(id);

    const CONFIG = readConfig();

    let map = null;
    let routeLayers = [];
    let currentMarker = null;
    let locationMarkers = [];
    let fittedToLocations = false;
    let knownLocations = [];

    // What the map is showing: { kind: "active"|"finished"|"free", patrol, points }
    let shown = { kind: "free", patrol: null, points: [] };

    let watchId = null;
    let lastKnownPosition = null;
    let lastFixAt = 0;
    let activePatrolId = null;
    let recording = Promise.resolve();
    let wakeLock = null;
    let hiddenAt = null;
    let gpsProblem = "";

    function readConfig() {
        try {
            const node = document.getElementById("mapConfig");
            const parsed = node ? JSON.parse(node.textContent) : {};
            const config = { ...OSM, ...parsed };
            if (String(config.tileUrl).includes("openstreetmap.org")) config.offlineDownload = false;
            return config;
        } catch (_) {
            return { ...OSM };
        }
    }

    const fmt = (ms) => window.PatrolStore.formatDuration(ms);

    function meters(m) {
        return m >= 1000 ? (m / 1000).toFixed(2) + " km" : Math.round(m) + " m";
    }

    // ------------------------------------------------------------------
    // Map
    // ------------------------------------------------------------------

    function init() {
        const element = $("map");
        if (!window.L) {
            element.classList.add("map-unavailable");
            element.textContent =
                "Map unavailable offline. Patrols, check-ins, GPS recording and saved locations still work.";
            return;
        }

        const crossOrigin = /^https?:\/\//.test(CONFIG.tileUrl) &&
            !CONFIG.tileUrl.startsWith(window.location.origin);

        map = L.map(element).setView([1.3521, 103.8198], 12);
        L.tileLayer(CONFIG.tileUrl, {
            attribution: CONFIG.attribution,
            maxZoom: CONFIG.maxZoom,
            crossOrigin: crossOrigin ? true : undefined
        }).addTo(map);
    }

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    function validCoords(lat, lng) {
        return Number.isFinite(lat) && Number.isFinite(lng) &&
            lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
    }

    function showLocations(locations) {
        knownLocations = locations || [];
        if (!map) return;

        locationMarkers.forEach((marker) => map.removeLayer(marker));
        locationMarkers = [];

        const points = [];
        knownLocations.forEach((location) => {
            if (location.latitude === null || location.longitude === null) return;
            const lat = Number(location.latitude);
            const lng = Number(location.longitude);
            if (!validCoords(lat, lng)) return;

            points.push([lat, lng]);
            locationMarkers.push(
                L.marker([lat, lng]).addTo(map)
                    .bindPopup("<strong>" + escapeHTML(location.name) + "</strong>")
            );
        });

        if (!fittedToLocations && points.length && shown.points.length === 0) {
            map.fitBounds(points, { padding: [30, 30], maxZoom: 17 });
            fittedToLocations = true;
        }
    }

    // Solid line for continuous GPS, dashed grey across gaps; green start,
    // and for a finished patrol a dark end marker.
    function drawRoute() {
        if (!map) return;

        routeLayers.forEach((layer) => map.removeLayer(layer));
        routeLayers = [];

        const points = shown.points;
        if (points.length === 0) return;

        const gapAfter = new Set(window.PatrolStore.findGpsGaps(points).map((g) => g.afterIndex));
        let run = [[points[0].latitude, points[0].longitude]];

        for (let i = 1; i < points.length; i++) {
            const here = [points[i].latitude, points[i].longitude];
            if (gapAfter.has(i - 1)) {
                if (run.length > 1) routeLayers.push(L.polyline(run, { color: "#2563EB", weight: 5 }).addTo(map));
                routeLayers.push(L.polyline([run[run.length - 1], here], {
                    color: "#94A3B8", weight: 4, dashArray: "6 8", className: "route-gap"
                }).addTo(map).bindPopup("No GPS for " + fmt(new Date(points[i].recorded_at) - new Date(points[i - 1].recorded_at))));
                run = [here];
            } else {
                run.push(here);
            }
        }
        if (run.length > 1) routeLayers.push(L.polyline(run, { color: "#2563EB", weight: 5 }).addTo(map));

        const first = points[0];
        routeLayers.push(L.circleMarker([first.latitude, first.longitude], {
            radius: 8, color: "#16A34A", fillColor: "#16A34A", fillOpacity: 0.9, className: "route-start"
        }).addTo(map).bindPopup("Start · " + new Date(first.recorded_at).toLocaleTimeString()));

        if (shown.kind === "finished") {
            const last = points[points.length - 1];
            routeLayers.push(L.circleMarker([last.latitude, last.longitude], {
                radius: 8, color: "#1E293B", fillColor: "#1E293B", fillOpacity: 0.9, className: "route-end"
            }).addTo(map).bindPopup("End · " + new Date(last.recorded_at).toLocaleTimeString()));
        }
    }

    // The route the officer is supposed to follow: dashed orange path with
    // numbered stops, drawn under the recorded route.
    let plannedLayers = [];

    function showPlannedRoute(route) {
        if (!map) return;
        plannedLayers.forEach((layer) => map.removeLayer(layer));
        plannedLayers = [];
        if (!route) return;

        const pts = window.RouteGeo.path(route);
        if (pts.length > 1) {
            plannedLayers.push(L.polyline(pts, {
                color: "#F59E0B", weight: 6, opacity: 0.8, dashArray: "10 8", className: "planned-route"
            }).addTo(map));
        }
        window.RouteGeo.stopsWithCoords(route).forEach((stop) => {
            plannedLayers.push(L.marker([stop.lat, stop.lng], {
                icon: L.divIcon({
                    className: "stop-number",
                    html: "<span>" + stop.position + "</span>",
                    iconSize: [26, 26]
                })
            }).addTo(map).bindPopup(stop.position + ". " + escapeHTML(stop.name)));
        });
        if (pts.length && shown.points.length === 0) {
            map.fitBounds(pts, { padding: [30, 30], maxZoom: 18 });
        }
    }

    function fitRoute() {
        if (!map || shown.points.length === 0) return;
        map.fitBounds(shown.points.map((p) => [p.latitude, p.longitude]), { padding: [30, 30], maxZoom: 17 });
    }

    function showCurrent(lat, lng) {
        if (!map) return;
        if (currentMarker) map.removeLayer(currentMarker);
        currentMarker = L.circleMarker([lat, lng], {
            radius: 8, color: "#DC2626", fillColor: "#DC2626", fillOpacity: 0.9
        }).addTo(map).bindPopup("Current location");
        if (shown.kind !== "finished") {
            map.setView([lat, lng], Math.max(map.getZoom(), 16));
        }
    }

    function updateRouteSummary() {
        const box = $("routeSummary");
        if (!box) return;

        const points = shown.points;
        const { patrol, kind } = shown;

        if (points.length === 0) {
            box.textContent = kind === "active" ? "No GPS points recorded for this patrol yet." : "";
            return;
        }

        const gaps = window.PatrolStore.findGpsGaps(points);
        const parts = [
            points.length + " GPS point(s)",
            meters(window.PatrolStore.routeLengthMeters(points))
        ];
        if (gaps.length) {
            parts.push(gaps.length + " GPS gap(s), " + fmt(gaps.reduce((s, g) => s + g.ms, 0)) + " without signal");
        }

        let label;
        if (kind === "active") label = "Current patrol";
        else if (kind === "finished") {
            label = "Patrol " + patrol.status + " " +
                new Date(patrol.ended_at || points[points.length - 1].recorded_at).toLocaleString([], {
                    day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
                });
        } else label = "Tracking outside a patrol (kept on this device, not uploaded)";

        box.textContent = label + " · " + parts.join(" · ");
    }

    async function show(kind, patrol) {
        const points = await window.PatrolStore.getRoute(patrol ? patrol.id : null);
        shown = { kind, patrol, points };
        drawRoute();
        updateRouteSummary();
        return points;
    }

    // Show a specific patrol's route (e.g. from the history list).
    async function showPatrolRoute(patrolId) {
        const patrol = await window.PatrolStore.getPatrol(patrolId);
        if (!patrol) throw new Error("Patrol not found");
        const points = await show(patrol.status === "in_progress" ? "active" : "finished", patrol);
        fitRoute();
        return points;
    }

    async function restoreRoute() {
        const active = await window.PatrolStore.getActivePatrol();
        activePatrolId = active ? active.id : null;

        if (active) {
            await show("active", active);
        } else {
            const finished = await window.PatrolStore.getLatestFinishedPatrolWithRoute();
            if (finished) await show("finished", finished);
            else await show("free", null);
        }
        fitRoute();
        return shown;
    }

    // ------------------------------------------------------------------
    // GPS
    // ------------------------------------------------------------------

    function gpsSupportProblem() {
        if (!("geolocation" in navigator)) return "This browser has no GPS support.";
        if (window.isSecureContext === false) {
            return "GPS needs a secure connection. Open the app over HTTPS (or on localhost) — " +
                "browsers block location on plain http:// addresses.";
        }
        return "";
    }

    function setGpsStatus() {
        const status = $("trackingStatus");
        if (status) {
            status.textContent = watchId !== null ? "Active · recording" : (gpsProblem ? "Unavailable" : "Inactive");
            status.className = watchId !== null ? "online" : (gpsProblem ? "offline" : "");
        }

        const line = $("gpsStatus");
        if (!line) return;

        if (gpsProblem) {
            line.textContent = gpsProblem;
            line.className = "message message-error";
            return;
        }
        if (watchId === null) {
            line.textContent = "";
            line.className = "message muted";
            return;
        }

        const parts = [];
        if (lastFixAt) {
            parts.push("last fix " + fmt(Date.now() - lastFixAt) + " ago");
            if (lastKnownPosition && Number.isFinite(lastKnownPosition.accuracy)) {
                parts.push("±" + Math.round(lastKnownPosition.accuracy) + " m");
            }
        } else {
            parts.push("waiting for first GPS fix…");
        }
        parts.push(wakeLock ? "screen kept on" :
            ("wakeLock" in navigator ? "screen may sleep" : "keep the screen on — this browser can't"));
        line.textContent = "GPS: " + parts.join(" · ") +
            ". Keep this page open and the screen on: browsers pause GPS in the background.";
        line.className = "message muted";
    }

    function onPosition(position) {
        const fix = {
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            accuracy: position.coords.accuracy,
            recorded_at: new Date(position.timestamp || Date.now()).toISOString()
        };
        lastKnownPosition = { ...fix, at: Date.now() };
        lastFixAt = Date.now();
        if (gpsProblem && !gpsSupportProblem()) gpsProblem = "";
        showCurrent(fix.latitude, fix.longitude);

        const patrolId = activePatrolId;   // capture: may end while we write

        // Route following (route-follow.js) checks every fix immediately,
        // so the officer is warned even when offline.
        try {
            window.dispatchEvent(new CustomEvent("patrol:fix", { detail: { ...fix, patrolId } }));
        } catch (_) { /* listeners are optional */ }

        // Serialise writes so the distance/time throttle sees the last point.
        recording = recording.then(async () => {
            try {
                const point = await window.PatrolStore.recordRoutePoint(patrolId, fix);
                const showingThisTrack =
                    (patrolId && shown.patrol && shown.patrol.id === patrolId) ||
                    (!patrolId && shown.kind === "free");
                if (point && showingThisTrack) {
                    shown.points.push(point);
                    drawRoute();
                    updateRouteSummary();
                }
            } catch (error) {
                console.error("Could not save GPS point:", error);
            }
        });

        const updated = $("lastUpdated");
        if (updated) updated.textContent = "Last updated: " + new Date().toLocaleTimeString();
        setGpsStatus();
    }

    function onError(error) {
        console.warn("GPS error:", error && error.message);
        if (error.code === 1) {
            gpsProblem = "Location permission is blocked for this site. Allow location in the browser's " +
                "site settings, then press Start Tracking.";
            stopTracking();
        } else if (error.code === 2) {
            gpsProblem = "No GPS signal right now — still trying. Move to open sky if possible.";
        }
        // code 3 (timeout): the watch keeps trying; the watchdog handles stalls.
        setGpsStatus();
    }

    function beginWatch() {
        watchId = navigator.geolocation.watchPosition(onPosition, onError, {
            enableHighAccuracy: true,
            maximumAge: 5000,
            timeout: 20000
        });
    }

    let wakeLockPending = null;    // one request at a time: never hold two locks

    function acquireWakeLock() {
        if (!("wakeLock" in navigator) || wakeLock || document.visibilityState !== "visible") {
            return wakeLockPending || Promise.resolve();
        }
        if (wakeLockPending) return wakeLockPending;

        wakeLockPending = (async () => {
            try {
                const sentinel = await navigator.wakeLock.request("screen");
                if (watchId === null || !activePatrolId) {
                    await sentinel.release();     // tracking stopped while we waited
                    return;
                }
                wakeLock = sentinel;
                sentinel.addEventListener("release", () => {
                    if (wakeLock === sentinel) wakeLock = null;
                    setGpsStatus();
                });
            } catch (error) {
                wakeLock = null;                  // denied (battery saver, not visible, …)
            } finally {
                wakeLockPending = null;
                setGpsStatus();
            }
        })();
        return wakeLockPending;
    }

    function releaseWakeLock() {
        if (wakeLock) {
            const sentinel = wakeLock;
            wakeLock = null;
            sentinel.release().catch(() => undefined);
        }
    }

    function startTracking() {
        const problem = gpsSupportProblem();
        if (problem) {
            gpsProblem = problem;
            setGpsStatus();
            return false;
        }
        if (watchId !== null) return true;

        gpsProblem = "";
        lastFixAt = 0;
        beginWatch();
        if (activePatrolId) acquireWakeLock();
        if (!activePatrolId && shown.kind !== "free") show("free", null);
        setGpsStatus();
        return true;
    }

    function stopTracking() {
        if (watchId !== null) {
            navigator.geolocation.clearWatch(watchId);
            watchId = null;
        }
        releaseWakeLock();
        setGpsStatus();
    }

    function restartWatch(reason) {
        if (watchId === null) return;
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
        console.info("Restarting GPS:", reason);
        beginWatch();
    }

    function refreshLocation() {
        const problem = gpsSupportProblem();
        if (problem) {
            gpsProblem = problem;
            setGpsStatus();
            return;
        }
        navigator.geolocation.getCurrentPosition(onPosition, onError, {
            enableHighAccuracy: true,
            timeout: 10000
        });
    }

    function getLastKnownPosition() {
        if (lastKnownPosition && Date.now() - lastKnownPosition.at < FRESH_FIX_MS) {
            return lastKnownPosition;
        }
        return null;
    }

    // Some browsers silently stop delivering fixes; restart the watch.
    function watchdog() {
        if (watchId === null || document.visibilityState !== "visible") return;
        const since = Date.now() - (lastFixAt || Date.now());
        if (lastFixAt && since > tuning.stallMs) {
            gpsProblem = "No GPS fix for " + fmt(since) + " — retrying…";
            restartWatch("stalled");
        }
        setGpsStatus();
    }

    // Browsers pause GPS (and drop wake locks) when the page is hidden.
    function onVisibilityChange() {
        if (document.visibilityState === "hidden") {
            hiddenAt = Date.now();
            return;
        }
        const away = hiddenAt ? Date.now() - hiddenAt : 0;
        hiddenAt = null;
        if (watchId === null) return;

        if (away > tuning.backgroundReportMs) {
            gpsProblem = "GPS was paused for " + fmt(away) +
                " while the app was in the background — that stretch shows as a gap on the route.";
            restartWatch("returned from background");
        }
        if (activePatrolId) acquireWakeLock();
        setGpsStatus();
    }

    async function resumeTrackingIfAllowed() {
        if (!activePatrolId || gpsSupportProblem() || !navigator.permissions) return;
        try {
            const permission = await navigator.permissions.query({ name: "geolocation" });
            if (permission.state === "granted") startTracking();
        } catch (_) { /* permissions API unsupported: wait for the button */ }
    }

    // A patrol records its own route: start tracking with it, stop at the end.
    window.addEventListener("patrol:started", async (event) => {
        activePatrolId = event.detail.id;
        await show("active", event.detail);
        startTracking();                    // also takes the screen wake lock
    });

    window.addEventListener("patrol:ended", async (event) => {
        activePatrolId = null;              // new fixes no longer belong to it
        stopTracking();
        await recording;                    // let in-flight points finish
        await show("finished", event.detail);
        fitRoute();
    });

    // ------------------------------------------------------------------
    // Offline tiles (only for sources that allow it)
    // ------------------------------------------------------------------

    function lngToTileX(lng, z) {
        return Math.floor(((lng + 180) / 360) * 2 ** z);
    }

    function latToTileY(lat, z) {
        const r = (lat * Math.PI) / 180;
        return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
    }

    function tileUrl(z, x, y) {
        const url = CONFIG.tileUrl.replace("{z}", z).replace("{x}", x).replace("{y}", y)
            .replace("{s}", "a").replace("{r}", "");
        return new URL(url, window.location.origin).href;
    }

    function planTiles(bounds, minZoom = CONFIG.offlineMinZoom, maxZoom = CONFIG.offlineMaxZoom,
                       cap = CONFIG.offlineMaxTiles) {
        const tiles = [];
        for (let z = minZoom; z <= maxZoom; z++) {
            const x1 = lngToTileX(bounds.west, z);
            const x2 = lngToTileX(bounds.east, z);
            const y1 = latToTileY(bounds.north, z);
            const y2 = latToTileY(bounds.south, z);
            const level = [];
            for (let x = Math.min(x1, x2); x <= Math.max(x1, x2); x++) {
                for (let y = Math.min(y1, y2); y <= Math.max(y1, y2); y++) {
                    level.push({ z, x, y, url: tileUrl(z, x, y) });
                }
            }
            if (tiles.length + level.length > cap) break;
            tiles.push(...level);
        }
        return tiles;
    }

    function areaToSave() {
        const points = [];
        knownLocations.forEach((l) => {
            const lat = Number(l.latitude);
            const lng = Number(l.longitude);
            if (l.latitude !== null && l.longitude !== null && validCoords(lat, lng)) points.push([lat, lng]);
        });
        shown.points.forEach((p) => points.push([p.latitude, p.longitude]));

        if (points.length) {
            const lats = points.map((p) => p[0]);
            const lngs = points.map((p) => p[1]);
            return {
                south: Math.min(...lats) - AREA_PADDING_DEG,
                north: Math.max(...lats) + AREA_PADDING_DEG,
                west: Math.min(...lngs) - AREA_PADDING_DEG,
                east: Math.max(...lngs) + AREA_PADDING_DEG
            };
        }
        if (map) {
            const b = map.getBounds();
            return { south: b.getSouth(), north: b.getNorth(), west: b.getWest(), east: b.getEast() };
        }
        return null;
    }

    async function cachedTileCount() {
        if (!("caches" in window)) return 0;
        try {
            return (await (await caches.open(TILE_CACHE)).keys()).length;
        } catch (_) {
            return 0;
        }
    }

    async function showTileStatus(prefix = "") {
        const box = $("mapOfflineStatus");
        if (!box) return;
        const count = await cachedTileCount();

        if (!CONFIG.offlineDownload) {
            box.textContent = prefix +
                "Offline map: areas you have viewed stay available offline" +
                (count ? " (" + count + " tile(s) on this device)" : "") + ". " +
                "Downloading whole areas is off — OpenStreetMap's tile policy doesn't allow bulk " +
                "or offline downloads. Ask your administrator to set up a site tile set (MAP_TILES_DIR) " +
                "to download maps in advance.";
            return;
        }
        box.textContent = prefix + (count
            ? count + " map tile(s) saved on this device for offline use."
            : "No map tiles saved yet.");
    }

    async function saveAreaOffline() {
        const box = $("mapOfflineStatus");

        if (!CONFIG.offlineDownload) {          // hard stop, even if called directly
            await showTileStatus();
            return { saved: 0, refused: true };
        }
        if (!("caches" in window)) {
            box.textContent = "This browser can't store map tiles.";
            return { saved: 0 };
        }
        if (!navigator.onLine) {
            box.textContent = "Connect to the internet to download the map.";
            return { saved: 0 };
        }
        const bounds = areaToSave();
        if (!bounds) {
            box.textContent = "No area to save yet.";
            return { saved: 0 };
        }

        const button = $("saveMapButton");
        const tiles = planTiles(bounds);
        const cache = await caches.open(TILE_CACHE);
        const sameOrigin = (url) => url.startsWith(window.location.origin);
        let done = 0;
        let fetched = 0;
        let failed = 0;
        if (button) button.disabled = true;

        const queue = [...tiles];
        async function worker() {
            while (queue.length) {
                const tile = queue.shift();
                try {
                    if (!(await cache.match(tile.url))) {
                        const response = await fetch(tile.url, sameOrigin(tile.url)
                            ? { credentials: "same-origin" }
                            : { mode: "cors", credentials: "omit" });
                        if (!response.ok) throw new Error("HTTP " + response.status);
                        await cache.put(tile.url, response);
                        fetched += 1;
                    }
                } catch (_) {
                    failed += 1;
                }
                done += 1;
                box.textContent = "Saving map… " + done + " / " + tiles.length;
            }
        }
        await Promise.all([worker(), worker()]);

        if (button) button.disabled = false;
        await showTileStatus(
            "Saved the area around your sites (zoom " + CONFIG.offlineMinZoom + "–" +
            (tiles.length ? tiles[tiles.length - 1].z : CONFIG.offlineMinZoom) + ", " + fetched + " new" +
            (failed ? ", " + failed + " failed" : "") + "). "
        );
        return { saved: fetched, failed };
    }

    // ------------------------------------------------------------------
    // Start-up
    // ------------------------------------------------------------------

    init();

    document.addEventListener("DOMContentLoaded", async () => {
        // Wait for the page's start-up checks; render nothing if they fail.
        if (!window.AppStartup || !(await window.AppStartup)) return;

        const button = $("saveMapButton");
        if (button) {
            button.hidden = !CONFIG.offlineDownload;
            button.addEventListener("click", saveAreaOffline);
        }

        document.addEventListener("visibilitychange", onVisibilityChange);
        setInterval(watchdog, WATCHDOG_INTERVAL_MS);
        setInterval(setGpsStatus, 5000);

        const problem = gpsSupportProblem();
        if (problem) gpsProblem = problem;
        setGpsStatus();

        try {
            await restoreRoute();
            await resumeTrackingIfAllowed();
        } catch (error) {
            console.error("Could not restore GPS route:", error);
        }
        showTileStatus();
    });

    window.startTracking = startTracking;
    window.stopTracking = stopTracking;
    window.refreshLocation = refreshLocation;
    window.getLastKnownPosition = getLastKnownPosition;

    window.PatrolMap = {
        CONFIG,
        TILE_CACHE,
        tuning,
        showLocations,
        showPatrolRoute,
        showPlannedRoute,
        restoreRoute,
        saveAreaOffline,
        planTiles,
        shown: () => shown,
        isTracking: () => watchId !== null,
        hasWakeLock: () => wakeLock !== null,
        _watchdog: watchdog,
        _onVisibilityChange: onVisibilityChange
    };
})();

/*
 * patrol-store.js — local-first patrol, check-in and GPS-route records.
 *
 * Every write:
 *   1. generates the record's UUID on the device (ids are created
 *      client-side so offline records keep their identity),
 *   2. saves the record to IndexedDB, and
 *   3. enqueues a sync operation tagged with the officer's user_id,
 * all in ONE transaction — a record can never exist without its pending op.
 *
 * Exposes window.PatrolStore:
 *   cacheCurrentUser() / getCurrentUser()
 *   startPatrol({ location_id, notes, scheduled_start })
 *   recordCheckpoint(patrolId, { location_id, status, scan_method,
 *                                latitude, longitude, notes, scanned_at })
 *   updatePatrol(patrolId, changes) / completePatrol(id, notes?) / abandonPatrol(id, notes?)
 *   recordRoutePoint(patrolId | null, { latitude, longitude, accuracy, recorded_at })
 *   getRoute(patrolId | null)          GPS points in time order
 *   getPatrol(id) / getActivePatrol() / listPatrols()
 *   getCheckpointScans(patrolId)
 *   getPatrolProgress(patrolId)        expected vs scanned checkpoints
 *   getPatrolTimeline(patrolId)        timestamped events + durations
 *   patrolDurationMs(patrol, now?)     elapsed (live) or total (finished)
 *   formatDuration(ms)                 "1h 05m 12s"
 *
 * Events on window: "patrol:started", "patrol:ended" (detail = patrol).
 */
(function () {
    "use strict";

    const DB = window.PatrolDB;
    const Queue = window.SyncQueue;

    const PATROL_STATUSES = ["scheduled", "in_progress", "completed", "abandoned"];
    const SCAN_STATUSES = ["ok", "issue_found", "missed", "skipped"];
    const SCAN_METHODS = ["qr", "nfc", "gps", "manual"];
    const PATROL_EDITABLE = ["status", "location_id", "scheduled_start", "started_at", "ended_at", "notes"];

    // GPS: keep a fix only if we moved this far or this much time passed,
    // and ignore fixes too inaccurate to be useful on a site plan.
    const ROUTE_MIN_DISTANCE_M = 10;
    const ROUTE_MIN_INTERVAL_MS = 30000;
    const ROUTE_MAX_ACCURACY_M = 100;
    const FREE_TRACK = "free";      // tracking outside a patrol: local only
    // A fix is stored at least every ROUTE_MIN_INTERVAL_MS while tracking,
    // so a longer silence means the browser stopped delivering GPS
    // (screen off, app in background, no signal).
    const GPS_GAP_MS = 2 * 60 * 1000;

    // Fields that exist only on the device and are never sent to the server.
    const LOCAL_ONLY = ["sync_status", "track_key"];
    // Fields the server owns (defaults, triggers, generated columns).
    const SERVER_OWNED = ["version", "created_at", "updated_at", "duration_seconds"];

    function now() {
        return new Date().toISOString();
    }

    function toPayload(record) {
        const payload = { ...record };
        [...LOCAL_ONLY, ...SERVER_OWNED].forEach((key) => delete payload[key]);
        return payload;
    }

    function coord(value) {
        if (value === undefined || value === null || value === "") return null;
        const n = Number(value);
        return Number.isFinite(n) ? Number(n.toFixed(6)) : null; // NUMERIC(9,6)
    }

    function emit(name, patrol) {
        try {
            window.dispatchEvent(new CustomEvent(name, { detail: patrol }));
        } catch (_) { /* no CustomEvent support: listeners are optional */ }
    }

    // ------------------------------------------------------------------
    // Current user (needed for officer_id while offline)
    // ------------------------------------------------------------------

    async function cacheCurrentUser() {
        const response = await fetch("/me", { credentials: "same-origin" });
        if (!response.ok) {
            throw new Error("Could not load current user (HTTP " + response.status + ")");
        }
        const user = await response.json();
        if (!user || !user.id) {
            throw new Error("Server returned no user profile.");
        }

        // A different officer logged in without logging out first: drop the
        // previous officer's records. Their unsynced ops stay, tagged with
        // their user_id, and are only sent when they log in again.
        const previous = await DB.getMeta("user");
        if (previous && previous.id !== user.id) {
            await DB.wipe({ keepQueue: true });
        }

        await DB.setMeta("user", user);
        return user;
    }

    async function getCurrentUser() {
        const user = await DB.getMeta("user");
        if (user) return user;
        if (navigator.onLine) return cacheCurrentUser();
        throw new Error("No cached user. Log in once while online.");
    }

    // ------------------------------------------------------------------
    // Patrol + check-in writes
    // ------------------------------------------------------------------

    async function startPatrol(options = {}) {
        const [user, deviceId] = await Promise.all([getCurrentUser(), DB.getDeviceId()]);

        const existing = await getActivePatrol();
        if (existing) {
            throw new Error("A patrol is already in progress (" + existing.id + ").");
        }

        let route = null;
        if (options.route_id) {
            route = await window.RouteCache.get(options.route_id);
            if (!route || route.deleted_at || route.is_active === false) {
                throw new Error("That route isn't available on this device. Refresh while online.");
            }
        }

        const timestamp = now();
        const patrol = {
            id: DB.uuid(),
            officer_id: user.id,
            route_id: route ? route.id : null,
            location_id: options.location_id || (route && route.location_id) || null,
            status: "in_progress",
            scheduled_start: options.scheduled_start || null,
            started_at: timestamp,
            ended_at: null,
            notes: options.notes || null,
            device_id: deviceId,
            client_updated_at: timestamp,
            version: 1,
            created_at: timestamp,       // local estimate; server value wins on pull
            updated_at: timestamp,
            deleted_at: null,
            sync_status: "pending"
        };

        await DB.tx(["patrols", "sync_queue"], "readwrite", async (s) => {
            await DB.req(s.patrols.add(patrol));
            await Queue.enqueueIn(s.sync_queue, {
                user_id: user.id,
                entity_type: "patrols",
                entity_id: patrol.id,
                operation: "create",
                base_version: null,
                payload: toPayload(patrol),
                client_timestamp: timestamp
            });
        });

        emit("patrol:started", patrol);
        Queue.flush();
        return patrol;
    }

    async function recordCheckpoint(patrolId, scan = {}) {
        if (!scan.location_id) {
            throw new Error("location_id (the checkpoint location) is required.");
        }

        const status = scan.status || "ok";
        const method = scan.scan_method || "manual";
        if (!SCAN_STATUSES.includes(status)) throw new Error("Invalid status: " + status);
        if (!SCAN_METHODS.includes(method)) throw new Error("Invalid scan_method: " + method);

        const [user, deviceId] = await Promise.all([getCurrentUser(), DB.getDeviceId()]);
        const timestamp = now();

        const record = {
            id: DB.uuid(),
            patrol_id: patrolId,
            location_id: scan.location_id,
            officer_id: user.id,
            status,
            scan_method: method,
            scanned_at: scan.scanned_at || timestamp,
            latitude: coord(scan.latitude),
            longitude: coord(scan.longitude),
            notes: scan.notes || null,
            device_id: deviceId,
            client_updated_at: timestamp,
            version: 1,
            created_at: timestamp,
            updated_at: timestamp,
            deleted_at: null,
            sync_status: "pending"
        };

        await DB.tx(["patrols", "checkpoints", "sync_queue"], "readwrite", async (s) => {
            const patrol = await DB.req(s.patrols.get(patrolId));
            if (!patrol) throw new Error("Patrol not found: " + patrolId);
            if (patrol.status !== "in_progress") {
                throw new Error("Patrol is not in progress (status: " + patrol.status + ").");
            }

            await DB.req(s.checkpoints.add(record));
            await Queue.enqueueIn(s.sync_queue, {
                user_id: user.id,
                entity_type: "checkpoints",
                entity_id: record.id,
                operation: "create",
                base_version: null,
                payload: toPayload(record),
                client_timestamp: timestamp
            });
        });

        Queue.flush();
        return record;
    }

    async function updatePatrol(patrolId, changes = {}) {
        const fields = Object.keys(changes).filter((key) => PATROL_EDITABLE.includes(key));
        if (fields.length === 0) {
            throw new Error("No editable fields in update.");
        }
        if (changes.status && !PATROL_STATUSES.includes(changes.status)) {
            throw new Error("Invalid status: " + changes.status);
        }

        const [user, deviceId] = await Promise.all([getCurrentUser(), DB.getDeviceId()]);
        const timestamp = now();

        const updated = await DB.tx(["patrols", "sync_queue"], "readwrite", async (s) => {
            const patrol = await DB.req(s.patrols.get(patrolId));
            if (!patrol) throw new Error("Patrol not found: " + patrolId);

            const diff = {};
            fields.forEach((key) => {
                patrol[key] = changes[key];
                diff[key] = changes[key];
            });

            patrol.device_id = deviceId;
            patrol.client_updated_at = timestamp;
            patrol.updated_at = timestamp;
            patrol.sync_status = "pending";

            await DB.req(s.patrols.put(patrol));
            // If an earlier change to this patrol hasn't been sent yet, the
            // queue merges this one into it (no second op, no false conflict).
            await Queue.enqueueIn(s.sync_queue, {
                user_id: user.id,
                entity_type: "patrols",
                entity_id: patrol.id,
                operation: "update",
                // version = last version confirmed by the server.
                base_version: patrol.version,
                payload: { ...diff, client_updated_at: timestamp },
                client_timestamp: timestamp
            });

            return patrol;
        });

        if (changes.status === "completed" || changes.status === "abandoned") {
            emit("patrol:ended", updated);
        }

        Queue.flush();
        return updated;
    }

    function completePatrol(patrolId, notes) {
        const changes = { status: "completed", ended_at: now() };
        if (notes !== undefined) changes.notes = notes;
        return updatePatrol(patrolId, changes);
    }

    function abandonPatrol(patrolId, notes) {
        const changes = { status: "abandoned", ended_at: now() };
        if (notes !== undefined) changes.notes = notes;
        return updatePatrol(patrolId, changes);
    }

    // ------------------------------------------------------------------
    // GPS route
    // ------------------------------------------------------------------

    function distanceMeters(a, b) {
        const R = 6371000;
        const toRad = (d) => (d * Math.PI) / 180;
        const dLat = toRad(b.latitude - a.latitude);
        const dLng = toRad(b.longitude - a.longitude);
        const h = Math.sin(dLat / 2) ** 2 +
            Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * Math.sin(dLng / 2) ** 2;
        return 2 * R * Math.asin(Math.sqrt(h));
    }

    const lastPoint = new Map();   // track_key -> last stored point (in memory)

    /*
     * Store one GPS fix. During a patrol it is also queued for upload
     * (route_points); outside a patrol it stays on this device only.
     * Returns the stored point, or null if it was skipped (too close /
     * too soon / too inaccurate).
     */
    async function recordRoutePoint(patrolId, fix) {
        const latitude = coord(fix.latitude);
        const longitude = coord(fix.longitude);
        if (latitude === null || longitude === null) return null;

        const accuracy = Number.isFinite(Number(fix.accuracy)) ? Math.round(Number(fix.accuracy) * 100) / 100 : null;
        if (accuracy !== null && accuracy > ROUTE_MAX_ACCURACY_M) return null;

        const trackKey = patrolId || FREE_TRACK;
        const recordedAt = fix.recorded_at || now();

        let previous = lastPoint.get(trackKey);
        if (!previous) {
            const stored = await getRoute(patrolId);
            previous = stored[stored.length - 1];
        }
        if (previous) {
            const moved = distanceMeters(previous, { latitude, longitude });
            const elapsed = new Date(recordedAt) - new Date(previous.recorded_at);
            if (moved < ROUTE_MIN_DISTANCE_M && elapsed < ROUTE_MIN_INTERVAL_MS) return null;
        }

        const [user, deviceId] = await Promise.all([getCurrentUser(), DB.getDeviceId()]);
        const point = {
            id: DB.uuid(),
            track_key: trackKey,
            patrol_id: patrolId || null,
            officer_id: user.id,
            latitude,
            longitude,
            accuracy_m: accuracy,
            recorded_at: recordedAt,
            device_id: deviceId,
            client_updated_at: now(),
            sync_status: patrolId ? "pending" : "local"
        };

        await DB.tx(["route_points", "sync_queue"], "readwrite", async (s) => {
            await DB.req(s.route_points.add(point));
            if (patrolId) {
                await Queue.enqueueIn(s.sync_queue, {
                    user_id: user.id,
                    entity_type: "route_points",
                    entity_id: point.id,
                    operation: "create",
                    payload: toPayload(point),
                    client_timestamp: point.client_updated_at
                });
            }
        });

        lastPoint.set(trackKey, point);
        return point;
    }

    async function currentOfficerId() {
        const user = await DB.getMeta("user");
        return user ? user.id : null;
    }

    // Only the logged-in officer's points, in time order.
    async function getRoute(patrolId) {
        const [points, officerId] = await Promise.all([
            DB.getByIndex("route_points", "track_key", patrolId || FREE_TRACK),
            currentOfficerId()
        ]);
        return points
            .filter((p) => !officerId || p.officer_id === officerId)
            .sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
    }

    // Stretches with no GPS fix for longer than GPS_GAP_MS.
    function findGpsGaps(points) {
        const gaps = [];
        for (let i = 1; i < points.length; i++) {
            const ms = new Date(points[i].recorded_at) - new Date(points[i - 1].recorded_at);
            if (ms > GPS_GAP_MS) {
                gaps.push({ from: points[i - 1].recorded_at, to: points[i].recorded_at, ms, afterIndex: i - 1 });
            }
        }
        return gaps;
    }

    function routeLengthMeters(points) {
        let total = 0;
        for (let i = 1; i < points.length; i++) total += distanceMeters(points[i - 1], points[i]);
        return total;
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    function getPatrol(id) {
        return DB.get("patrols", id);
    }

    // Only the logged-in officer's patrols (defence in depth: the page's
    // start-up check already removes anyone else's records).
    async function listPatrols() {
        const [patrols, officerId] = await Promise.all([DB.getAll("patrols"), currentOfficerId()]);
        return patrols
            .filter((p) => !p.deleted_at && (!officerId || p.officer_id === officerId))
            .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
    }

    // Most recent completed/abandoned patrol that has a recorded route.
    async function getLatestFinishedPatrolWithRoute() {
        for (const patrol of await listPatrols()) {
            if (patrol.status === "in_progress") continue;
            if ((await getRoute(patrol.id)).length > 0) return patrol;
        }
        return null;
    }

    async function getActivePatrol() {
        const user = await DB.getMeta("user");
        const active = await DB.getByIndex("patrols", "status", "in_progress");
        return active.find((p) => !p.deleted_at && (!user || p.officer_id === user.id)) || null;
    }

    async function getCheckpointScans(patrolId) {
        const scans = await DB.getByIndex("checkpoints", "patrol_id", patrolId);
        return scans
            .filter((c) => !c.deleted_at)
            .sort((a, b) => a.scanned_at.localeCompare(b.scanned_at));
    }

    /*
     * Expected vs visited checkpoints. On a route patrol, `expected` is the
     * route's stops IN ORDER and `next` is the first one not yet visited;
     * `skipped` lists earlier stops passed over (strict-order routes).
     */
    async function getPatrolProgress(patrolId) {
        const patrol = await getPatrol(patrolId);
        if (!patrol) throw new Error("Patrol not found: " + patrolId);

        const route = patrol.route_id ? await window.RouteCache.get(patrol.route_id) : null;
        const scans = await getCheckpointScans(patrolId);

        let expected;
        if (route) {
            const known = new Map((await window.LocationCache.getAll()).map((l) => [l.id, l]));
            expected = [...(route.stops || [])]
                .sort((a, b) => a.position - b.position)
                .map((s) => ({
                    ...(known.get(s.location_id) || {}),
                    id: s.location_id, name: s.name, code: s.code,
                    latitude: s.latitude, longitude: s.longitude, position: s.position
                }));
        } else {
            expected = patrol.location_id
                ? await window.LocationCache.getCheckpointsUnder(patrol.location_id)
                : await window.LocationCache.getCheckpoints();
        }

        const scannedIds = new Set(scans.map((s) => s.location_id));
        const visited = expected.filter((c) => scannedIds.has(c.id));
        const remaining = expected.filter((c) => !scannedIds.has(c.id));

        let skipped = [];
        if (route && route.strict_order) {
            const lastVisited = Math.max(0, ...visited.map((c) => c.position));
            skipped = remaining.filter((c) => c.position < lastVisited);
        }

        return { patrol, route, scans, expected, visited, remaining, next: remaining[0] || null, skipped };
    }

    // For the check-in screen: would checking in here break the route order?
    async function checkRouteOrder(patrolId, locationId) {
        const progress = await getPatrolProgress(patrolId);
        if (!progress.route) return { ok: true };
        const stop = progress.expected.find((c) => c.id === locationId);
        if (!stop) return { ok: false, reason: "not_on_route", progress };
        if (progress.route.strict_order && progress.next && progress.next.id !== locationId &&
            !progress.visited.some((c) => c.id === locationId)) {
            return { ok: false, reason: "out_of_order", expectedNext: progress.next, progress };
        }
        return { ok: true, progress };
    }

    // ------------------------------------------------------------------
    // Timestamps & durations
    // ------------------------------------------------------------------

    function patrolDurationMs(patrol, at = Date.now()) {
        if (!patrol || !patrol.started_at) return 0;
        const end = patrol.ended_at ? new Date(patrol.ended_at).getTime() : at;
        return Math.max(0, end - new Date(patrol.started_at).getTime());
    }

    function formatDuration(ms) {
        const totalSeconds = Math.max(0, Math.round(ms / 1000));
        const h = Math.floor(totalSeconds / 3600);
        const m = Math.floor((totalSeconds % 3600) / 60);
        const s = totalSeconds % 60;
        const pad = (n) => String(n).padStart(2, "0");
        if (h > 0) return h + "h " + pad(m) + "m " + pad(s) + "s";
        if (m > 0) return m + "m " + pad(s) + "s";
        return s + "s";
    }

    /*
     * Every timestamped point of a patrol, in order:
     *   { type: "start" | "checkpoint" | "end", at, sinceStartMs,
     *     sincePreviousMs, label, scan? }
     * plus totals: durationMs (live while in progress), isLive,
     * longestGapMs (slowest stretch between two points), distanceM.
     */
    async function getPatrolTimeline(patrolId, at = Date.now()) {
        const patrol = await getPatrol(patrolId);
        if (!patrol) throw new Error("Patrol not found: " + patrolId);

        const [scans, route] = await Promise.all([getCheckpointScans(patrolId), getRoute(patrolId)]);
        const startMs = new Date(patrol.started_at).getTime();

        const raw = [{ type: "start", at: patrol.started_at, label: "Patrol started" }];
        scans.forEach((scan) => raw.push({ type: "checkpoint", at: scan.scanned_at, scan }));
        if (patrol.ended_at) {
            raw.push({
                type: "end",
                at: patrol.ended_at,
                label: patrol.status === "abandoned" ? "Patrol abandoned" : "Patrol completed"
            });
        }

        let previousMs = startMs;
        let longestGapMs = 0;
        const events = raw.map((event) => {
            const ms = new Date(event.at).getTime();
            const sincePreviousMs = Math.max(0, ms - previousMs);
            if (event.type !== "start") longestGapMs = Math.max(longestGapMs, sincePreviousMs);
            previousMs = ms;
            return { ...event, sinceStartMs: Math.max(0, ms - startMs), sincePreviousMs };
        });

        const gpsGaps = findGpsGaps(route);

        return {
            patrol,
            events,
            durationMs: patrolDurationMs(patrol, at),
            isLive: !patrol.ended_at,
            longestGapMs,
            checkIns: scans.length,
            routePoints: route.length,
            distanceM: Math.round(routeLengthMeters(route)),
            gpsGaps,
            gpsGapMs: gpsGaps.reduce((sum, g) => sum + g.ms, 0)
        };
    }

    window.PatrolStore = {
        cacheCurrentUser,
        getCurrentUser,
        startPatrol,
        recordCheckpoint,
        updatePatrol,
        completePatrol,
        abandonPatrol,
        recordRoutePoint,
        getRoute,
        findGpsGaps,
        routeLengthMeters,
        getLatestFinishedPatrolWithRoute,
        GPS_GAP_MS,
        getPatrol,
        getActivePatrol,
        listPatrols,
        getCheckpointScans,
        getPatrolProgress,
        checkRouteOrder,
        getPatrolTimeline,
        patrolDurationMs,
        formatDuration,
        distanceMeters
    };
})();

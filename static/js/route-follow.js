/*
 * route-follow.js — keeps the officer on their patrol route.
 *
 * During a route patrol every GPS fix ("patrol:fix" from patrol-map.js)
 * is checked against the planned path with the SAME rule the server uses
 * (RouteGeo.isOffRoute mirrors _track_route_point in SQL):
 *   - leaving the corridor -> red banner + vibration, and the GPS upload is
 *     pushed straight away when online, so the supervisor's alert arrives
 *     within seconds (offline: it arrives when the device reconnects);
 *   - coming back -> banner clears;
 *   - always shows the next stop and how far away it is.
 *
 * Expects #routeBanner in the page. Exposes window.RouteFollow.state().
 */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    let route = null;
    let patrolId = null;
    let off = false;
    let offSince = null;
    let distance = null;
    let lastFix = null;
    let next = null;

    function meters(m) {
        return m >= 1000 ? (m / 1000).toFixed(1) + " km" : Math.round(m) + " m";
    }

    function bearingWord(from, to) {
        const dLng = (to.lng - from.lng) * Math.cos((from.lat * Math.PI) / 180);
        const dLat = to.lat - from.lat;
        const deg = (Math.atan2(dLng, dLat) * 180 / Math.PI + 360) % 360;
        return ["north", "north-east", "east", "south-east", "south", "south-west", "west", "north-west"][
            Math.round(deg / 45) % 8];
    }

    function render() {
        const box = $("routeBanner");
        if (!box) return;

        if (!route) {
            box.hidden = true;
            box.textContent = "";
            return;
        }
        box.hidden = false;
        box.className = "route-banner " + (off ? "route-banner-off" : "route-banner-on");

        const title = document.createElement("strong");
        const detail = document.createElement("span");

        let toNext = null;
        if (next && lastFix && next.latitude !== null && next.latitude !== undefined) {
            const target = { lat: Number(next.latitude), lng: Number(next.longitude) };
            const here = { lat: lastFix.latitude, lng: lastFix.longitude };
            toNext = meters(window.RouteGeo.distanceM(here, target)) + " " + bearingWord(here, target);
        }

        if (off) {
            title.textContent = "You are off route";
            detail.textContent = " — " + meters(distance) + " from the planned path of “" + route.name + "”. " +
                (next ? "Head back towards " + next.name + (toNext ? " (" + toNext + ")" : "") + ". " : "") +
                (navigator.onLine ? "Your supervisor has been alerted."
                                  : "Your supervisor will be alerted when you're back online.");
        } else {
            title.textContent = "On route · " + route.name;
            detail.textContent = next
                ? " — next stop " + next.position + ": " + next.name + (toNext ? " (" + toNext + ")" : "")
                : " — all stops visited";
        }

        box.replaceChildren(title, detail);
    }

    async function refreshNext() {
        if (!patrolId) return;
        try {
            const progress = await window.PatrolStore.getPatrolProgress(patrolId);
            next = progress.next;
        } catch (_) {
            next = null;
        }
        render();
    }

    async function attach(patrol) {
        route = patrol && patrol.route_id ? await window.RouteCache.get(patrol.route_id) : null;
        patrolId = route ? patrol.id : null;
        off = false;
        offSince = null;
        distance = null;
        if (window.PatrolMap) window.PatrolMap.showPlannedRoute(route);
        await refreshNext();
    }

    function onFix(event) {
        const fix = event.detail;
        if (!route || !fix || fix.patrolId !== patrolId) return;

        lastFix = fix;
        distance = window.RouteGeo.distanceToRouteM(route, fix.latitude, fix.longitude);
        const wasOff = off;
        off = window.RouteGeo.isOffRoute(route, distance, fix.accuracy, wasOff);

        if (off !== wasOff) {
            offSince = off ? Date.now() : null;
            try {
                if (navigator.vibrate) navigator.vibrate(off ? [400, 150, 400] : [120]);
            } catch (_) { /* not supported */ }

            // Get this GPS point to the server now, so the alert isn't
            // waiting for the next 30-second sync.
            if (navigator.onLine && window.SyncQueue) {
                setTimeout(() => window.SyncQueue.flush().catch(() => undefined), 300);
            }
            window.dispatchEvent(new CustomEvent("route:status", { detail: { off, distance } }));
        }
        render();
    }

    window.addEventListener("patrol:started", (e) => attach(e.detail));
    window.addEventListener("patrol:ended", () => attach(null));
    window.addEventListener("patrol:fix", onFix);
    window.addEventListener("patrol:checkin", refreshNext);
    window.addEventListener("online", render);
    window.addEventListener("offline", render);

    document.addEventListener("DOMContentLoaded", async () => {
        if (!window.AppStartup || !(await window.AppStartup)) return;
        try {
            await attach(await window.PatrolStore.getActivePatrol());
        } catch (error) {
            console.error("Route follow:", error);
        }
    });

    window.RouteFollow = {
        attach,
        state: () => ({ route, patrolId, off, offSince, distance, next })
    };
})();

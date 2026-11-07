/*
 * patrol-ui.js — the Patrol panel on the locations page.
 *
 * Start a patrol for an assigned location, check in at checkpoints
 * (scan/type a QR or NFC code, or tap a checkpoint), then complete or
 * abandon the patrol. Everything works offline: records are written to
 * IndexedDB by PatrolStore and uploaded later by SyncQueue.
 *
 * Expects the markup in templates/locations.html (ids prefixed "patrol").
 * Optional: window.getLastKnownPosition() -> {latitude, longitude} | null,
 * used to stamp check-ins with GPS when tracking is on.
 *
 * Exposes window.PatrolUI.refresh().
 */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const SYNC_LABELS = {
        pending: "Waiting to sync",
        synced: "Synced",
        conflict: "Conflict",
        error: "Sync error"
    };

    let busy = false;
    let locationNames = new Map();

    // Small DOM builder: el("li", { className: "x" }, ["text", childNode])
    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        (Array.isArray(children) ? children : [children]).forEach((child) => {
            if (child === null || child === undefined) return;
            node.append(child instanceof Node ? child : String(child));
        });
        return node;
    }

    function syncBadge(status) {
        return el("span", {
            className: "badge badge-" + (status || "pending"),
            textContent: SYNC_LABELS[status] || status || "Waiting to sync"
        });
    }

    function time(iso) {
        return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—";
    }

    function clock(iso) {
        return iso ? new Date(iso).toLocaleTimeString([], {
            hour: "2-digit", minute: "2-digit", second: "2-digit"
        }) : "—";
    }

    const dur = (ms) => PatrolStore.formatDuration(ms);

    /*
     * Timeline of a patrol: one row per timestamped point.
     *   14:02:11  Patrol started
     *   14:09:40  Front Door        +7m 29s from start · 7m 29s after previous
     *   14:31:05  Patrol completed  +28m 54s from start
     */
    function renderTimeline(list, timeline) {
        list.replaceChildren();
        timeline.events.forEach((event) => {
            const title = event.type === "checkpoint" ? nameOf(event.scan.location_id) : event.label;
            const timing = event.type === "start"
                ? null
                : el("small", {
                    className: "muted timeline-timing",
                    textContent: "+" + dur(event.sinceStartMs) + " from start · " +
                        dur(event.sincePreviousMs) + " after previous"
                });

            list.append(el("li", { className: "timeline-" + event.type }, [
                el("span", { className: "timeline-main" }, [
                    el("strong", { className: "timeline-time", textContent: clock(event.at) }),
                    " " + title,
                    event.type === "checkpoint" && event.scan.status !== "ok"
                        ? el("small", { className: "warn", textContent: "  " + event.scan.status.replace("_", " ") })
                        : null,
                    event.type === "checkpoint" && event.scan.notes
                        ? el("small", { className: "muted", textContent: "  “" + event.scan.notes + "”" })
                        : null,
                    timing
                ]),
                event.type === "checkpoint" ? syncBadge(event.scan.sync_status) : null
            ]));
        });

        if (timeline.isLive) {
            list.append(el("li", { className: "timeline-now muted" }, [
                el("span", {}, [
                    el("strong", { className: "timeline-time", textContent: "now" }),
                    " in progress · ",
                    el("span", { className: "live-elapsed", textContent: dur(timeline.durationMs) }),
                    " elapsed"
                ])
            ]));
        }
    }

    function summaryText(timeline) {
        const parts = [
            (timeline.isLive ? "Elapsed " : "Total ") + dur(timeline.durationMs),
            timeline.checkIns + " check-in(s)"
        ];
        if (timeline.checkIns > 0) parts.push("longest gap " + dur(timeline.longestGapMs));
        if (timeline.distanceM > 0) {
            parts.push(timeline.distanceM >= 1000
                ? (timeline.distanceM / 1000).toFixed(2) + " km walked"
                : timeline.distanceM + " m walked");
        }
        if (timeline.gpsGaps.length) {
            parts.push(timeline.gpsGaps.length + " GPS gap(s) totalling " + dur(timeline.gpsGapMs));
        }
        return parts.join(" · ");
    }

    function dateTime(iso) {
        return iso ? new Date(iso).toLocaleString([], {
            day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
        }) : "—";
    }

    function nameOf(locationId) {
        if (!locationId) return "All checkpoints";
        return locationNames.get(locationId) || "Unknown location";
    }

    function showMessage(text, kind = "info") {
        const box = $("patrolMessage");
        box.textContent = text || "";
        box.className = "message" + (text ? " message-" + kind : "");
    }

    function gps() {
        try {
            return typeof window.getLastKnownPosition === "function"
                ? window.getLastKnownPosition()
                : null;
        } catch (_) {
            return null;
        }
    }

    // Run an action with the buttons locked and errors shown to the user.
    async function action(fn) {
        if (busy) return;
        busy = true;
        document.querySelectorAll("#patrolPanel button").forEach((b) => { b.disabled = true; });
        try {
            await fn();
        } catch (error) {
            console.error(error);
            showMessage(error.message, "error");
        } finally {
            busy = false;
            document.querySelectorAll("#patrolPanel button").forEach((b) => { b.disabled = false; });
            await refresh();
        }
    }

    // ------------------------------------------------------------------
    // Rendering
    // ------------------------------------------------------------------

    async function renderIdle() {
        $("patrolIdle").hidden = false;
        $("patrolActive").hidden = true;

        const select = $("patrolLocation");
        const previous = select.value;
        const assigned = await LocationCache.getAssignedLocations();

        select.replaceChildren(
            el("option", { value: "", textContent: "All checkpoints" }),
            ...assigned.map((l) => el("option", {
                value: l.id,
                textContent: l.name + (l.location_type ? " (" + l.location_type + ")" : "")
            }))
        );
        if ([...select.options].some((o) => o.value === previous)) {
            select.value = previous;
        }

        // Routes assigned by a supervisor (cached for offline use).
        const routeSelect = $("patrolRoute");
        if (routeSelect) {
            const previousRoute = routeSelect.value;
            const routes = await RouteCache.getAll();
            routeSelect.replaceChildren(
                el("option", { value: "", textContent: routes.length ? "No route (free patrol)" : "No routes assigned to you" }),
                ...routes.map((r) => el("option", {
                    value: r.id,
                    textContent: r.name + " · " + (r.stops || []).length + " stops" +
                        (r.expected_minutes ? " · ~" + r.expected_minutes + " min" : "")
                }))
            );
            if ([...routeSelect.options].some((o) => o.value === previousRoute)) {
                routeSelect.value = previousRoute;
            }
            select.disabled = Boolean(routeSelect.value);
        }

        $("patrolStartButton").disabled = busy;
    }

    async function renderActive(patrol) {
        $("patrolIdle").hidden = true;
        $("patrolActive").hidden = false;

        const progress = await PatrolStore.getPatrolProgress(patrol.id);
        const total = progress.expected.length;
        const done = progress.visited.length;

        const timeline = await PatrolStore.getPatrolTimeline(patrol.id);

        $("patrolTitle").textContent = progress.route
            ? "Route: " + progress.route.name
            : "Patrol: " + nameOf(patrol.location_id);
        $("patrolMeta").replaceChildren(
            "Started " + clock(patrol.started_at) + " · ",
            syncBadge(patrol.sync_status)
        );
        $("patrolElapsed").textContent = dur(timeline.durationMs);
        $("patrolSummary").textContent = summaryText(timeline);

        if (progress.route) {
            $("patrolProgressText").textContent = done + " of " + total + " stops" +
                (progress.next ? " · next: " + progress.next.position + ". " + progress.next.name : " · route complete") +
                (progress.skipped.length ? " · skipped: " + progress.skipped.map((s) => s.name).join(", ") : "");
        } else {
            $("patrolProgressText").textContent = total
                ? done + " of " + total + " checkpoints visited"
                : progress.scans.length + " check-in(s) — no checkpoints are set up for this location";
        }
        $("patrolProgressBar").style.width = total ? Math.round((done / total) * 100) + "%" : "0%";

        // Remaining checkpoints: tap to check in manually.
        const remaining = $("patrolRemaining");
        remaining.replaceChildren();
        if (progress.remaining.length === 0) {
            remaining.append(el("li", {
                className: "muted",
                textContent: total ? "All checkpoints visited." : "Nothing to visit."
            }));
        }
        progress.remaining.forEach((checkpoint) => {
            const button = el("button", {
                type: "button",
                className: "small",
                textContent: "Check in",
                disabled: busy,
                onclick: () => checkIn(patrol.id, checkpoint, "manual")
            });
            const isNext = progress.route && progress.next && progress.next.id === checkpoint.id;
            remaining.append(el("li", { className: isNext ? "next-stop" : "" }, [
                el("span", {}, [
                    checkpoint.position ? el("strong", { textContent: checkpoint.position + ". " }) : null,
                    checkpoint.name,
                    checkpoint.code ? el("small", { className: "muted", textContent: "  " + checkpoint.code }) : null,
                    isNext ? el("small", { className: "next-tag", textContent: "  NEXT" }) : null
                ]),
                button
            ]));
        });

        // Every timestamped point so far, with time from start / since previous.
        renderTimeline($("patrolVisits"), timeline);
    }

    async function renderHistory() {
        const list = $("patrolHistory");
        const patrols = (await PatrolStore.listPatrols())
            .filter((p) => p.status !== "in_progress")
            .slice(0, 5);

        list.replaceChildren();
        if (patrols.length === 0) {
            list.append(el("li", { className: "muted", textContent: "No finished patrols on this device yet." }));
            return;
        }

        for (const patrol of patrols) {
            const timeline = await PatrolStore.getPatrolTimeline(patrol.id);
            const events = el("ul", { className: "item-list timeline" });
            renderTimeline(events, timeline);

            const details = el("details", { className: "history-details" }, [
                el("summary", {}, [
                    dateTime(patrol.started_at) + " – " + time(patrol.ended_at) + " · " +
                        nameOf(patrol.location_id) + " · ",
                    el("strong", { textContent: patrol.status }),
                    " · ",
                    el("strong", { className: "history-duration", textContent: dur(timeline.durationMs) }),
                    " ",
                    syncBadge(patrol.sync_status)
                ]),
                el("p", { className: "muted history-summary", textContent: summaryText(timeline) }),
                timeline.routePoints > 0
                    ? el("button", {
                        type: "button",
                        className: "small secondary show-route",
                        textContent: "Show route on map",
                        onclick: () => {
                            window.PatrolMap.showPatrolRoute(patrol.id)
                                .then(() => document.getElementById("map").scrollIntoView({ behavior: "smooth" }))
                                .catch((error) => showMessage(error.message, "error"));
                        }
                    })
                    : el("p", { className: "muted", textContent: "No GPS route was recorded for this patrol." }),
                events
            ]);
            list.append(el("li", { className: "history-item" }, [details]));
        }
    }

    // Tick the elapsed time of the active patrol every second.
    async function tick() {
        if ($("patrolActive").hidden) return;
        const active = await PatrolStore.getActivePatrol();
        if (!active) return;
        const text = dur(PatrolStore.patrolDurationMs(active));
        $("patrolElapsed").textContent = text;
        document.querySelectorAll("#patrolVisits .live-elapsed").forEach((n) => { n.textContent = text; });
    }

    let refreshing = null;
    let refreshAgain = false;

    async function refresh() {
        // Coalesce overlapping refreshes (sync notifications can be frequent).
        if (refreshing) {
            refreshAgain = true;
            return refreshing;
        }

        refreshing = (async () => {
            do {
                refreshAgain = false;
                try {
                    const all = await LocationCache.getAll();
                    locationNames = new Map(all.map((l) => [l.id, l.name]));

                    const active = await PatrolStore.getActivePatrol();
                    if (active) {
                        await renderActive(active);
                    } else {
                        await renderIdle();
                    }
                    await renderHistory();
                } catch (error) {
                    console.error("Patrol panel error:", error);
                    showMessage("Could not load patrol data: " + error.message, "error");
                }
            } while (refreshAgain);
        })().finally(() => { refreshing = null; });

        return refreshing;
    }

    // ------------------------------------------------------------------
    // Actions
    // ------------------------------------------------------------------

    function checkIn(patrolId, checkpoint, method) {
        return action(() => recordCheckIn(patrolId, checkpoint, method));
    }

    async function recordCheckIn(patrolId, checkpoint, method) {
        // On a route: warn before checking in out of order / off the route.
        // It's still allowed (reality wins), but the supervisor is told.
        const order = await PatrolStore.checkRouteOrder(patrolId, checkpoint.id);
        if (!order.ok) {
            const message = order.reason === "out_of_order"
                ? order.expectedNext.name + " is next on your route. Check in at " + checkpoint.name +
                  " anyway? Your supervisor will be notified that the order was changed."
                : checkpoint.name + " is not on your route. Check in anyway? Your supervisor will be notified.";
            if (!window.confirm(message)) {
                showMessage("Check-in cancelled.", "info");
                return;
            }
        }

        const position = gps();
        const status = $("patrolScanStatus").value;
        const notes = $("patrolScanNotes").value.trim();

        await PatrolStore.recordCheckpoint(patrolId, {
            location_id: checkpoint.id,
            scan_method: position && method === "manual" ? "gps" : method,
            status,
            notes: notes || null,
            latitude: position ? position.latitude : null,
            longitude: position ? position.longitude : null
        });

        $("patrolScanNotes").value = "";
        $("patrolScanStatus").value = "ok";
        window.dispatchEvent(new CustomEvent("patrol:checkin", { detail: { patrolId, locationId: checkpoint.id } }));
        showMessage(
            "Checked in at " + checkpoint.name +
            (navigator.onLine ? "." : " — saved offline, will sync later."),
            "success"
        );
    }

    function bind() {
        $("patrolStartButton").addEventListener("click", () => action(async () => {
            const routeId = ($("patrolRoute") && $("patrolRoute").value) || null;
            const locationId = routeId ? null : ($("patrolLocation").value || null);
            await PatrolStore.startPatrol({ route_id: routeId, location_id: locationId });
            showMessage(
                (routeId ? "Route patrol started" : "Patrol started") +
                (navigator.onLine ? "." : " offline — it will sync when you reconnect."),
                "success"
            );
        }));

        if ($("patrolRoute")) {
            $("patrolRoute").addEventListener("change", () => {
                $("patrolLocation").disabled = Boolean($("patrolRoute").value);
            });
        }

        $("patrolScanForm").addEventListener("submit", (event) => {
            event.preventDefault();
            const input = $("patrolCode");
            const code = input.value.trim();
            if (!code) return;

            action(async () => {
                const active = await PatrolStore.getActivePatrol();
                if (!active) throw new Error("Start a patrol first.");

                const checkpoint = await LocationCache.findByCode(code);
                if (!checkpoint) {
                    throw new Error('No checkpoint has the code "' + code + '". Refresh locations while online if it is new.');
                }
                input.value = "";
                await recordCheckIn(active.id, checkpoint, "qr");
            });
        });

        $("patrolCompleteButton").addEventListener("click", () => action(async () => {
            const active = await PatrolStore.getActivePatrol();
            if (!active) return;

            const progress = await PatrolStore.getPatrolProgress(active.id);
            if (progress.remaining.length > 0 &&
                !confirm(progress.remaining.length + " checkpoint(s) not visited. Complete anyway?")) {
                return;
            }
            const done = await PatrolStore.completePatrol(active.id);
            showMessage("Patrol completed in " + dur(PatrolStore.patrolDurationMs(done)) + ".", "success");
        }));

        $("patrolAbandonButton").addEventListener("click", () => action(async () => {
            const active = await PatrolStore.getActivePatrol();
            if (!active) return;

            const reason = prompt("Reason for abandoning this patrol (optional):");
            if (reason === null) return; // cancelled
            const ended = await PatrolStore.abandonPatrol(active.id, reason.trim() || undefined);
            showMessage("Patrol abandoned after " + dur(PatrolStore.patrolDurationMs(ended)) + ".", "info");
        }));

        // Sync status badges change as the queue uploads.
        SyncQueue.onChange(() => refresh());
    }

    document.addEventListener("DOMContentLoaded", async () => {
        // Wait for the page's start-up checks; render nothing if they fail.
        if (!window.AppStartup || !(await window.AppStartup)) return;
        bind();
        refresh();
        setInterval(() => tick().catch(() => undefined), 1000);
    });

    window.PatrolUI = { refresh };
})();

/*
 * supervisor.js — the supervisor console (templates/supervisor.html).
 *
 *  Live      map + list of active patrols (on/off route, progress, last
 *            seen) and open route alerts with "Acknowledge". Refreshes
 *            every LIVE_POLL_MS; new alerts flash a banner and the tab title.
 *  Routes    create / edit / delete routes: ordered stops (pick from the
 *            list or click checkpoint markers), corridor width, order,
 *            loop, assigned officers; place NEW checkpoints by clicking
 *            the map. Saves are versioned — if another supervisor changed
 *            the route meanwhile you are told instead of overwriting.
 *  Messages  one conversation per officer (chat.js).
 *
 * Everything is enforced again by the database (migration 003).
 */
(function () {
    "use strict";

    const LIVE_POLL_MS = 5000;
    const STALE_MS = 5 * 60 * 1000;                  // "last seen" turns amber after this

    const $ = (id) => document.getElementById(id);
    const CONFIG = (() => {
        try { return JSON.parse($("mapConfig").textContent); } catch (_) { return {}; }
    })();

    const state = {
        tab: "live",
        locations: [],
        officers: [],
        routes: [],
        overview: [],
        alerts: [],
        seenAlertIds: null,
        editing: null,          // route being edited (or a new draft)
        placingCheckpoint: false,
        pendingPoint: null,
        thread: null,           // officer id of the open conversation
        loadErrors: {}          // { locations | officers | routes: message } from the last load
    };

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        (Array.isArray(children) ? children : [children]).forEach((c) => {
            if (c !== null && c !== undefined && c !== false) node.append(c instanceof Node ? c : String(c));
        });
        return node;
    }

    async function api(method, url, body) {
        const response = await fetch(url, {
            method,
            credentials: "same-origin",
            headers: body ? { "Content-Type": "application/json" } : {},
            body: body ? JSON.stringify(body) : undefined
        });
        const data = await response.json().catch(() => ({}));
        if (response.status === 401) {
            window.location.assign("/login-page");
        }
        if (!response.ok) {
            const error = new Error(data.error || "Request failed (HTTP " + response.status + ")");
            error.status = response.status;
            throw error;
        }
        return data;
    }

    function ago(iso) {
        if (!iso) return "never";
        const s = Math.max(0, Math.round((Date.now() - new Date(iso)) / 1000));
        if (s < 60) return s + "s ago";
        if (s < 3600) return Math.floor(s / 60) + " min ago";
        return Math.floor(s / 3600) + " h " + Math.floor((s % 3600) / 60) + " min ago";
    }

    function clock(iso) {
        return iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—";
    }

    function escapeHTML(value) {
        return String(value ?? "").replace(/[&<>"']/g, (c) => ({
            "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
        })[c]);
    }

    function setMessage(id, text, kind) {
        const box = $(id);
        box.textContent = text || "";
        box.className = "message" + (kind ? " message-" + kind : "");
    }

    function coordsOf(location) {
        if (!location || location.latitude === null || location.longitude === null ||
            location.latitude === undefined || location.longitude === undefined) return null;
        const lat = Number(location.latitude);
        const lng = Number(location.longitude);
        return Number.isFinite(lat) && Number.isFinite(lng) ? [lat, lng] : null;
    }

    const checkpoints = () => state.locations.filter((l) => l.location_type === "checkpoint" && !l.deleted_at);
    const containers = () => state.locations.filter((l) => l.location_type !== "checkpoint" && !l.deleted_at);
    const locationById = (id) => state.locations.find((l) => l.id === id);

    // ------------------------------------------------------------------
    // Maps
    // ------------------------------------------------------------------

    function makeMap(id) {
        if (!window.L) {
            $(id).textContent = "Map unavailable (map library didn't load).";
            return null;
        }
        const map = L.map(id).setView([1.3521, 103.8198], 12);
        L.tileLayer(CONFIG.tileUrl || "https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
            attribution: CONFIG.attribution || "&copy; OpenStreetMap contributors",
            maxZoom: CONFIG.maxZoom || 19
        }).addTo(map);
        return map;
    }

    const liveMap = makeMap("liveMap");
    const routeMap = makeMap("routeMap");
    let liveLayers = [];
    let routeLayers = [];
    let liveFitted = false;

    function stopIcon(n) {
        return L.divIcon({ className: "stop-number", html: "<span>" + n + "</span>", iconSize: [26, 26] });
    }

    function drawPlanned(map, route, layers) {
        const pts = window.RouteGeo.path(route);
        if (pts.length > 1) {
            layers.push(L.polyline(pts, { color: "#F59E0B", weight: 5, dashArray: "10 8", opacity: 0.85 }).addTo(map));
        }
        return pts;
    }

    // ------------------------------------------------------------------
    // Live tab
    // ------------------------------------------------------------------

    function alertLabel(alert) {
        return {
            off_route: "Off route",
            back_on_route: "Back on route",
            out_of_order: "Checkpoint out of order",
            unplanned_checkpoint: "Checkpoint not on route"
        }[alert.kind] || alert.kind;
    }

    function renderLive() {
        // Patrol list
        const list = $("patrolList");
        list.replaceChildren();
        if (!state.overview.length) {
            list.append(el("li", { className: "empty", textContent: "No patrols in progress." }));
        }
        state.overview.forEach((p) => {
            const stale = !p.last_seen_at || Date.now() - new Date(p.last_seen_at) > STALE_MS;
            const status = p.route_id
                ? (p.off_route
                    ? el("span", { className: "badge badge-bad", textContent: "OFF ROUTE " + Math.round(p.distance_m) + " m" + (p.off_since ? " since " + clock(p.off_since) : "") })
                    : el("span", { className: "badge badge-ok", textContent: "On route" }))
                : el("span", { className: "badge", textContent: "Free patrol" });

            list.append(el("li", { className: "patrol-row" + (p.off_route ? " off" : "") }, [
                el("div", {}, [
                    el("strong", { textContent: p.officer_name }), " ", status,
                    el("div", { className: "muted small-text", textContent:
                        (p.route_name ? p.route_name + " · " + p.checkins + "/" + p.stops_total + " stops" : p.checkins + " check-in(s)") +
                        " · started " + clock(p.started_at) }),
                    el("div", { className: "small-text", style: stale ? "color:#B45309" : "color:#64748B",
                        textContent: "Last position " + ago(p.last_seen_at) + (stale ? " — device may be offline or GPS paused" : "") }),
                    p.open_alerts ? el("div", { className: "small-text", style: "color:#991B1B", textContent: p.open_alerts + " open alert(s)" }) : null
                ]),
                el("div", { className: "row", style: "flex:none;gap:6px" }, [
                    p.last_latitude ? el("button", { type: "button", className: "small ghost", textContent: "Locate",
                        onclick: () => liveMap && liveMap.setView([Number(p.last_latitude), Number(p.last_longitude)], 18) }) : null,
                    el("button", { type: "button", className: "small", textContent: "Message" + (p.unread_messages ? " (" + p.unread_messages + ")" : ""),
                        onclick: () => openThread(p.officer_id) })
                ])
            ]));
        });

        // Map
        if (liveMap) {
            liveLayers.forEach((layer) => liveMap.removeLayer(layer));
            liveLayers = [];
            const bounds = [];
            const drawnRoutes = new Set();

            state.overview.forEach((p) => {
                const route = state.routes.find((r) => r.id === p.route_id);
                if (route && !drawnRoutes.has(route.id)) {
                    drawnRoutes.add(route.id);
                    bounds.push(...drawPlanned(liveMap, route, liveLayers));
                }
                if (p.last_latitude) {
                    const pos = [Number(p.last_latitude), Number(p.last_longitude)];
                    bounds.push(pos);
                    liveLayers.push(L.marker(pos, {
                        icon: L.divIcon({ className: "officer-dot " + (p.off_route ? "off" : "on"), html: "<span></span>", iconSize: [18, 18] }),
                        zIndexOffset: p.off_route ? 1000 : 0
                    }).addTo(liveMap).bindPopup(
                        "<strong>" + escapeHTML(p.officer_name) + "</strong><br>" +
                        escapeHTML(p.route_name || "Free patrol") + "<br>" +
                        (p.off_route ? "Off route by " + Math.round(p.distance_m) + " m<br>" : "") +
                        "Seen " + escapeHTML(ago(p.last_seen_at))));
                }
            });

            if (!liveFitted && bounds.length) {
                liveMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
                liveFitted = true;
            }
        }

        // Alerts
        const alerts = $("alertList");
        alerts.replaceChildren();
        if (!state.alerts.length) {
            alerts.append(el("li", { className: "empty", textContent: $("showAcked").checked ? "No alerts." : "No open alerts." }));
        }
        state.alerts.forEach((a) => {
            const late = new Date(a.created_at) - new Date(a.detected_at) > 2 * 60 * 1000;
            alerts.append(el("li", { className: "alert-row" }, [
                el("div", {}, [
                    el("strong", { textContent: alertLabel(a) + (a.distance_m && a.kind === "off_route" ? " · " + Math.round(a.distance_m) + " m" : "") }),
                    el("div", { className: "small-text", textContent: a.officer_name + (a.route_name ? " · " + a.route_name : "") }),
                    a.details ? el("div", { className: "small-text muted", textContent: a.details }) : null,
                    el("div", { className: "small-text muted", textContent: "at " + clock(a.detected_at) +
                        (late ? " · reported " + clock(a.created_at) + " (device was offline)" : "") }),
                    a.acknowledged_at ? el("div", { className: "small-text muted", textContent: "acknowledged " + clock(a.acknowledged_at) }) : null
                ]),
                el("div", { className: "row", style: "flex:none;gap:6px" }, [
                    a.latitude ? el("button", { type: "button", className: "small ghost", textContent: "Map",
                        onclick: () => liveMap && liveMap.setView([Number(a.latitude), Number(a.longitude)], 18) }) : null,
                    a.acknowledged_at ? null : el("button", { type: "button", className: "small", textContent: "Acknowledge",
                        onclick: (e) => acknowledge(a.id, e.currentTarget) })
                ])
            ]));
        });

        $("liveUpdated").textContent = "Updated " + new Date().toLocaleTimeString();
    }

    function announceNewAlerts() {
        const open = state.alerts.filter((a) => !a.acknowledged_at);
        const ids = new Set(open.map((a) => a.id));
        const strip = $("alertStrip");

        if (state.seenAlertIds) {
            const fresh = open.filter((a) => !state.seenAlertIds.has(a.id));
            if (fresh.length) {
                const a = fresh[0];
                strip.textContent = "New alert: " + alertLabel(a) + " — " + a.officer_name +
                    (a.route_name ? " (" + a.route_name + ")" : "") + (fresh.length > 1 ? " and " + (fresh.length - 1) + " more" : "");
                strip.hidden = false;
            }
        }
        state.seenAlertIds = new Set([...(state.seenAlertIds || []), ...ids]);
        if (!open.length) strip.hidden = true;
        document.title = (open.length ? "(" + open.length + ") " : "") + "Supervisor Console";
    }

    let liveBusy = false;
    async function refreshLive() {
        if (liveBusy || document.visibilityState === "hidden") return;
        liveBusy = true;
        try {
            const [overview, alerts] = await Promise.all([
                api("GET", "/supervisor/overview"),
                api("GET", "/supervisor/alerts?open=" + ($("showAcked").checked ? "0" : "1") + "&limit=100")
            ]);
            state.overview = overview;
            state.alerts = alerts;
            announceNewAlerts();
            renderLive();
        } catch (error) {
            $("liveUpdated").textContent = "Can't refresh: " + error.message;
        } finally {
            liveBusy = false;
        }
    }

    async function acknowledge(id, button) {
        button.disabled = true;
        try {
            await api("POST", "/supervisor/alerts/" + id + "/ack");
            await refreshLive();
        } catch (error) {
            button.disabled = false;
            alert(error.message);
        }
    }

    // ------------------------------------------------------------------
    // Routes tab
    // ------------------------------------------------------------------

    function renderRouteList() {
        const list = $("routeList");
        list.replaceChildren();
        if (!state.routes.length) {
            list.append(el("li", { className: "empty", textContent: "No routes yet — create one with “New route”." }));
        }
        state.routes.forEach((r) => {
            list.append(el("li", {}, [
                el("div", {}, [
                    el("strong", { textContent: r.name }), " ",
                    r.is_active ? null : el("span", { className: "badge badge-warn", textContent: "inactive" }),
                    el("div", { className: "muted small-text", textContent:
                        r.stops.length + " stops · " + r.officer_ids.length + " officer(s) · ±" + r.corridor_m + " m" +
                        (r.strict_order ? " · in order" : "") + (r.is_loop ? " · loop" : "") })
                ]),
                el("button", { type: "button", className: "small", textContent: "Edit", onclick: () => editRoute(r) })
            ]));
        });
    }

    function blankRoute() {
        return { id: null, version: null, name: "", description: "", corridor_m: 50, strict_order: true,
                 is_loop: false, expected_minutes: null, is_active: true, stops: [], officer_ids: [] };
    }

    function editRoute(route) {
        state.editing = JSON.parse(JSON.stringify(route || blankRoute()));
        const r = state.editing;
        $("routeForm").hidden = false;
        $("routeFormTitle").textContent = r.id ? "Edit route" : "New route";
        $("rName").value = r.name || "";
        $("rDescription").value = r.description || "";
        $("rCorridor").value = r.corridor_m || 50;
        $("rMinutes").value = r.expected_minutes || "";
        $("rStrict").checked = r.strict_order !== false;
        $("rLoop").checked = Boolean(r.is_loop);
        $("rActive").checked = r.is_active !== false;
        $("deleteRoute").hidden = !r.id;
        setMessage("routeMessage", "");
        renderOfficerChecks();
        renderStops();
        $("rName").focus();
    }

    function closeEditor() {
        state.editing = null;
        $("routeForm").hidden = true;
        renderRouteMap();
    }

    function renderOfficerChecks() {
        const box = $("officerChecks");
        box.replaceChildren();
        const assigned = new Set(state.editing.officer_ids);
        if (!state.officers.length) {
            box.append(state.loadErrors.officers
                ? el("p", { className: "small-text", style: "color:#991B1B", textContent: "Couldn't load officers: " + state.loadErrors.officers })
                : el("p", { className: "muted small-text", textContent: "No users yet." }));
        }
        state.officers.forEach((o) => {
            const input = el("input", { type: "checkbox", checked: assigned.has(o.id), value: o.id });
            input.addEventListener("change", () => {
                const set = new Set(state.editing.officer_ids);
                if (input.checked) set.add(o.id); else set.delete(o.id);
                state.editing.officer_ids = [...set];
            });
            box.append(el("label", {}, [input, (o.full_name || o.email) + (o.role !== "officer" ? " (" + o.role + ")" : "")]));
        });
    }

    function stopDetails(locationId) {
        const l = locationById(locationId);
        return l ? { location_id: l.id, name: l.name, code: l.code, latitude: l.latitude, longitude: l.longitude }
                 : { location_id: locationId, name: "Unknown checkpoint", latitude: null, longitude: null };
    }

    function setStops(ids) {
        state.editing.stops = ids.map((id, i) => ({ ...stopDetails(id), position: i + 1 }));
        renderStops();
    }

    function addStop(locationId) {
        if (!state.editing) return;
        const ids = state.editing.stops.map((s) => s.location_id);
        ids.push(locationId);
        setStops(ids);
        setMessage("routeMessage", "Added " + stopDetails(locationId).name + " as stop " + ids.length + ".", "success");
    }

    function renderStops() {
        const list = $("stopList");
        list.replaceChildren();
        const ids = state.editing.stops.map((s) => s.location_id);
        if (!ids.length) list.append(el("li", { className: "muted small-text", textContent: "No stops yet. Pick checkpoints below or click them on the map." }));

        state.editing.stops.forEach((stop, i) => {
            const move = (delta) => {
                const next = [...ids];
                [next[i], next[i + delta]] = [next[i + delta], next[i]];
                setStops(next);
            };
            list.append(el("li", {}, [
                el("span", { className: "pos", textContent: String(i + 1) }),
                el("span", { className: "stop-name" }, [stop.name, stop.code ? el("span", { className: "muted small-text", textContent: "  " + stop.code }) : null,
                    coordsOf(stop) ? null : el("span", { className: "small-text", style: "color:#B45309", textContent: "  (no map position — not used for off-route checks)" })]),
                el("button", { type: "button", className: "small ghost", textContent: "↑", title: "Move up", disabled: i === 0, onclick: () => move(-1) }),
                el("button", { type: "button", className: "small ghost", textContent: "↓", title: "Move down", disabled: i === ids.length - 1, onclick: () => move(1) }),
                el("button", { type: "button", className: "small danger", textContent: "✕", title: "Remove",
                    onclick: () => setStops(ids.filter((_, j) => j !== i)) })
            ]));
        });

        const picker = $("stopPicker");
        const options = checkpoints()
            .sort((a, b) => a.name.localeCompare(b.name))
            .map((c) => el("option", { value: c.id, textContent: c.name + (c.code ? " · " + c.code : "") }));
        picker.replaceChildren(...(options.length ? options : [el("option", {
            value: "", disabled: true, selected: true,
            textContent: state.loadErrors.locations
                ? "Couldn't load checkpoints: " + state.loadErrors.locations
                : "No checkpoints yet — use “+ Place new checkpoint” on the map"
        })]));
        renderRouteMap();
    }

    function renderRouteMap() {
        if (!routeMap) return;
        routeLayers.forEach((layer) => routeMap.removeLayer(layer));
        routeLayers = [];
        const bounds = [];
        const inRoute = new Set(state.editing ? state.editing.stops.map((s) => s.location_id) : []);

        checkpoints().forEach((c) => {
            const pos = coordsOf(c);
            if (!pos) return;
            bounds.push(pos);
            const marker = L.circleMarker(pos, {
                radius: 7, color: inRoute.has(c.id) ? "#B45309" : "#2563EB",
                fillColor: inRoute.has(c.id) ? "#F59E0B" : "#93C5FD", fillOpacity: 0.9
            }).addTo(routeMap).bindTooltip(c.name + (c.code ? " · " + c.code : ""));
            marker.on("click", () => {
                if (state.placingCheckpoint) return;
                if (state.editing) addStop(c.id);
                else setMessage("routeMessage", "");
            });
            routeLayers.push(marker);
        });

        if (state.editing) {
            drawPlanned(routeMap, state.editing, routeLayers);
            window.RouteGeo.stopsWithCoords(state.editing).forEach((s) => {
                routeLayers.push(L.marker([s.lat, s.lng], { icon: stopIcon(s.position), interactive: false }).addTo(routeMap));
            });
        }

        if (!renderRouteMap.fitted && bounds.length) {
            routeMap.fitBounds(bounds, { padding: [40, 40], maxZoom: 18 });
            renderRouteMap.fitted = true;
        }
    }

    function readForm() {
        const r = state.editing;
        return {
            ...(r.id ? { version: r.version } : {}),
            name: $("rName").value.trim(),
            description: $("rDescription").value.trim(),
            corridor_m: Number($("rCorridor").value),
            expected_minutes: $("rMinutes").value ? Number($("rMinutes").value) : "",
            strict_order: $("rStrict").checked,
            is_loop: $("rLoop").checked,
            is_active: $("rActive").checked,
            stops: r.stops.map((s) => s.location_id),
            officer_ids: r.officer_ids
        };
    }

    async function saveRoute(event) {
        event.preventDefault();
        const body = readForm();
        if (!body.name) return setMessage("routeMessage", "Give the route a name.", "error");
        if (body.stops.length < 1) return setMessage("routeMessage", "Add at least one stop.", "error");

        $("saveRoute").disabled = true;
        try {
            const saved = state.editing.id
                ? await api("PUT", "/supervisor/routes/" + state.editing.id, body)
                : await api("POST", "/supervisor/routes", body);
            await loadRoutes();
            editRoute(saved);
            setMessage("routeMessage", "Saved (version " + saved.version + "). Assigned officers get it next time they're online.", "success");
        } catch (error) {
            setMessage("routeMessage", error.message + (error.status === 409 ? " Your changes are still in the form." : ""), "error");
            if (error.status === 409) await loadRoutes();
        } finally {
            $("saveRoute").disabled = false;
        }
    }

    async function deleteRoute() {
        const r = state.editing;
        if (!r || !r.id || !confirm("Delete route “" + r.name + "”? Officers will no longer see it. Past patrols keep their history.")) return;
        try {
            await api("DELETE", "/supervisor/routes/" + r.id);
            await loadRoutes();
            closeEditor();
        } catch (error) {
            setMessage("routeMessage", error.message, "error");
        }
    }

    // Placing a new checkpoint by clicking the map
    const ROUTE_MAP_HINT = $("routeMapHint").textContent;

    function setPlacing(on) {
        state.placingCheckpoint = on;
        $("addCheckpointMode").textContent = on ? "Click the map to place it… (cancel)" : "+ Place new checkpoint";
        $("routeMap").classList.toggle("map-mode", on);
        $("routeMapHint").textContent = on
            ? "Now click the exact spot on the map where the new checkpoint should go."
            : ROUTE_MAP_HINT;
        $("routeMapHint").style.color = "";
        if (!on && !state.pendingPoint) $("checkpointForm").hidden = true;
    }

    if (routeMap) {
        routeMap.on("click", (e) => {
            if (!state.placingCheckpoint) return;
            state.pendingPoint = { lat: Number(e.latlng.lat.toFixed(6)), lng: Number(e.latlng.lng.toFixed(6)) };
            setPlacing(false);
            routeLayers.push(L.circleMarker([state.pendingPoint.lat, state.pendingPoint.lng],
                { radius: 9, color: "#16A34A", fillColor: "#86EFAC", fillOpacity: 1 }).addTo(routeMap));
            $("checkpointForm").hidden = false;
            $("cpCoords").textContent = "Position: " + state.pendingPoint.lat + ", " + state.pendingPoint.lng;
            $("cpParent").replaceChildren(
                el("option", { value: "", textContent: "— none —" }),
                ...containers().map((l) => el("option", { value: l.id, textContent: l.name + " (" + l.location_type + ")" })));
            setMessage("cpMessage", "");
            // The form sits below the map; bring it into view so it's obvious.
            $("checkpointForm").scrollIntoView({ behavior: "smooth", block: "center" });
            $("cpName").focus({ preventScroll: true });
        });
    }

    async function createCheckpoint(event) {
        event.preventDefault();
        if (!state.pendingPoint) {
            return setMessage("cpMessage", "Click “+ Place new checkpoint”, then click the map first.", "error");
        }
        const submit = $("checkpointForm").querySelector('button[type="submit"]');
        submit.disabled = true;
        setMessage("cpMessage", "Saving…");
        try {
            const cp = await api("POST", "/supervisor/checkpoints", {
                name: $("cpName").value.trim(),
                code: $("cpCode").value.trim(),
                parent_id: $("cpParent").value || null,
                latitude: state.pendingPoint.lat,
                longitude: state.pendingPoint.lng
            });
            state.pendingPoint = null;
            setMessage("cpMessage", "");
            $("checkpointForm").reset();
            $("checkpointForm").hidden = true;
            await loadLocations();
            if (state.editing) {
                addStop(cp.id);
            } else {
                renderRouteMap();
                setMessage("routeMessage", "");
            }
            $("routeMapHint").textContent = "Created checkpoint “" + (cp.name || "") + "”. " + ROUTE_MAP_HINT;
        } catch (error) {
            setMessage("cpMessage", error.message, "error");
        } finally {
            submit.disabled = false;
        }
    }

    // ------------------------------------------------------------------
    // Messages tab
    // ------------------------------------------------------------------

    // If chat.js failed to load, keep the rest of the console (routes,
    // checkpoints, alerts) working instead of the whole script dying here.
    const chat = (() => {
        try {
            return window.Chat.mount({
                list: $("supChatList"),
                form: $("supChatForm"),
                input: $("supChatInput"),
                status: $("supChatStatus"),
                viewerIsSupervisor: true,
                officerId: () => state.thread,
                isOpen: () => state.tab === "messages" && document.visibilityState === "visible",
                pollMs: LIVE_POLL_MS
            });
        } catch (error) {
            console.error("Chat unavailable:", error);
            $("supChatStatus").textContent = "Messages unavailable — reload the page.";
            const noop = () => Promise.resolve();
            return { poll: noop, reset: noop, start: noop, stop: noop, send: noop };
        }
    })();

    function officerName(id) {
        const o = state.officers.find((x) => x.id === id);
        return o ? (o.full_name || o.email) : "Officer";
    }

    async function refreshThreads() {
        try {
            const threads = await api("GET", "/supervisor/threads");
            const unread = threads.reduce((n, t) => n + (state.thread === t.officer_id && state.tab === "messages" ? 0 : t.unread), 0);
            $("threadsUnread").textContent = unread;
            $("threadsUnread").hidden = !unread;

            const list = $("threadList");
            list.replaceChildren();
            if (!threads.length) list.append(el("li", { className: "empty", textContent: "No conversations yet." }));
            threads.forEach((t) => {
                list.append(el("li", {
                    className: state.thread === t.officer_id ? "active" : "",
                    onclick: () => openThread(t.officer_id)
                }, [
                    el("div", {}, [
                        el("strong", { textContent: t.officer_name }),
                        el("div", { className: "muted small-text", textContent: (t.last_body || "").slice(0, 70) })
                    ]),
                    t.unread ? el("span", { className: "badge badge-bad", textContent: t.unread }) : null
                ]));
            });
        } catch (error) {
            $("supChatStatus").textContent = error.message;
        }
    }

    function openThread(officerId) {
        state.thread = officerId;
        $("threadTitle").textContent = "Conversation with " + officerName(officerId);
        selectTab("messages");
        chat.reset().then(refreshThreads);
    }

    // ------------------------------------------------------------------
    // Loading & tabs
    // ------------------------------------------------------------------

    async function loadLocations() {
        const data = await api("GET", "/locations");
        state.locations = data.locations || [];
        delete state.loadErrors.locations;
    }

    async function loadRoutes() {
        state.routes = await api("GET", "/routes");
        renderRouteList();
    }

    async function loadOfficers() {
        state.officers = await api("GET", "/supervisor/officers");
        $("newThreadOfficer").replaceChildren(...state.officers.map((o) =>
            el("option", { value: o.id, textContent: (o.full_name || o.email) + (o.role !== "officer" ? " (" + o.role + ")" : "") })));
    }

    function selectTab(name) {
        state.tab = name;
        document.querySelectorAll("nav.tabs button").forEach((b) => {
            b.setAttribute("aria-selected", String(b.dataset.tab === name));
        });
        document.querySelectorAll("[data-panel]").forEach((p) => { p.hidden = p.dataset.panel !== name; });
        // Leaflet needs a size recalculation after being shown
        setTimeout(() => {
            if (liveMap) liveMap.invalidateSize();
            if (routeMap) routeMap.invalidateSize();
        }, 0);
        if (name === "messages") chat.poll();
    }

    document.querySelectorAll("nav.tabs button").forEach((b) => b.addEventListener("click", () => selectTab(b.dataset.tab)));
    $("alertStrip").addEventListener("click", () => { selectTab("live"); $("alertStrip").hidden = true; });
    $("showAcked").addEventListener("change", refreshLive);
    $("newRouteButton").addEventListener("click", () => editRoute(null));
    $("closeRouteForm").addEventListener("click", closeEditor);
    $("routeForm").addEventListener("submit", saveRoute);
    $("deleteRoute").addEventListener("click", deleteRoute);
    $("addStop").addEventListener("click", () => $("stopPicker").value && addStop($("stopPicker").value));
    $("addCheckpointMode").addEventListener("click", () => setPlacing(!state.placingCheckpoint));
    $("checkpointForm").addEventListener("submit", createCheckpoint);
    $("cpCancel").addEventListener("click", () => {
        state.pendingPoint = null;
        $("checkpointForm").hidden = true;
        renderRouteMap();
    });
    $("openThread").addEventListener("click", () => $("newThreadOfficer").value && openThread($("newThreadOfficer").value));
    $("logoutButton").addEventListener("click", async () => {
        await fetch("/logout", { method: "POST", credentials: "same-origin" }).catch(() => undefined);
        window.location.assign("/login-page");
    });

    async function start() {
        const names = ["locations", "officers", "routes"];
        const results = await Promise.allSettled([loadLocations(), loadOfficers(), loadRoutes()]);
        results.forEach((r, i) => {
            if (r.status === "rejected") {
                state.loadErrors[names[i]] = r.reason.message;
                console.error("Supervisor console: loading " + names[i] + " failed:", r.reason);
            }
        });
        const failed = results.filter((r) => r.status === "rejected").map((r) => names[results.indexOf(r)] + ": " + r.reason.message);
        if (failed.length) {
            const text = "Couldn't load: " + [...new Set(failed)].join(" · ");
            $("liveUpdated").textContent = text;
            setMessage("routeMessage", text, "error");
            $("routeMapHint").textContent = text;
            $("routeMapHint").style.color = "#991B1B";
        }
        renderRouteMap();
        await refreshLive();
        await refreshThreads();
        chat.start();
        setInterval(refreshLive, LIVE_POLL_MS);
        setInterval(refreshThreads, LIVE_POLL_MS * 2);
        document.addEventListener("visibilitychange", refreshLive);
    }

    window.Supervisor = {
        state, refreshLive, refreshThreads, loadRoutes, editRoute, addStop, openThread, selectTab,
        maps: { live: liveMap, route: routeMap },
        ready: start()
    };
})();

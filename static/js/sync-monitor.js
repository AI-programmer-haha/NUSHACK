/*
 * sync-monitor.js — the Synchronisation Monitor panel.
 *
 * Shows, live:
 *   - overall state (Offline / Syncing / Up to date / N waiting / Needs attention)
 *   - pending, conflict and rejected counts, last successful upload, device id
 *   - every queued operation with its status, attempts and last error
 *   - actions: Sync now, Retry, Discard, and conflict resolution
 *     ("Keep mine" overwrites the server, "Use server" keeps theirs)
 *   - server-side history from GET /sync/logs (what the server recorded)
 *
 * Expects the markup in templates/locations.html (ids prefixed "sync").
 */
(function () {
    "use strict";

    const $ = (id) => document.getElementById(id);

    const ENTITY_LABELS = {
        patrols: "Patrol",
        checkpoints: "Check-in",
        route_points: "GPS point",
        inspections: "Inspection",
        incidents: "Incident"
    };

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        (Array.isArray(children) ? children : [children]).forEach((child) => {
            if (child === null || child === undefined) return;
            node.append(child instanceof Node ? child : String(child));
        });
        return node;
    }

    function ago(iso) {
        if (!iso) return "Never";
        const seconds = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
        if (seconds < 10) return "Just now";
        if (seconds < 60) return seconds + "s ago";
        if (seconds < 3600) return Math.round(seconds / 60) + " min ago";
        if (seconds < 86400) return Math.round(seconds / 3600) + " h ago";
        return new Date(iso).toLocaleString();
    }

    function describe(op) {
        const what = ENTITY_LABELS[op.entity_type] || op.entity_type;
        const payload = op.payload || {};
        const merged = op.merged_edits > 1 ? " (" + op.merged_edits + " edits merged)" : "";
        if (op.entity_type === "patrols" && op.operation === "update" && payload.status) {
            return what + " → " + payload.status.replace("_", " ") + merged;
        }
        return what + " " + op.operation + merged;
    }

    function setState(text, kind) {
        const node = $("syncState");
        node.textContent = text;
        node.className = "sync-state sync-state-" + kind;

        // Mirror into the status card at the top of the page.
        const card = $("syncStatusCard");
        if (card) {
            card.textContent = text;
            card.className = kind === "ok" ? "online" : kind === "bad" ? "offline" : "";
        }
    }

    function opActions(op) {
        const act = (label, fn, className = "small") =>
            el("button", {
                type: "button",
                className,
                textContent: label,
                onclick: async (event) => {
                    event.target.disabled = true;
                    try {
                        await fn();
                    } catch (error) {
                        alert(error.message);
                    } finally {
                        render();
                    }
                }
            });

        if (op.status === "conflict") {
            return [
                act("Keep mine", () => SyncQueue.resolveConflict(op.seq, "mine")),
                act("Use server", () => SyncQueue.resolveConflict(op.seq, "server"), "small secondary")
            ];
        }
        if (op.status === "rejected") {
            return [
                act("Retry", () => SyncQueue.retry(op.seq)),
                act("Discard", () => {
                    if (!confirm("Discard this change permanently? It will never reach the server.")) return;
                    return SyncQueue.discard(op.seq);
                }, "small danger")
            ];
        }
        return [];
    }

    function opRow(op) {
        let detail = null;
        if (op.status === "failed") {
            const wait = Math.max(0, Math.round((op.next_attempt_at - Date.now()) / 1000));
            detail = "Attempt " + op.attempts + " failed: " + op.last_error +
                (wait ? " · retry in " + wait + "s" : " · retrying");
        } else if (op.status === "conflict" || op.status === "rejected") {
            detail = op.last_error;
        }

        return el("li", { className: "op op-" + op.status }, [
            el("div", { className: "op-main" }, [
                el("strong", { textContent: describe(op) }),
                el("span", { className: "badge badge-op-" + op.status, textContent: op.status }),
                el("small", { className: "muted", textContent: " " + ago(op.client_timestamp) })
            ]),
            detail ? el("div", { className: "op-detail", textContent: detail }) : null,
            el("div", { className: "op-actions" }, opActions(op))
        ]);
    }

    let rendering = false;
    let renderAgain = false;

    async function render() {
        if (rendering) {
            renderAgain = true;   // re-run once the current render finishes
            return;
        }
        rendering = true;

        try {
            const [ops, lastPush, deviceId, others] = await Promise.all([
                SyncQueue.mine(),
                SyncQueue.lastPushAt(),
                PatrolDB.getDeviceId(),
                SyncQueue.otherUsersCount()
            ]);

            const waiting = ops.filter((o) => o.status === "pending" || o.status === "failed");
            const conflicts = ops.filter((o) => o.status === "conflict");
            const rejected = ops.filter((o) => o.status === "rejected");
            const last = SyncQueue.lastResult();

            $("syncPending").textContent = waiting.length;
            $("syncConflicts").textContent = conflicts.length;
            $("syncRejected").textContent = rejected.length;
            $("syncLastPush").textContent = ago(lastPush);
            $("syncDevice").textContent = deviceId.slice(0, 8);
            $("syncDevice").title = deviceId;

            const sessionEnded = last && last.skipped === "not authenticated" && waiting.length > 0;

            if (sessionEnded) {
                // Tokens are refreshed automatically; this only happens when
                // Supabase refused the refresh too. Work stays queued.
                setState("Log in again to sync", "bad");
            } else if (conflicts.length || rejected.length) {
                setState("Needs attention", "bad");
            } else if (SyncQueue.isSyncing()) {
                setState("Syncing…", "busy");
            } else if (!navigator.onLine) {
                setState(waiting.length ? "Offline · " + waiting.length + " waiting" : "Offline", "warn");
            } else if (waiting.length) {
                setState(waiting.length + " waiting to sync", "warn");
            } else {
                setState("Up to date", "ok");
            }

            let lastText = "";
            if (last && last.skipped) {
                lastText = "Last attempt " + ago(last.at) + ": skipped (" + last.skipped + ")";
            } else if (last && last.error) {
                lastText = "Last attempt " + ago(last.at) + ": error — " + last.error;
            } else if (last) {
                lastText = "Last attempt " + ago(last.at) + ": " + last.applied + " uploaded" +
                    (last.failed ? ", " + last.failed + " failed" : "") +
                    (last.conflicts ? ", " + last.conflicts + " conflict(s)" : "") +
                    (last.rejected ? ", " + last.rejected + " rejected" : "");
            }
            if ($("syncLoginLink")) $("syncLoginLink").hidden = !sessionEnded;
            if (sessionEnded) {
                lastText = "Your login has expired. Your " + waiting.length +
                    " unsynced change(s) are safe on this device and upload after you log in again.";
            }
            if (others > 0) {
                lastText += (lastText ? " · " : "") + others +
                    " change(s) from another officer are kept for them and sync when they log in.";
            }
            $("syncLastResult").textContent = lastText;

            const list = $("syncQueueList");
            list.replaceChildren();
            if (ops.length === 0) {
                list.append(el("li", { className: "muted", textContent: "Nothing waiting — every change is on the server." }));
            } else {
                // Problems first, then the upload order. Waiting GPS points
                // are summarised in one row instead of hundreds.
                [...conflicts, ...rejected].forEach((op) => list.append(opRow(op)));

                const gps = waiting.filter((op) => op.entity_type === "route_points");
                waiting.filter((op) => op.entity_type !== "route_points").forEach((op) => list.append(opRow(op)));
                if (gps.length) {
                    const failed = gps.filter((op) => op.status === "failed").length;
                    list.append(el("li", { className: "op op-pending" }, [
                        el("div", { className: "op-main" }, [
                            el("strong", { textContent: gps.length + " GPS point(s)" }),
                            el("span", { className: "badge badge-op-pending", textContent: "pending" }),
                            el("small", { className: "muted", textContent: " oldest " + ago(gps[0].client_timestamp) })
                        ]),
                        failed ? el("div", { className: "op-detail", textContent: failed + " retrying after a failed upload" }) : null
                    ]));
                }
            }

            $("syncNowButton").disabled = !navigator.onLine || SyncQueue.isSyncing();
        } catch (error) {
            console.error("Sync monitor error:", error);
            setState("Monitor error", "bad");
        } finally {
            rendering = false;
            if (renderAgain) {
                renderAgain = false;
                render();
            }
        }
    }

    async function loadServerHistory() {
        const list = $("syncServerLog");

        if (!navigator.onLine) {
            list.replaceChildren(el("li", { className: "muted", textContent: "Connect to the internet to view server history." }));
            return;
        }

        list.replaceChildren(el("li", { className: "muted", textContent: "Loading…" }));
        try {
            const response = await fetch("/sync/logs?limit=20", { credentials: "same-origin" });
            if (!response.ok) throw new Error("HTTP " + response.status);
            const { logs } = await response.json();

            list.replaceChildren();
            if (!logs.length) {
                list.append(el("li", { className: "muted", textContent: "The server has no sync records for you yet." }));
            }
            logs.forEach((log) => {
                list.append(el("li", { className: "op op-" + log.status }, [
                    el("div", { className: "op-main" }, [
                        el("strong", { textContent: describe(log) }),
                        el("span", { className: "badge badge-op-" + log.status, textContent: log.status }),
                        el("small", { className: "muted", textContent: " " + ago(log.received_at) }),
                        log.result_version
                            ? el("small", { className: "muted", textContent: " · v" + log.result_version })
                            : null
                    ]),
                    log.error_message ? el("div", { className: "op-detail", textContent: log.error_message }) : null
                ]));
            });
        } catch (error) {
            list.replaceChildren(el("li", { className: "muted", textContent: "Could not load server history (" + error.message + ")." }));
        }
    }

    document.addEventListener("DOMContentLoaded", async () => {
        // Wait for the page's start-up checks; render nothing if they fail.
        if (!window.AppStartup || !(await window.AppStartup)) return;

        $("syncNowButton").addEventListener("click", async () => {
            $("syncNowButton").disabled = true;
            try {
                await SyncQueue.flush();
            } catch (error) {
                console.error(error);
            }
            render();
        });

        $("syncHistory").addEventListener("toggle", (event) => {
            if (event.target.open) loadServerHistory();
        });

        SyncQueue.onChange(render);
        window.addEventListener("online", render);
        window.addEventListener("offline", render);
        setInterval(render, 5000); // keeps "x min ago" and retry countdowns fresh
        render();
    });

    window.SyncMonitor = { render };
})();

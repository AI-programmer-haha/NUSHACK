/*
 * sync-queue.js — durable outbox of changes made on this device.
 *
 * Every local write (see patrol-store.js) adds an operation here in the SAME
 * IndexedDB transaction as the record itself. flush() pushes pending ops to
 * POST /sync/push, where Postgres applies and logs each one atomically.
 *
 * Each op carries a client_op_id (UUID). The server records it in
 * sync_logs.client_op_id (UNIQUE), so a push retried after a dropped
 * connection is answered from the log and never applied twice.
 *
 * Avoiding false conflicts when one record is edited several times offline:
 *   1. Coalescing — an update is merged into the record's previous queued op
 *      if that op has never been sent (attempts === 0). Ten offline edits
 *      to a patrol become one upload.
 *   2. One op per record per batch — a later op for the same record waits
 *      until the earlier one's result is known.
 *   3. Rebase — when an op is applied (server version b -> r), later queued
 *      ops for that record that were also based on b move to base r.
 * A conflict is therefore reported only when someone ELSE changed the record.
 *
 * Ordering: a check-in / GPS point is not sent before its patrol's "create"
 * has been sent (or in the same batch, ahead of it).
 *
 * Ownership: ops are tagged with the officer's user_id and only sent while
 * that officer is logged in — never under someone else's session.
 *
 * Exposes window.SyncQueue:
 *   enqueueIn(queueStore, op)   add (or coalesce) inside an existing transaction
 *   enqueue(op)                 same, in its own transaction
 *   all() / pending() / pendingCount() / conflicts() / otherUsersCount()
 *   flush()                     push now; returns a summary
 *   retry(seq, baseVersion?) / resolveConflict(seq, "mine"|"server") / discard(seq)
 *   start({ intervalMs }) / stop() / onChange(listener)
 *   lastPushAt() / lastResult() / isSyncing()
 *
 * Server contract: see sync_service.py.
 */
(function () {
    "use strict";

    const DB = window.PatrolDB;

    const SYNC_ENDPOINT = "/sync/push";
    const BATCH_SIZE = 50;
    const MAX_BACKOFF_MS = 5 * 60 * 1000;

    const ENTITY_TYPES = ["patrols", "checkpoints", "route_points", "inspections", "incidents"];
    const OPERATIONS = ["create", "update", "delete"];

    // Entity types that have a local IndexedDB store to keep in step.
    const LOCAL_STORES = ["patrols", "checkpoints", "route_points"];

    // Op statuses:
    //   pending   waiting to be sent
    //   failed    sent but no answer (network / 5xx); retried after next_attempt_at
    //   conflict  someone else changed the record; needs a decision
    //   rejected  server refused it (validation); kept for inspection
    // Applied ops are deleted. `attempts` counts sends: an op with
    // attempts > 0 may already be on the server, so it is never modified
    // (only re-sent as-is, under the same client_op_id).

    let flushing = null;
    let lastResult = null;
    let timer = null;
    const listeners = new Set();

    const keyOf = (op) => op.entity_type + ":" + op.entity_id;
    const isReady = (op, now) =>
        (op.status === "pending" || op.status === "failed") && (op.next_attempt_at || 0) <= now;

    async function currentUserId() {
        const user = await DB.getMeta("user");
        return user ? user.id : null;
    }

    // Ops of the logged-in officer (untagged legacy ops count as theirs).
    function belongsTo(op, userId) {
        return !userId || !op.user_id || op.user_id === userId;
    }

    function parentKeyOf(op) {
        const patrolId = op.payload && op.payload.patrol_id;
        return op.entity_type !== "patrols" && patrolId ? "patrols:" + patrolId : null;
    }

    function buildOp(op) {
        if (!ENTITY_TYPES.includes(op.entity_type)) {
            throw new Error("Unknown entity_type: " + op.entity_type);
        }
        if (!OPERATIONS.includes(op.operation)) {
            throw new Error("Unknown operation: " + op.operation);
        }
        if (!op.entity_id) {
            throw new Error("entity_id is required");
        }

        return {
            client_op_id: DB.uuid(),
            user_id: op.user_id || null,
            entity_type: op.entity_type,
            entity_id: op.entity_id,
            operation: op.operation,
            base_version: op.base_version ?? null,
            payload: op.payload ?? null,
            client_timestamp: op.client_timestamp || new Date().toISOString(),
            status: "pending",
            attempts: 0,
            next_attempt_at: 0,
            last_error: null,
            server_snapshot: null,
            merged_edits: 1
        };
    }

    // ------------------------------------------------------------------
    // Enqueue (with coalescing)
    // ------------------------------------------------------------------

    // Use inside DB.tx([... , "sync_queue"], "readwrite", ...)
    async function enqueueIn(queueStore, op) {
        const record = buildOp(op);

        if (record.operation === "update") {
            const existing = await DB.req(
                queueStore.index("entity").getAll([record.entity_type, record.entity_id])
            );
            const last = existing.sort((a, b) => a.seq - b.seq).pop();

            if (
                last &&
                last.status === "pending" &&
                last.attempts === 0 &&                     // never sent: safe to change
                (last.operation === "create" || last.operation === "update") &&
                last.user_id === record.user_id
            ) {
                last.payload = { ...(last.payload || {}), ...(record.payload || {}) };
                last.client_timestamp = record.client_timestamp;
                last.merged_edits = (last.merged_edits || 1) + 1;
                await DB.req(queueStore.put(last));
                notifySoon();
                return last;
            }
        }

        const seq = await DB.req(queueStore.add(record));
        notifySoon();
        return { ...record, seq };
    }

    function enqueue(op) {
        return DB.tx("sync_queue", "readwrite", (s) => enqueueIn(s.sync_queue, op));
    }

    // ------------------------------------------------------------------
    // Reads
    // ------------------------------------------------------------------

    function all() {
        return DB.getAll("sync_queue"); // ordered by seq (primary key)
    }

    async function mine() {
        const [ops, userId] = await Promise.all([all(), currentUserId()]);
        return ops.filter((op) => belongsTo(op, userId));
    }

    async function pending() {
        return (await mine()).filter((op) => op.status === "pending" || op.status === "failed");
    }

    async function pendingCount() {
        return (await pending()).length;
    }

    async function conflicts() {
        return (await mine()).filter((op) => op.status === "conflict");
    }

    // Unsynced work of another officer who used this device without logging out.
    async function otherUsersCount() {
        const [ops, userId] = await Promise.all([all(), currentUserId()]);
        return ops.filter((op) => !belongsTo(op, userId)).length;
    }

    function lastPushAt() {
        return DB.getMeta("last_push_at");
    }

    // ------------------------------------------------------------------
    // Manual actions (monitor)
    // ------------------------------------------------------------------

    // Drop an op. Dropping a never-uploaded patrol "create" also drops its
    // check-ins / GPS points, which could never be accepted without it.
    async function discard(seq) {
        await DB.tx("sync_queue", "readwrite", async (s) => {
            const op = await DB.req(s.sync_queue.get(seq));
            if (!op) return;
            await DB.req(s.sync_queue.delete(seq));

            if (op.entity_type === "patrols" && op.operation === "create") {
                const ops = await DB.req(s.sync_queue.getAll());
                for (const child of ops) {
                    if (parentKeyOf(child) === keyOf(op) && child.operation === "create") {
                        await DB.req(s.sync_queue.delete(child.seq));
                    }
                }
            }
        });
        notifySoon();
    }

    // Requeue a conflict/rejected op, optionally rebased on a new version.
    // It gets a NEW client_op_id: the server remembers the old id's outcome
    // and would otherwise just return the same answer again. Later ops for
    // the same record that shared the old base move with it.
    async function retry(seq, baseVersion) {
        await DB.tx("sync_queue", "readwrite", async (s) => {
            const op = await DB.req(s.sync_queue.get(seq));
            if (!op) return;

            const oldBase = op.base_version;
            op.client_op_id = DB.uuid();
            op.status = "pending";
            op.attempts = 0;
            op.next_attempt_at = 0;
            op.last_error = null;
            op.server_snapshot = null;

            if (baseVersion !== undefined && baseVersion !== oldBase) {
                op.base_version = baseVersion;
                const later = await DB.req(
                    s.sync_queue.index("entity").getAll([op.entity_type, op.entity_id])
                );
                for (const other of later) {
                    if (other.seq > op.seq && other.base_version === oldBase) {
                        other.base_version = baseVersion;
                        await DB.req(s.sync_queue.put(other));
                    }
                }
            }

            await DB.req(s.sync_queue.put(op));
        });
        notifySoon();
        return flush();
    }

    /*
     * Settle a conflict.
     *   "mine"   — overwrite the server: resend my change on top of the
     *              server's current version.
     *   "server" — keep the server's version: drop my queued changes to
     *              this record and replace the local copy with the server's.
     */
    async function resolveConflict(seq, choice) {
        const op = await DB.get("sync_queue", seq);
        if (!op || op.status !== "conflict") {
            throw new Error("No conflict with seq " + seq);
        }
        const snapshot = op.server_snapshot;

        if (choice === "mine") {
            if (!snapshot || !Number.isInteger(snapshot.version)) {
                throw new Error("Conflict has no server version to rebase on.");
            }
            return retry(seq, snapshot.version);
        }

        if (choice === "server") {
            const stores = ["sync_queue"];
            if (LOCAL_STORES.includes(op.entity_type)) stores.push(op.entity_type);

            await DB.tx(stores, "readwrite", async (s) => {
                const sameRecord = await DB.req(
                    s.sync_queue.index("entity").getAll([op.entity_type, op.entity_id])
                );
                for (const other of sameRecord) {
                    if (other.seq >= op.seq) await DB.req(s.sync_queue.delete(other.seq));
                }
                if (snapshot && snapshot.id && s[op.entity_type]) {
                    const local = await DB.req(s[op.entity_type].get(op.entity_id));
                    await DB.req(s[op.entity_type].put({
                        ...(local || {}), ...snapshot, sync_status: "synced"
                    }));
                }
            });
            notifySoon();
            return;
        }

        throw new Error('choice must be "mine" or "server"');
    }

    // ------------------------------------------------------------------
    // Flush
    // ------------------------------------------------------------------

    function flush() {
        // One flush at a time per tab; Web Locks (when available) also stop
        // two open tabs from pushing the same ops simultaneously.
        if (flushing) {
            return flushing;
        }

        const run = navigator.locks
            ? navigator.locks.request("patrol-sync-flush", { ifAvailable: true }, (lock) =>
                lock ? doFlush() : { skipped: "another tab is syncing" })
            : doFlush();

        notifySoon(); // let the monitor show "Syncing…"
        flushing = Promise.resolve(run)
            .then((summary) => {
                lastResult = { ...summary, at: new Date().toISOString() };
                return summary;
            })
            .catch((error) => {
                lastResult = { error: error.message, at: new Date().toISOString() };
                throw error;
            })
            .finally(() => {
                flushing = null;
                notifySoon();
            });

        return flushing;
    }

    /*
     * Choose what to send, in queue order:
     *  - only the current officer's ops that are ready (not in backoff,
     *    not waiting on a decision);
     *  - at most one op per record (the next one waits for this result);
     *  - nothing for a record that has an earlier op still waiting;
     *  - no check-in / GPS point whose patrol "create" isn't being sent
     *    in this batch or already done.
     */
    function selectBatch(ops, userId, now) {
        const chosen = [];
        const picked = new Set();
        const blocked = new Set();
        const unsentCreates = new Set();

        for (const op of ops) {
            if (!belongsTo(op, userId)) continue;

            const key = keyOf(op);
            const parent = parentKeyOf(op);

            const canSend =
                chosen.length < BATCH_SIZE &&
                isReady(op, now) &&
                !blocked.has(key) &&
                !picked.has(key) &&
                !(parent && unsentCreates.has(parent));

            if (canSend) {
                picked.add(key);
                chosen.push(op);
                continue;
            }

            if (!picked.has(key)) blocked.add(key);           // later ops of this record wait
            if (op.operation === "create") unsentCreates.add(key);
        }

        return chosen;
    }

    async function doFlush() {
        const summary = { sent: 0, applied: 0, conflicts: 0, rejected: 0, failed: 0 };

        if (!navigator.onLine) {
            return { ...summary, skipped: "offline" };
        }

        const [deviceId, userId] = await Promise.all([DB.getDeviceId(), currentUserId()]);

        // Keep going while there is something sendable (each round can
        // unblock the next op of a record via rebase).
        for (let round = 0; round < 100; round++) {
            const batch = selectBatch(await all(), userId, Date.now());
            if (batch.length === 0) {
                break;
            }

            await markSending(batch);

            let response;
            try {
                response = await fetch(SYNC_ENDPOINT, {
                    method: "POST",
                    credentials: "same-origin",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                        device_id: deviceId,
                        operations: batch.map(toWire)
                    })
                });
            } catch (error) {
                await markFailed(batch, "Network error: " + error.message);
                summary.failed += batch.length;
                break;
            }

            if (response.status === 401 || response.status === 403) {
                // Not logged in / not allowed: keep everything for later.
                await markFailed(batch, "Not authenticated (HTTP " + response.status + ")", true);
                return { ...summary, skipped: "not authenticated" };
            }

            if (!response.ok) {
                await markFailed(batch, "HTTP " + response.status);
                summary.failed += batch.length;
                break;
            }

            const body = await response.json().catch(() => ({}));
            const results = Array.isArray(body.results) ? body.results : [];

            summary.sent += batch.length;
            const counts = await applyResults(batch, results);
            summary.applied += counts.applied;
            summary.conflicts += counts.conflicts;
            summary.rejected += counts.rejected;
            summary.failed += counts.failed;

            if (counts.applied + counts.conflicts + counts.rejected === 0) {
                break;
            }
        }

        if (summary.applied > 0) {
            await DB.setMeta("last_push_at", new Date().toISOString());
        }

        return summary;
    }

    function toWire(op) {
        return {
            client_op_id: op.client_op_id,
            entity_type: op.entity_type,
            entity_id: op.entity_id,
            operation: op.operation,
            base_version: op.base_version,
            payload: op.payload,
            client_timestamp: op.client_timestamp
        };
    }

    function backoffMs(attempts) {
        const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** attempts);
        return base / 2 + Math.random() * (base / 2); // jitter
    }

    // Record the send BEFORE it happens: from now on this op may be on the
    // server, so coalescing must never change it again.
    async function markSending(ops) {
        await DB.tx("sync_queue", "readwrite", async (s) => {
            for (const op of ops) {
                const fresh = await DB.req(s.sync_queue.get(op.seq));
                if (!fresh) continue;
                fresh.attempts += 1;
                fresh.last_attempt_at = Date.now();
                Object.assign(op, fresh);
                await DB.req(s.sync_queue.put(fresh));
            }
        });
    }

    async function markFailed(ops, message, noBackoff = false) {
        await DB.tx("sync_queue", "readwrite", async (s) => {
            for (const op of ops) {
                const fresh = await DB.req(s.sync_queue.get(op.seq));
                if (!fresh) continue;
                fresh.status = "failed";
                fresh.last_error = message;
                fresh.next_attempt_at = noBackoff ? 0 : Date.now() + backoffMs(fresh.attempts);
                await DB.req(s.sync_queue.put(fresh));
            }
        });
    }

    async function applyResults(ops, results) {
        const byId = new Map(results.map((r) => [r.client_op_id, r]));
        const counts = { applied: 0, conflicts: 0, rejected: 0, failed: 0 };
        const missing = [];

        await DB.tx(["sync_queue", ...LOCAL_STORES], "readwrite", async (s) => {
            for (const op of ops) {
                const result = byId.get(op.client_op_id);

                if (!result) {
                    missing.push(op);
                    continue;
                }

                if (result.status === "applied") {
                    await DB.req(s.sync_queue.delete(op.seq));
                    await rebaseLaterOps(s, op, result.result_version);
                    await markEntitySynced(s, op, result.result_version);
                    counts.applied += 1;
                } else if (result.status === "conflict") {
                    op.status = "conflict";
                    op.server_snapshot = result.server_snapshot ?? null;
                    op.last_error = result.error ?? "Server has a newer version.";
                    await DB.req(s.sync_queue.put(op));
                    await setEntitySyncStatus(s, op, "conflict");
                    counts.conflicts += 1;
                } else {
                    op.status = "rejected";
                    op.last_error = result.error ?? "Rejected by server.";
                    await DB.req(s.sync_queue.put(op));
                    await setEntitySyncStatus(s, op, "error");
                    counts.rejected += 1;
                }
            }
        });

        if (missing.length) {
            await markFailed(missing, "No result returned by server.");
            counts.failed += missing.length;
        }

        return counts;
    }

    // The server moved the record from op.base_version to resultVersion.
    // Queued ops for the same record edited from that same old version
    // (made while this one was waiting/in flight) now build on the new one.
    async function rebaseLaterOps(stores, op, resultVersion) {
        if (op.operation === "create" || !Number.isInteger(resultVersion)) return;

        const later = await DB.req(
            stores.sync_queue.index("entity").getAll([op.entity_type, op.entity_id])
        );
        for (const other of later) {
            if (other.seq > op.seq && other.base_version === op.base_version) {
                other.base_version = resultVersion;
                await DB.req(stores.sync_queue.put(other));
            }
        }
    }

    // Update the cached record's version so the next edit uses the right
    // base_version; mark it "synced" only if no other op for it is queued.
    async function markEntitySynced(stores, op, resultVersion) {
        const store = stores[op.entity_type];
        if (!store) return;

        const record = await DB.req(store.get(op.entity_id));
        if (!record) return;

        if (Number.isInteger(resultVersion)) {
            record.version = resultVersion;
        }

        const stillQueued = await DB.req(
            stores.sync_queue.index("entity").count([op.entity_type, op.entity_id])
        );
        record.sync_status = stillQueued > 0 ? "pending" : "synced";

        await DB.req(store.put(record));
    }

    async function setEntitySyncStatus(stores, op, status) {
        const store = stores[op.entity_type];
        if (!store) return;
        const record = await DB.req(store.get(op.entity_id));
        if (!record) return;
        record.sync_status = status;
        await DB.req(store.put(record));
    }

    // ------------------------------------------------------------------
    // Auto-sync + change notifications
    // ------------------------------------------------------------------

    function onOnline() {
        flush();
    }

    function onVisible() {
        if (document.visibilityState === "visible") flush();
    }

    function start(options = {}) {
        const intervalMs = options.intervalMs ?? 30000;
        stop();
        window.addEventListener("online", onOnline);
        document.addEventListener("visibilitychange", onVisible);
        timer = setInterval(() => {
            if (navigator.onLine) flush();
        }, intervalMs);
        flush();
    }

    function stop() {
        window.removeEventListener("online", onOnline);
        document.removeEventListener("visibilitychange", onVisible);
        if (timer) clearInterval(timer);
        timer = null;
    }

    function onChange(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
    }

    let notifyScheduled = false;
    function notifySoon() {
        if (notifyScheduled || listeners.size === 0) return;
        notifyScheduled = true;
        setTimeout(async () => {
            notifyScheduled = false;
            try {
                const ops = await mine();
                const state = {
                    pending: ops.filter((o) => o.status === "pending" || o.status === "failed").length,
                    conflicts: ops.filter((o) => o.status === "conflict").length,
                    rejected: ops.filter((o) => o.status === "rejected").length
                };
                listeners.forEach((fn) => fn(state));
            } catch (error) {
                console.error("SyncQueue notify failed:", error);
            }
        }, 0);
    }

    window.SyncQueue = {
        SYNC_ENDPOINT,
        ENTITY_TYPES,
        enqueueIn,
        enqueue,
        all,
        mine,
        pending,
        pendingCount,
        conflicts,
        otherUsersCount,
        discard,
        retry,
        resolveConflict,
        lastPushAt,
        lastResult: () => lastResult,
        isSyncing: () => flushing !== null,
        flush,
        start,
        stop,
        onChange,
        _selectBatch: selectBatch      // exposed for tests
    };
})();

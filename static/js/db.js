/*
 * db.js — IndexedDB setup for the offline-first patrol app.
 *
 * Exposes window.PatrolDB with:
 *   open()                       -> Promise<IDBDatabase> (cached connection)
 *   tx(stores, mode, fn)         -> run fn(storesByName, transaction) in ONE
 *                                   transaction; resolves with fn's return
 *                                   value once the transaction COMMITS.
 *   req(idbRequest)              -> promisify a single IDBRequest
 *   get/getAll/put/del/clear     -> one-liners for simple reads/writes
 *   getMeta(key) / setMeta(key, value)
 *   getDeviceId()                -> stable per-browser device id (UUID)
 *   uuid()                       -> RFC 4122 v4 UUID
 *   wipe()                       -> delete all local data (e.g. on logout)
 *
 * Store layout (mirrors database/schema.sql):
 *   meta         key/value settings: device_id, user, last sync times
 *   locations    cached buildings / areas / checkpoints (read-only on device)
 *   patrols      patrols created or synced on this device
 *   checkpoints  checkpoint scans recorded during patrols
 *   sync_queue   pending operations to push to the server, FIFO by `seq`
 */
(function () {
    "use strict";

    const DB_NAME = "security-patrol";
    const DB_VERSION = 3;

    // Everything here except meta.device_id belongs to the logged-in
    // officer and is removed by wipe() on logout.
    const DATA_STORES = ["locations", "patrols", "checkpoints", "route_points", "routes"];

    let dbPromise = null;

    // ------------------------------------------------------------------
    // UUIDs
    // crypto.randomUUID() only exists in secure contexts (https/localhost).
    // Phones testing against http://192.168.x.x would not have it, so fall
    // back to getRandomValues(), which works everywhere.
    // ------------------------------------------------------------------
    function uuid() {
        if (window.crypto && typeof crypto.randomUUID === "function") {
            return crypto.randomUUID();
        }

        const bytes = crypto.getRandomValues(new Uint8Array(16));
        bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
        bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant

        const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0"));
        return (
            hex.slice(0, 4).join("") + "-" +
            hex.slice(4, 6).join("") + "-" +
            hex.slice(6, 8).join("") + "-" +
            hex.slice(8, 10).join("") + "-" +
            hex.slice(10, 16).join("")
        );
    }

    // ------------------------------------------------------------------
    // Schema / migrations. Add a new `if (oldVersion < N)` block and bump
    // DB_VERSION whenever stores or indexes change — never edit old blocks.
    // ------------------------------------------------------------------
    function upgrade(db, oldVersion) {
        if (oldVersion < 1) {
            db.createObjectStore("meta", { keyPath: "key" });

            const locations = db.createObjectStore("locations", { keyPath: "id" });
            locations.createIndex("parent_id", "parent_id");
            locations.createIndex("location_type", "location_type");
            locations.createIndex("code", "code");

            const patrols = db.createObjectStore("patrols", { keyPath: "id" });
            patrols.createIndex("status", "status");
            patrols.createIndex("officer_id", "officer_id");
            patrols.createIndex("sync_status", "sync_status");

            const checkpoints = db.createObjectStore("checkpoints", { keyPath: "id" });
            checkpoints.createIndex("patrol_id", "patrol_id");
            checkpoints.createIndex("location_id", "location_id");
            checkpoints.createIndex("sync_status", "sync_status");

            // autoIncrement `seq` gives a strict FIFO order, so a patrol's
            // "create" is always pushed before its checkpoints' "create".
            const queue = db.createObjectStore("sync_queue", {
                keyPath: "seq",
                autoIncrement: true
            });
            queue.createIndex("client_op_id", "client_op_id", { unique: true });
            queue.createIndex("status", "status");
            queue.createIndex("entity", ["entity_type", "entity_id"]);
        }

        if (oldVersion < 2) {
            // GPS fixes. track_key = patrol id, or "free" for tracking
            // outside a patrol (kept on the device only, never uploaded).
            const route = db.createObjectStore("route_points", { keyPath: "id" });
            route.createIndex("track_key", "track_key");
            route.createIndex("patrol_id", "patrol_id");
        }

        if (oldVersion < 3) {
            // Patrol routes assigned to this officer (with their ordered
            // stops), cached so route following works offline.
            db.createObjectStore("routes", { keyPath: "id" });
        }
    }

    function open() {
        if (dbPromise) {
            return dbPromise;
        }

        dbPromise = new Promise((resolve, reject) => {
            if (!("indexedDB" in window)) {
                reject(new Error("IndexedDB is not supported in this browser."));
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onupgradeneeded = (event) => {
                upgrade(request.result, event.oldVersion);
            };

            request.onsuccess = () => {
                const db = request.result;

                // Another tab upgraded the schema: close so it can proceed,
                // and reopen lazily on the next call.
                db.onversionchange = () => {
                    db.close();
                    dbPromise = null;
                };

                resolve(db);
            };

            request.onerror = () => {
                dbPromise = null;
                reject(request.error);
            };

            request.onblocked = () => {
                console.warn("IndexedDB upgrade blocked: close other tabs of this app.");
            };
        });

        return dbPromise;
    }

    function req(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /*
     * Run several reads/writes atomically. Either every write in `fn`
     * commits, or none do — this is what lets the patrol store save a record
     * AND its sync-queue entry together.
     *
     * Note: don't `await` non-IndexedDB work (fetch, timers) inside fn — the
     * transaction auto-commits as soon as it has no pending requests.
     */
    async function tx(storeNames, mode, fn) {
        const db = await open();
        const names = Array.isArray(storeNames) ? storeNames : [storeNames];
        const transaction = db.transaction(names, mode);

        const stores = {};
        names.forEach((name) => {
            stores[name] = transaction.objectStore(name);
        });

        const done = new Promise((resolve, reject) => {
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error || new Error("Transaction aborted"));
        });

        let result;
        try {
            result = await fn(stores, transaction);
        } catch (error) {
            done.catch(() => { /* abort rejection is expected; report `error` */ });
            try { transaction.abort(); } catch (_) { /* already finished */ }
            throw error;
        }

        await done;
        return result;
    }

    // Simple helpers ----------------------------------------------------

    const get = (store, key) => tx(store, "readonly", (s) => req(s[store].get(key)));
    const getAll = (store) => tx(store, "readonly", (s) => req(s[store].getAll()));
    const put = (store, value) => tx(store, "readwrite", (s) => req(s[store].put(value)));
    const del = (store, key) => tx(store, "readwrite", (s) => req(s[store].delete(key)));
    const clear = (store) => tx(store, "readwrite", (s) => req(s[store].clear()));

    function getByIndex(store, indexName, value) {
        return tx(store, "readonly", (s) => req(s[store].index(indexName).getAll(value)));
    }

    async function getMeta(key) {
        const row = await get("meta", key);
        return row ? row.value : undefined;
    }

    function setMeta(key, value) {
        return put("meta", { key, value });
    }

    // Device id is generated once and kept forever (survives logout), so the
    // server's device_id columns identify the physical device.
    let deviceIdPromise = null;

    function getDeviceId() {
        if (!deviceIdPromise) {
            deviceIdPromise = tx("meta", "readwrite", async (s) => {
                const row = await req(s.meta.get("device_id"));
                if (row) {
                    return row.value;
                }
                const id = uuid();
                await req(s.meta.put({ key: "device_id", value: id }));
                return id;
            }).catch((error) => {
                deviceIdPromise = null;
                throw error;
            });
        }
        return deviceIdPromise;
    }

    /*
     * Remove the officer's data from this device. Keeps only device_id.
     *
     *   wipe()                      logout: everything goes, including
     *                               unsynced operations (Session.logout()
     *                               syncs or asks first).
     *   wipe({ keepQueue: true })   a DIFFERENT officer logged in without a
     *                               logout: their records go, but queued
     *                               operations stay (tagged with their
     *                               user_id, only ever sent in their
     *                               session) so no work is lost.
     */
    async function wipe(options = {}) {
        const stores = [...DATA_STORES];
        if (!options.keepQueue) {
            stores.push("sync_queue");
        }

        await tx([...stores, "meta"], "readwrite", async (s) => {
            await Promise.all(stores.map((name) => req(s[name].clear())));

            const metaKeys = await req(s.meta.getAllKeys());
            await Promise.all(
                metaKeys
                    .filter((key) => key !== "device_id")
                    .map((key) => req(s.meta.delete(key)))
            );
        });
    }

    window.PatrolDB = {
        DB_NAME,
        DB_VERSION,
        DATA_STORES,
        open,
        tx,
        req,
        get,
        getAll,
        getByIndex,
        put,
        del,
        clear,
        getMeta,
        setMeta,
        getDeviceId,
        uuid,
        wipe
    };
})();

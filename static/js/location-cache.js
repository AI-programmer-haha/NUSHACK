/*
 * location-cache.js — offline copy of the officer's assigned locations.
 *
 * The /locations endpoint uses the officer's own token (get_user_db), so
 * whatever it returns is what this officer is allowed/assigned to see.
 * That list is a tree via parent_id:  building -> area -> checkpoint.
 *
 * Exposes window.LocationCache:
 *   refresh()                    fetch /locations and replace the cache
 *   load()                       refresh if online, otherwise use the cache;
 *                                returns { locations, fromCache, lastSyncedAt }
 *   getAll()                     all cached, active locations
 *   getAssignedLocations()       buildings + areas (patrol targets)
 *   getCheckpoints()             every cached checkpoint
 *   getCheckpointsUnder(id)      checkpoints anywhere beneath a building/area
 *   getChildren(id)
 *   findByCode(code)             resolve a scanned QR / NFC tag value
 *   lastSyncedAt()
 */
(function () {
    "use strict";

    const DB = window.PatrolDB;
    const ENDPOINT = "/locations";
    const LEGACY_LOCALSTORAGE_KEY = "saved_locations";

    function isActive(location) {
        return !location.deleted_at && location.is_active !== false;
    }

    function byName(a, b) {
        return String(a.name || "").localeCompare(String(b.name || ""));
    }

    async function replaceAll(locations) {
        const syncedAt = new Date().toISOString();

        // Clear + insert in one transaction so readers never see a half-
        // written cache, and locations removed on the server disappear.
        await DB.tx(["locations", "meta"], "readwrite", async (s) => {
            await DB.req(s.locations.clear());
            for (const location of locations) {
                if (location && location.id) {
                    await DB.req(s.locations.put(location));
                }
            }
            await DB.req(s.meta.put({ key: "locations_synced_at", value: syncedAt }));
        });

        return syncedAt;
    }

    async function refresh() {
        const response = await fetch(ENDPOINT, {
            method: "GET",
            credentials: "same-origin"
        });

        if (response.status === 401) {
            const error = new Error("Not logged in.");
            error.status = 401;
            throw error;
        }
        if (!response.ok) {
            throw new Error("Failed to retrieve locations (HTTP " + response.status + ").");
        }

        const data = await response.json();
        const locations = Array.isArray(data.locations) ? data.locations : [];
        await replaceAll(locations);
        return locations.filter(isActive).sort(byName);
    }

    async function load() {
        await migrateFromLocalStorage();

        if (navigator.onLine) {
            try {
                const locations = await refresh();
                return { locations, fromCache: false, lastSyncedAt: await lastSyncedAt() };
            } catch (error) {
                if (error.status === 401) throw error;
                console.warn("Using cached locations:", error);
            }
        }

        return { locations: await getAll(), fromCache: true, lastSyncedAt: await lastSyncedAt() };
    }

    async function getAll() {
        return (await DB.getAll("locations")).filter(isActive).sort(byName);
    }

    async function getAssignedLocations() {
        return (await getAll()).filter((l) => l.location_type !== "checkpoint");
    }

    async function getCheckpoints() {
        return (await DB.getByIndex("locations", "location_type", "checkpoint"))
            .filter(isActive)
            .sort(byName);
    }

    async function getChildren(parentId) {
        return (await DB.getByIndex("locations", "parent_id", parentId))
            .filter(isActive)
            .sort(byName);
    }

    async function getCheckpointsUnder(locationId) {
        const all = await getAll();
        const childrenOf = new Map();
        all.forEach((l) => {
            if (!l.parent_id) return;
            if (!childrenOf.has(l.parent_id)) childrenOf.set(l.parent_id, []);
            childrenOf.get(l.parent_id).push(l);
        });

        const result = [];
        const seen = new Set([locationId]);
        const stack = [locationId];

        while (stack.length) {
            const id = stack.pop();
            for (const child of childrenOf.get(id) || []) {
                if (seen.has(child.id)) continue; // guard against bad cycles
                seen.add(child.id);
                if (child.location_type === "checkpoint") result.push(child);
                stack.push(child.id);
            }
        }

        // The location itself may be a checkpoint.
        const self = all.find((l) => l.id === locationId);
        if (self && self.location_type === "checkpoint") result.unshift(self);

        return result.sort(byName);
    }

    async function findByCode(code) {
        if (!code) return null;
        const matches = await DB.getByIndex("locations", "code", String(code).trim());
        return matches.find(isActive) || null;
    }

    function lastSyncedAt() {
        return DB.getMeta("locations_synced_at");
    }

    // One-time move of the old localStorage cache into IndexedDB.
    let migrated = false;
    async function migrateFromLocalStorage() {
        if (migrated) return;
        migrated = true;

        let raw;
        try {
            raw = localStorage.getItem(LEGACY_LOCALSTORAGE_KEY);
        } catch (_) {
            return;
        }
        if (!raw) return;

        try {
            const existing = await DB.getAll("locations");
            const legacy = JSON.parse(raw);
            if (existing.length === 0 && Array.isArray(legacy)) {
                await replaceAll(legacy);
            }
            localStorage.removeItem(LEGACY_LOCALSTORAGE_KEY);
        } catch (error) {
            console.warn("Could not migrate legacy location cache:", error);
        }
    }

    window.LocationCache = {
        refresh,
        load,
        getAll,
        getAssignedLocations,
        getCheckpoints,
        getCheckpointsUnder,
        getChildren,
        findByCode,
        lastSyncedAt
    };
})();

/*
 * session.js — logging out without leaving the officer's data behind.
 *
 * Session.logout():
 *   1. stops GPS tracking and background sync,
 *   2. tries to upload unsynced work first; if some is still unsynced
 *      (offline, server down, conflicts) the officer must confirm that it
 *      will be permanently deleted from this device,
 *   3. tells the server to end the session (POST /logout),
 *   4. wipes IndexedDB (patrols, check-ins, GPS route, locations, profile,
 *      outbox), the cached private page in the service worker, and the
 *      legacy localStorage cache,
 *   5. goes to the login page.
 *
 * Offline logout: the server session can't be ended yet, so a flag is
 * left and the next page load (online) finishes the logout before
 * showing anything.
 *
 * Exposes window.Session = { logout, finishPendingLogout }.
 */
(function () {
    "use strict";

    const PENDING_FLAG = "patrol_logout_pending";
    const PRIVATE_PAGES = ["/locations-page"];
    const LEGACY_KEYS = ["saved_locations"];

    function setFlag(on) {
        try {
            if (on) localStorage.setItem(PENDING_FLAG, "1");
            else localStorage.removeItem(PENDING_FLAG);
        } catch (_) { /* storage blocked: nothing to persist */ }
    }

    function hasFlag() {
        try {
            return localStorage.getItem(PENDING_FLAG) === "1";
        } catch (_) {
            return false;
        }
    }

    async function clearPrivateCaches() {
        if (!("caches" in window)) return;
        try {
            const names = await caches.keys();
            await Promise.all(names.map(async (name) => {
                const cache = await caches.open(name);
                await Promise.all(PRIVATE_PAGES.map((path) =>
                    cache.delete(new URL(path, window.location.origin).href, { ignoreSearch: true })));
            }));
        } catch (error) {
            console.warn("Could not clear cached pages:", error);
        }
    }

    function clearLegacyStorage() {
        try {
            LEGACY_KEYS.forEach((key) => localStorage.removeItem(key));
        } catch (_) { /* ignore */ }
    }

    async function endServerSession() {
        try {
            const response = await fetch("/logout", { method: "POST", credentials: "same-origin" });
            return response.ok;
        } catch (_) {
            return false;
        }
    }

    async function wipeDevice() {
        await window.PatrolDB.wipe();          // everything except device_id
        await clearPrivateCaches();
        clearLegacyStorage();
    }

    /*
     * options.confirm(message) -> boolean   (defaults to window.confirm)
     * Returns false if the officer cancelled.
     */
    async function logout(options = {}) {
        const ask = options.confirm || ((message) => window.confirm(message));

        if (typeof window.stopTracking === "function") window.stopTracking();
        window.SyncQueue.stop();

        if (navigator.onLine) {
            try {
                await window.SyncQueue.flush();
            } catch (error) {
                console.warn("Final sync before logout failed:", error);
            }
        }

        const unsynced = (await window.SyncQueue.mine()).length;
        if (unsynced > 0) {
            const ok = ask(
                unsynced + " change(s) have not reached the server" +
                (navigator.onLine ? "" : " because you are offline") +
                ". Logging out now will permanently delete them from this device.\n\n" +
                "Cancel to stay logged in and sync later."
            );
            if (!ok) {
                window.SyncQueue.start();
                return false;
            }
        }

        const serverDone = await endServerSession();
        setFlag(!serverDone);              // finish on next online load

        await wipeDevice();

        window.location.assign("/login-page");
        return true;
    }

    /*
     * Call first thing on private pages. If an offline logout is pending,
     * finish it (end server session, wipe again) and leave the page.
     * Resolves true if the page should stop loading.
     */
    async function finishPendingLogout() {
        if (!hasFlag()) return false;

        await wipeDevice();

        if (navigator.onLine && await endServerSession()) {
            setFlag(false);
        }

        window.location.assign("/login-page");
        return true;
    }

    window.Session = { logout, finishPendingLogout };
})();

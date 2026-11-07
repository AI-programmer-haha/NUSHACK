/*
 * chat.js — officer <-> supervisor messages (online only).
 *
 * One conversation per officer with the supervisor team. Route alerts
 * raised by the server appear in the same thread as system messages.
 * Messages are NOT stored on the device (nothing to leak after logout);
 * while offline the composer is disabled and says why.
 *
 *   const chat = Chat.mount({
 *       list, form, input, status,          // elements
 *       officerId: () => id | null,         // supervisors: whose thread; officers: null (own)
 *       isOpen: () => bool,                 // thread visible -> mark incoming as read
 *       pollMs: 10000,
 *       onIncoming(messages)                // new messages from the other side
 *   });
 *   chat.reset(); chat.poll(); chat.send(text)
 */
(function () {
    "use strict";

    function el(tag, props = {}, children = []) {
        const node = document.createElement(tag);
        Object.assign(node, props);
        (Array.isArray(children) ? children : [children]).forEach((c) => {
            if (c !== null && c !== undefined) node.append(c instanceof Node ? c : String(c));
        });
        return node;
    }

    function stamp(iso) {
        const d = new Date(iso);
        const sameDay = d.toDateString() === new Date().toDateString();
        return sameDay
            ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
            : d.toLocaleString([], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    }

    function mount(options) {
        const { list, form, input, status } = options;
        const pollMs = options.pollMs || 10000;
        const officerId = options.officerId || (() => null);
        const isOpen = options.isOpen || (() => true);
        const viewerIsSupervisor = Boolean(options.viewerIsSupervisor);

        let lastAt = null;
        let seen = new Set();
        let polling = false;
        let timer = null;
        let generation = 0;

        function mine(message) {
            // From the viewer's side of the conversation?
            return viewerIsSupervisor ? message.from_supervisor : (!message.from_supervisor && message.sender_id);
        }

        function render(messages) {
            const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
            if (list.querySelector(".chat-empty")) list.replaceChildren();

            messages.forEach((m) => {
                if (seen.has(m.id)) return;
                seen.add(m.id);
                const kind = m.kind === "alert" ? "chat-alert" : (mine(m) ? "chat-mine" : "chat-theirs");
                list.append(el("li", { className: "chat-msg " + kind }, [
                    el("div", { className: "chat-meta" }, [
                        el("strong", { textContent: m.kind === "alert" ? "Route alert" : m.sender_name }),
                        " · " + stamp(m.created_at)
                    ]),
                    el("div", { className: "chat-body", textContent: m.body })
                ]));
            });

            if (!list.children.length) {
                list.append(el("li", { className: "chat-empty muted", textContent: "No messages yet." }));
            }
            if (atBottom || messages.length) list.scrollTop = list.scrollHeight;
        }

        function setStatus(text) {
            if (status) status.textContent = text || "";
        }

        function updateComposer() {
            const online = navigator.onLine;
            const target = viewerIsSupervisor ? officerId() : true;
            input.disabled = !online || !target;
            const button = form.querySelector("button");
            if (button) button.disabled = input.disabled;
            input.placeholder = !online
                ? "Messages need an internet connection"
                : (!target ? "Choose an officer first" : "Type a message");
        }

        async function poll() {
            updateComposer();
            if (polling || !navigator.onLine || document.visibilityState === "hidden") return;
            if (viewerIsSupervisor && !officerId()) return;

            polling = true;
            const myGeneration = generation;
            try {
                const params = new URLSearchParams();
                if (officerId()) params.set("officer_id", officerId());
                if (lastAt) params.set("after", lastAt);
                const response = await fetch("/messages?" + params.toString(), { credentials: "same-origin" });
                if (!response.ok) {
                    setStatus(response.status === 401 ? "Log in again to use messages." : "Messages unavailable right now.");
                    return;
                }
                const messages = await response.json();
                if (myGeneration !== generation) return;          // thread switched meanwhile

                if (messages.length) {
                    lastAt = messages[messages.length - 1].created_at;
                    const incoming = messages.filter((m) => !seen.has(m.id) && !mine(m));
                    render(messages);
                    if (incoming.length && options.onIncoming) options.onIncoming(incoming);
                } else if (!list.children.length) {
                    render([]);
                }
                setStatus("");

                if (isOpen()) {
                    await fetch("/messages/read", {
                        method: "POST", credentials: "same-origin",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify(officerId() ? { officer_id: officerId() } : {})
                    }).catch(() => undefined);
                }
            } catch (_) {
                setStatus("Can't reach the server — messages will resume when you're online.");
            } finally {
                polling = false;
            }
        }

        async function send(text) {
            const body = String(text || "").trim();
            if (!body) return null;
            if (!navigator.onLine) throw new Error("You're offline — messages need a connection.");

            const payload = { body };
            if (officerId()) payload.officer_id = officerId();
            if (options.patrolId) {
                const patrolId = await options.patrolId();
                if (patrolId) payload.patrol_id = patrolId;
            }
            const response = await fetch("/messages", {
                method: "POST", credentials: "same-origin",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok) throw new Error(data.error || "Message not sent.");
            await poll();
            return data;
        }

        form.addEventListener("submit", async (event) => {
            event.preventDefault();
            const text = input.value;
            input.disabled = true;
            try {
                await send(text);
                input.value = "";
                setStatus("");
            } catch (error) {
                setStatus(error.message);
            } finally {
                updateComposer();
                input.focus();
            }
        });

        function reset() {
            generation += 1;
            lastAt = null;
            seen = new Set();
            list.replaceChildren();
            updateComposer();
            return poll();
        }

        function start() {
            stop();
            timer = setInterval(poll, pollMs);
            window.addEventListener("online", poll);
            window.addEventListener("offline", updateComposer);
            document.addEventListener("visibilitychange", poll);
            return poll();
        }

        function stop() {
            if (timer) clearInterval(timer);
            timer = null;
        }

        updateComposer();
        return { poll, send, reset, start, stop };
    }

    window.Chat = { mount };
})();

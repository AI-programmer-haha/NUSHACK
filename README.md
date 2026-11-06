# NUSHACK
NUSHACK project GPS
# Title
GPS locating and communication system for patrols

---

# Features
*  **Live GPS tracking system** Allows the real time location to be sync with supervisor or saved locally
*  **Route planning and alert** Enables the supervisor to plan the route beforehand, and if patrol strays off assigned route, an alert is sent to the supervisor
*  **Communication system** Allows the messages to sync after being online, allows patrol to communicate with supervisor
*  **User actions sync queue** Shows the real time actions and status of the user e.g Offline/online, Location, Alerts

---

# Tech Stack
*   **Frontend:** Vanilla JavaScript (ES6+), HTML5 Canvas/Maps API, Service Workers, IndexedDB API
*   **Backend:** Python 3.13 (`app.py`, `sync_service.py`, `auth_session.py`)
*   **Database:** Supabase / PostgreSQL (Schema includes atomic migrations for auth profiles, sync state, and routing logs)
*   **API Protocol:** REST / JSON Messaging API (Tested via `.http` files)

---

## Project Structure

```text
Hackathon/
├── .claude/               # IDE/AI configuration environments
├── database/              # DB layer configurations
│   ├── migrations/        # SQL migration files (001_auth, 002_sync, 003_routes)
│   └── schema.sql         # Primary PostgreSQL database schema
├── static/                # Frontend Assets
│   ├── js/                # Core application scripting architecture
│   │   ├── chat.js            # Real-time message exchange logic
│   │   ├── db.js              # IndexedDB interface wrapper
│   │   ├── location-cache.js  # Offline GPS coordinates caching
│   │   ├── patrol-map.js      # Map drawing and rendering engine
│   │   ├── patrol-store.js    # State management system
│   │   ├── patrol-ui.js       # Dynamic DOM updates and events
│   │   ├── route-cache.js     # Path and waypoint optimization store
│   │   ├── route-follow.js    # Core patrol orientation algorithm
│   │   ├── session.js         # Client authentication handling
│   │   ├── supervisor.js      # Admin view controller logic
│   │   ├── sync-monitor.js    # Network connectivity listener UI
│   │   └── sync-queue.js      # Queue mechanism for deferred actions
│   ├── offline.html       # Visual fallback page for zero-connectivity
│   └── service-worker.js  # Network interceptor and asset cacher
├── templates/             # Server-rendered HTML frames
│   ├── forbidden.html     # Auth restriction view
│   ├── locations.html     # Fleet geo-tracking interface
│   ├── login.html         # User entry point portal
│   └── supervisor.html    # Command hub viewport dashboard
├── app.py                 # Core application entry point
├── auth_session.py        # Token validations and session logic
├── sync_service.py        # Synchronization backend coordinator
├── test.http              # Native API integration test scripts
└── .env.example           # Reference blueprint for secrets

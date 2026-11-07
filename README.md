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

Hackathon/
├── app.py                  
├── auth_session.py         
├── sync_service.py                
├── .env.example
├── test.http
├── database/
│   ├── schema.sql
│   ├── migrations/
│   │   ├── 001_supabase_auth_profiles.sql
│   │   ├── 002_atomic_sync.sql
│   │   └── 003_routes_alerts_messages.sql
│   ├── check_setup.sql             # read-only health check
│   └── repair_existing_tables.sql  # adds missing columns to old tables
├── templates/
│   ├── login.html  locations.html  supervisor.html
│   └── profile.html  forbidden.html
└── static/
    ├── service-worker.js   # app shell and map tile caching
    ├── offline.html
    └── js/
        ├── db.js             # IndexedDB wrapper (PatrolDB)
        ├── patrol-store.js   # local-first patrols, check-ins, GPS points
        ├── sync-queue.js     # durable outbox, coalescing and rebasing
        ├── sync-monitor.js   # Synchronisation Monitor panel
        ├── location-cache.js # offline copy of assigned locations
        ├── route-cache.js    # offline routes + RouteGeo distance maths
        ├── route-follow.js   # off-route banner and next stop
        ├── patrol-map.js     # Leaflet map, GPS tracking, offline tiles
        ├── patrol-ui.js      # Patrol panel
        ├── supervisor.js     # Supervisor console
        ├── chat.js           # officer ↔ supervisor messaging
        └── session.js        # safe logout and local data wipe

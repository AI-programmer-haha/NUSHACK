
import os
import uuid
from datetime import datetime, timezone
from functools import wraps

import click
import httpx
from flask import send_from_directory
from dotenv import load_dotenv
from postgrest.exceptions import APIError
from flask import (
    Flask,
    abort,
    jsonify,
    redirect,
    request,
    session,
    g,
    render_template
)
from supabase import create_client

from auth_session import AuthExpired, AuthUnavailable, authenticate
from sync_service import (
    MAX_OPERATIONS_PER_PUSH,
    SyncRequestError,
    TransientSyncError,
    process_operations,
)

# --------------------------------------------------
# CONFIGURATION
# --------------------------------------------------

load_dotenv()

app = Flask(__name__)

app.secret_key = os.getenv("SECRET_KEY", "dev-only-change-me")

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_KEY")

if not SUPABASE_URL or not SUPABASE_KEY:
    raise RuntimeError("Missing SUPABASE_URL or SUPABASE_KEY in .env")

db = create_client(SUPABASE_URL, SUPABASE_KEY)


# --------------------------------------------------
# HELPER FUNCTIONS
# --------------------------------------------------

def get_data():
    return request.get_json(silent=True) or {}


def get_user_db():
    """Create a database client using the logged-in user's token."""
    user_db = create_client(SUPABASE_URL, SUPABASE_KEY)
    user_db.postgrest.auth(session["access_token"])
    return user_db


PROFILE_COLUMNS = "id,username,email,full_name,role,created_at"


def fetch_profile(client, user_id):
    result = (
        client.table("users")
        .select(PROFILE_COLUMNS)
        .eq("id", str(user_id))
        .limit(1)
        .execute()
    )
    return result.data[0] if result.data else None


def ensure_profile(client, user_id, email, full_name, username=None):
    """Create the public.users row for an auth user if it's missing."""

    username = (
        (username or "").strip()
        or (email or "").split("@")[0]
    )

    client.table("users").upsert(
        {
            "id": str(user_id),
            "username": username,
            "email": (email or "").lower(),
            "full_name": full_name or "",
            "role": "officer"
        },
        on_conflict="id",
        ignore_duplicates=True
    ).execute()

def _wants_page():
    return request.method == "GET" and "text/html" in request.headers.get("Accept", "")


def login_required(function):
    """Require a valid Supabase session, refreshing expired tokens
    (auth_session.py). Supabase being unreachable is a 503 that keeps the
    session; only a session Supabase rejects for good is cleared."""
    @wraps(function)
    def wrapper(*args, **kwargs):

        try:
            g.user = authenticate(
                create_client(SUPABASE_URL, SUPABASE_KEY),
                session
            )

        except AuthUnavailable as e:
            print("AUTH SERVICE UNAVAILABLE:", e)
            return jsonify({
                "error": "Login service unreachable. You are still logged in; try again shortly."
            }), 503

        except AuthExpired as e:
            print("SESSION ENDED:", e)
            session.clear()
            if _wants_page():
                return redirect("/login-page")
            return jsonify({"error": "Your session has expired. Please log in again."}), 401

        return function(*args, **kwargs)

    return wrapper


# --------------------------------------------------
# MAP TILES
# OpenStreetMap's tile servers forbid bulk/offline downloading. The app
# therefore only offers "Save map for offline" for tiles you are allowed to
# store: your own tile set (MAP_TILES_DIR, served at /tiles/...) or a
# provider whose licence permits it (MAP_TILES_OFFLINE=1). It is never
# enabled for tile.openstreetmap.org, whatever the settings say.
# --------------------------------------------------

OSM_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png"
OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
LOCAL_TILE_URL = "/tiles/{z}/{x}/{y}.png"
MAP_TILES_DIR = os.getenv("MAP_TILES_DIR", os.path.join(app.root_path, "tiles"))


def _env_int(name, default):
    try:
        return int(os.getenv(name, default))
    except ValueError:
        return default


def map_config():
    custom_url = os.getenv("MAP_TILE_URL", "").strip()
    local_tiles = os.path.isdir(MAP_TILES_DIR) and any(os.scandir(MAP_TILES_DIR))

    if custom_url:
        provider, url = "custom", custom_url
        attribution = os.getenv("MAP_TILE_ATTRIBUTION", "").strip()
        offline = os.getenv("MAP_TILES_OFFLINE", "0") == "1"
    elif local_tiles:
        provider, url = "local", LOCAL_TILE_URL
        attribution = os.getenv("MAP_TILE_ATTRIBUTION", OSM_ATTRIBUTION)
        offline = True
    else:
        provider, url, attribution, offline = "osm", OSM_TILE_URL, OSM_ATTRIBUTION, False

    if "openstreetmap.org" in url:
        offline = False            # policy: no bulk/offline downloads from OSM

    return {
        "provider": provider,
        "tileUrl": url,
        "attribution": attribution or OSM_ATTRIBUTION,
        "maxZoom": _env_int("MAP_TILE_MAX_ZOOM", 19),
        "offlineDownload": offline,
        "offlineMinZoom": _env_int("MAP_OFFLINE_MIN_ZOOM", 14),
        "offlineMaxZoom": _env_int("MAP_OFFLINE_MAX_ZOOM", 19),
        "offlineMaxTiles": _env_int("MAP_OFFLINE_MAX_TILES", 2000),
    }


# --------------------------------------------------
# HOME
# --------------------------------------------------

@app.route("/")
def home():
    return redirect("/login-page")


# --------------------------------------------------
# 1. USER REGISTRATION
# --------------------------------------------------

@app.route("/register", methods=["POST"])
def register():

    data = get_data()

    email = (data.get("email") or "").strip().lower()
    password = data.get("password", "")
    full_name = (data.get("full_name") or "").strip()
    username = (data.get("username") or "").strip()

    # Validate registration details
    if not email or not password or not username:
        return jsonify({
            "error": "Email, username and password are required."
        }), 400

    if len(password) < 8:
        return jsonify({
            "error": "Password must be at least 8 characters."
        }), 400

    if len(username) < 3:
        return jsonify({
            "error": "Username must be at least 3 characters."
        }), 400

    auth_client = create_client(SUPABASE_URL, SUPABASE_KEY)

    try:
        # Create Supabase Auth account
        result = auth_client.auth.sign_up({
            "email": email,
            "password": password,
            "options": {
                "data": {
                    "username": username,
                    "full_name": full_name
                }
            }
        })

        if not result.user:
            return jsonify({
                "error": "Registration failed."
            }), 400

        # Create profile if the database trigger hasn't done so
        try:
            ensure_profile(
                db,
                result.user.id,
                email,
                full_name,
                username
            )

        except Exception as e:
            print("PROFILE WARNING:", repr(e))

        # Save session if email confirmation is disabled
        if result.session:
            session["access_token"] = result.session.access_token
            session["refresh_token"] = result.session.refresh_token

        return jsonify({
            "message": "Account created successfully.",
            "user_id": result.user.id,
            "logged_in": result.session is not None
        }), 201

    except Exception as e:
        print("REGISTRATION ERROR:", repr(e))

        return jsonify({
            "error": "Registration failed. Please try again."
        }), 400


# --------------------------------------------------
# 2. USER LOGIN
# --------------------------------------------------

@app.route("/login", methods=["POST"])
def login():

    data = get_data()

    email = data.get("email", "").strip().lower()
    password = data.get("password", "")

    if not email or not password:
        return jsonify({
            "error": "Email and password are required."
        }), 400

    auth_client = create_client(SUPABASE_URL, SUPABASE_KEY)

    try:
        result = auth_client.auth.sign_in_with_password({
            "email": email,
            "password": password
        })

        session["access_token"] = result.session.access_token
        session["refresh_token"] = result.session.refresh_token

        return jsonify({
            "message": "Login successful."
        }), 200

    except Exception as e:
        print("LOGIN ERROR:", repr(e))

        return jsonify({
            "error": "Login failed. Please try again."
        }), 401


# --------------------------------------------------
# 3. USER LOGOUT
# --------------------------------------------------

@app.route("/logout", methods=["POST"])
def logout():

    session.clear()

    response = jsonify({
        "message": "Logged out successfully."
    })

    # Ask the browser to drop its HTTP cache for this site. IndexedDB and
    # the service worker caches are wiped by static/js/session.js, which
    # first makes sure unsynced patrol work isn't lost by accident.
    response.headers["Clear-Site-Data"] = '"cache"'

    return response


# Authenticated data must never be stored by the browser's HTTP cache —
# the app keeps its own offline copy in IndexedDB, wiped on logout.
NO_STORE_PATHS = ("/me", "/locations", "/sync/", "/locations-page", "/logout",
                  "/routes", "/messages", "/supervisor")


@app.after_request
def no_store_for_private_data(response):
    if request.path.startswith(NO_STORE_PATHS):
        response.headers["Cache-Control"] = "no-store"
    return response


# --------------------------------------------------
# 4. CURRENT USER
# --------------------------------------------------

@app.route("/me", methods=["GET"])
@login_required
def get_current_user():

    try:
        user_db = get_user_db()

        profile = fetch_profile(user_db, g.user.id)

        # Accounts created before the profile trigger existed have no
        # public.users row, which would break patrols (officer_id FK).
        if not profile:
            metadata = getattr(g.user, "user_metadata", None) or {}
            ensure_profile(
                user_db,
                g.user.id,
                g.user.email,
                metadata.get("full_name", ""),
                metadata.get("username")
            )
            profile = fetch_profile(user_db, g.user.id)

        if not profile:
            return jsonify({"error": "User profile not found."}), 404

        # Opened in the browser (Profile button) -> profile page.
        # Called from JavaScript (patrol-store.js) -> JSON, as before.
        if _wants_page():
            return render_template(
                "profile.html",
                profile=profile,
                is_supervisor=profile.get("role") in SUPERVISOR_ROLES
            )

        return jsonify(profile), 200

    except Exception as e:
        print("USER ERROR:", repr(e))

        return jsonify({
            "error": "Could not retrieve user information."
        }), 500


# --------------------------------------------------
# 5. RETRIEVE LOCATIONS
# --------------------------------------------------

@app.route("/locations", methods=["GET"])
@login_required
def get_locations():

    try:
        user_db = get_user_db()

        result = (
            user_db.table("locations")
            .select("*")
            .order("name")
            .execute()
        )

        return jsonify({
            "locations": result.data
        }), 200

    except Exception as e:
        print("LOCATIONS ERROR:", repr(e))

        return jsonify({
            "error": "Could not retrieve locations."
        }), 500


# --------------------------------------------------
# 6. LOCATIONS WEBSITE
# --------------------------------------------------
@app.route("/login-page")
def login_page():
    return render_template("login.html")
@app.route("/locations-page", methods=["GET"])
@login_required
def locations_page():

    # The page compares user_id with the officer cached on the device and
    # wipes a previous officer's offline data before showing anything.
    return render_template(
        "locations.html",
        user_id=str(g.user.id),
        map_config=map_config(),
        is_supervisor=current_role() in SUPERVISOR_ROLES
    )


@app.route("/tiles/<int:z>/<int:x>/<int:y>.<ext>")
@login_required
def local_tile(z, x, y, ext):
    """Your own map tiles (e.g. a site plan), which may be stored offline."""
    if ext not in ("png", "jpg", "jpeg", "webp") or not (0 <= z <= 24):
        abort(404)
    response = send_from_directory(MAP_TILES_DIR, f"{z}/{x}/{y}.{ext}")
    response.headers["Cache-Control"] = "private, max-age=604800"
    return response
# --------------------------------------------------
# 7. OFFLINE SYNC
# --------------------------------------------------

@app.route("/sync/push", methods=["POST"])
@login_required
def sync_push():
    """Apply operations queued offline by static/js/sync-queue.js.
    Logic and guarantees: see sync_service.py."""

    data = get_data()

    device_id = str(data.get("device_id") or "").strip()[:100]
    operations = data.get("operations")

    if not device_id:
        return jsonify({"error": "device_id is required."}), 400

    if not isinstance(operations, list):
        return jsonify({"error": "operations must be a list."}), 400

    if len(operations) > MAX_OPERATIONS_PER_PUSH:
        # Not an error: extra ops get no result and are sent next time.
        operations = operations[:MAX_OPERATIONS_PER_PUSH]

    # Applied + logged atomically inside Postgres (apply_sync_batch); the
    # user is taken from this token by the database, not from the body.
    # It also updates users.last_sync_at in the same transaction.
    try:
        results = process_operations(
            get_user_db(),
            device_id,
            operations
        )
    except SyncRequestError as e:
        return jsonify({"error": str(e)}), e.status
    except TransientSyncError as e:
        print("SYNC UNAVAILABLE:", e)
        return jsonify({
            "error": "Sync temporarily unavailable. Nothing was saved; try again later."
        }), 503

    return jsonify({"results": results}), 200


@app.route("/sync/logs", methods=["GET"])
@login_required
def sync_logs():
    """Recent server-side sync history for the logged-in user (monitor)."""

    try:
        limit = max(1, min(int(request.args.get("limit", 20)), 100))
    except ValueError:
        limit = 20

    try:
        result = (
            get_user_db().table("sync_logs")
            .select("client_op_id,entity_type,entity_id,operation,status,"
                    "base_version,result_version,error_message,device_id,"
                    "client_timestamp,received_at")
            .eq("user_id", str(g.user.id))
            .order("received_at", desc=True)
            .limit(limit)
            .execute()
        )
        return jsonify({"logs": result.data or []}), 200

    except Exception as e:
        print("SYNC LOGS ERROR:", repr(e))
        return jsonify({"error": "Could not retrieve sync history."}), 500


# --------------------------------------------------
# 8. ROUTES, OFF-ROUTE ALERTS, MESSAGES
# All rules (roles, ownership, validation) are enforced inside Postgres by
# the functions in database/migrations/003_routes_alerts_messages.sql;
# these endpoints pass the caller's token through and map errors to HTTP.
# --------------------------------------------------

SUPERVISOR_ROLES = ("supervisor", "admin")

# Postgres error codes raised by the 003 functions -> HTTP status
RPC_STATUS = {"42501": 403, "28000": 403, "22023": 400, "P0002": 404, "40001": 409}

# The database function/table doesn't exist: PostgREST "function not in
# schema cache" (PGRST202), "table not in schema cache" (PGRST205), or
# Postgres undefined_table / undefined_function / undefined_column.
SETUP_MISSING = {"PGRST202", "PGRST205", "42P01", "42883", "42703"}
SETUP_HINT = ("Database setup is incomplete ({detail}). Run database/check_setup.sql "
              "in the Supabase SQL Editor to see what's missing.")


def call_rpc(name, params=None, status=200):
    try:
        result = get_user_db().rpc(name, params or {}).execute()
        return jsonify(result.data), status

    except APIError as e:
        code = str(getattr(e, "code", "") or "")
        if code in SETUP_MISSING:
            detail = getattr(e, "message", None) or str(e)
            print(f"RPC {name} SETUP MISSING:", code, detail)
            return jsonify({"error": SETUP_HINT.format(detail=detail)}), 500
        http = RPC_STATUS.get(code) or (400 if code[:2] in ("22", "23") else 500)
        if http == 500:
            print(f"RPC {name} ERROR:", code, getattr(e, "message", e))
            return jsonify({"error": "Server error."}), 500
        return jsonify({"error": getattr(e, "message", None) or str(e)}), http

    except (httpx.HTTPError, OSError) as e:
        print(f"RPC {name} UNAVAILABLE:", repr(e))
        return jsonify({"error": "Database temporarily unavailable. Try again shortly."}), 503


def current_role():
    try:
        profile = fetch_profile(get_user_db(), g.user.id)
    except Exception as e:
        print("ROLE LOOKUP ERROR:", repr(e))
        return None
    return (profile or {}).get("role")


def supervisor_required(function):
    """Logged in AND supervisor/admin. (The database checks again.)"""
    @wraps(function)
    @login_required
    def wrapper(*args, **kwargs):
        if current_role() not in SUPERVISOR_ROLES:
            if _wants_page():
                return render_template("forbidden.html"), 403
            return jsonify({"error": "Supervisor access required."}), 403
        return function(*args, **kwargs)
    return wrapper


def valid_uuid(value):
    try:
        uuid.UUID(str(value))
        return True
    except (ValueError, TypeError):
        return False


# ---- officers & supervisors ------------------------------------------

@app.route("/routes", methods=["GET"])
@login_required
def my_routes():
    """Officers: routes assigned to them (cached offline by the page).
    Supervisors: every route."""
    return call_rpc("list_patrol_routes")


@app.route("/messages", methods=["GET"])
@login_required
def list_messages():
    officer_id = request.args.get("officer_id") or None
    after = request.args.get("after") or None
    if officer_id and not valid_uuid(officer_id):
        return jsonify({"error": "Invalid officer_id."}), 400
    return call_rpc("list_messages", {"p_officer_id": officer_id, "p_after": after})


@app.route("/messages", methods=["POST"])
@login_required
def send_message():
    data = get_data()
    body = (data.get("body") or "").strip()
    if not body:
        return jsonify({"error": "Message is empty."}), 400
    officer_id = data.get("officer_id") or None
    patrol_id = data.get("patrol_id") or None
    for value in (officer_id, patrol_id):
        if value and not valid_uuid(value):
            return jsonify({"error": "Invalid id."}), 400
    return call_rpc("send_message",
                    {"p_officer_id": officer_id, "p_body": body[:2000], "p_patrol_id": patrol_id},
                    status=201)


@app.route("/messages/read", methods=["POST"])
@login_required
def read_messages():
    officer_id = get_data().get("officer_id") or None
    if officer_id and not valid_uuid(officer_id):
        return jsonify({"error": "Invalid officer_id."}), 400
    return call_rpc("mark_messages_read", {"p_officer_id": officer_id})


# ---- supervisor console -----------------------------------------------

@app.route("/supervisor", methods=["GET"])
@supervisor_required
def supervisor_page():
    return render_template("supervisor.html", user_id=str(g.user.id), map_config=map_config())


@app.route("/supervisor/officers", methods=["GET"])
@supervisor_required
def supervisor_officers():
    return call_rpc("list_officers")


@app.route("/supervisor/routes", methods=["POST"])
@supervisor_required
def create_route():
    route = get_data()
    route.pop("id", None)
    return call_rpc("save_patrol_route", {"p_route": route}, status=201)


@app.route("/supervisor/routes/<route_id>", methods=["PUT"])
@supervisor_required
def update_route(route_id):
    if not valid_uuid(route_id):
        return jsonify({"error": "Route not found."}), 404
    route = get_data()
    route["id"] = route_id
    return call_rpc("save_patrol_route", {"p_route": route})


@app.route("/supervisor/routes/<route_id>", methods=["DELETE"])
@supervisor_required
def delete_route(route_id):
    if not valid_uuid(route_id):
        return jsonify({"error": "Route not found."}), 404
    return call_rpc("delete_patrol_route", {"p_id": route_id})


@app.route("/supervisor/checkpoints", methods=["POST"])
@supervisor_required
def save_checkpoint():
    return call_rpc("save_checkpoint", {"p": get_data()}, status=201)


@app.route("/supervisor/overview", methods=["GET"])
@supervisor_required
def supervisor_overview():
    return call_rpc("supervisor_overview")


@app.route("/supervisor/alerts", methods=["GET"])
@supervisor_required
def supervisor_alerts():
    open_only = request.args.get("open", "1") != "0"
    try:
        limit = max(1, min(int(request.args.get("limit", 100)), 500))
    except ValueError:
        limit = 100
    return call_rpc("list_route_alerts", {"p_open_only": open_only, "p_limit": limit})


@app.route("/supervisor/alerts/<alert_id>/ack", methods=["POST"])
@supervisor_required
def acknowledge_alert(alert_id):
    if not valid_uuid(alert_id):
        return jsonify({"error": "Alert not found."}), 404
    return call_rpc("acknowledge_route_alert", {"p_id": alert_id})


@app.route("/supervisor/threads", methods=["GET"])
@supervisor_required
def supervisor_threads():
    return call_rpc("message_threads")


@app.cli.command("make-supervisor")
@click.argument("email")
@click.option("--role", default="supervisor", type=click.Choice(["supervisor", "admin", "officer"]))
def make_supervisor(email, role):
    """Give a user the supervisor (or admin/officer) role.
    Needs a key allowed to update public.users (e.g. the service-role key)."""
    result = db.table("users").update({"role": role}).eq("email", email.strip().lower()).execute()
    if not result.data:
        raise click.ClickException(f"No user with email {email}")
    click.echo(f"{email} is now {role}.")


@app.route("/service-worker.js")
def service_worker():
    response = send_from_directory(
        app.static_folder,
        "service-worker.js"
    )

    response.headers["Service-Worker-Allowed"] = "/"

    return response

# --------------------------------------------------
# RUN SERVER
# --------------------------------------------------

if __name__ == "__main__":
    # Browsers only allow GPS (and screen wake lock) on HTTPS or localhost.
    # To test on a phone over Wi-Fi, serve HTTPS:
    #   FLASK_SSL_CERT=cert.pem FLASK_SSL_KEY=key.pem python app.py
    #   or FLASK_HTTPS=adhoc  (needs: pip install cryptography)
    cert, key = os.getenv("FLASK_SSL_CERT"), os.getenv("FLASK_SSL_KEY")
    if cert and key:
        ssl_context = (cert, key)
    elif os.getenv("FLASK_HTTPS") == "adhoc":
        ssl_context = "adhoc"
    else:
        ssl_context = None

    app.run(
        debug=True,
        host=os.getenv("FLASK_HOST", "127.0.0.1"),
        ssl_context=ssl_context
    )

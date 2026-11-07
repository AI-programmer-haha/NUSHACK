-- =====================================================================
-- 003 — Supervisor route management, off-route alerts, messaging
--
-- Run once in: Supabase Dashboard -> SQL Editor, after 002. Safe to re-run.
--
-- Make someone a supervisor (only an admin/DB owner can do this):
--   UPDATE public.users SET role = 'supervisor' WHERE email = 'name@example.com';
--   (or: flask --app app make-supervisor name@example.com)
--
-- Every function that changes data checks the caller's role itself
-- (auth.uid() -> users.role), so the rules hold even if the Flask layer
-- were bypassed.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. Tables
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.patrol_routes (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name              TEXT NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
    description       TEXT CHECK (description IS NULL OR length(description) <= 2000),
    location_id       UUID REFERENCES public.locations (id) ON DELETE SET NULL,   -- site / building
    corridor_m        INTEGER NOT NULL DEFAULT 50 CHECK (corridor_m BETWEEN 10 AND 1000),
    strict_order      BOOLEAN NOT NULL DEFAULT TRUE,     -- checkpoints must be visited in order
    is_loop           BOOLEAN NOT NULL DEFAULT FALSE,    -- last stop connects back to the first
    expected_minutes  INTEGER CHECK (expected_minutes BETWEEN 1 AND 1440),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_by        UUID REFERENCES public.users (id) ON DELETE SET NULL,
    version           INTEGER NOT NULL DEFAULT 1,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at        TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS public.route_stops (
    route_id     UUID NOT NULL REFERENCES public.patrol_routes (id) ON DELETE CASCADE,
    position     INTEGER NOT NULL CHECK (position >= 1),
    location_id  UUID NOT NULL REFERENCES public.locations (id) ON DELETE RESTRICT,
    PRIMARY KEY (route_id, position)
);

CREATE TABLE IF NOT EXISTS public.route_assignments (
    route_id     UUID NOT NULL REFERENCES public.patrol_routes (id) ON DELETE CASCADE,
    officer_id   UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    assigned_by  UUID REFERENCES public.users (id) ON DELETE SET NULL,
    assigned_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (route_id, officer_id)
);

ALTER TABLE public.patrols
    ADD COLUMN IF NOT EXISTS route_id UUID REFERENCES public.patrol_routes (id) ON DELETE SET NULL;

-- Live on/off-route state per patrol. Kept OUT of patrols so server-side
-- tracking never bumps patrols.version (which would cause sync conflicts).
CREATE TABLE IF NOT EXISTS public.patrol_route_state (
    patrol_id       UUID PRIMARY KEY REFERENCES public.patrols (id) ON DELETE CASCADE,
    off_route       BOOLEAN NOT NULL DEFAULT FALSE,
    off_since       TIMESTAMPTZ,
    distance_m      NUMERIC(8, 1),
    last_latitude   NUMERIC(9, 6),
    last_longitude  NUMERIC(9, 6),
    last_point_at   TIMESTAMPTZ,
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.route_alerts (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patrol_id        UUID NOT NULL REFERENCES public.patrols (id) ON DELETE CASCADE,
    officer_id       UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    route_id         UUID REFERENCES public.patrol_routes (id) ON DELETE SET NULL,
    kind             TEXT NOT NULL CHECK (kind IN ('off_route', 'back_on_route',
                                                   'out_of_order', 'unplanned_checkpoint')),
    distance_m       NUMERIC(8, 1),
    latitude         NUMERIC(9, 6),
    longitude        NUMERIC(9, 6),
    details          TEXT,
    detected_at      TIMESTAMPTZ NOT NULL,              -- device time of the fix / scan
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(), -- when the server learned of it
    acknowledged_by  UUID REFERENCES public.users (id) ON DELETE SET NULL,
    acknowledged_at  TIMESTAMPTZ
);

-- One conversation per officer with the supervisor team.
CREATE TABLE IF NOT EXISTS public.messages (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    officer_id             UUID NOT NULL REFERENCES public.users (id) ON DELETE CASCADE,
    sender_id              UUID REFERENCES public.users (id) ON DELETE SET NULL,   -- NULL = system
    kind                   TEXT NOT NULL DEFAULT 'text' CHECK (kind IN ('text', 'alert')),
    body                   TEXT NOT NULL CHECK (length(btrim(body)) BETWEEN 1 AND 2000),
    patrol_id              UUID REFERENCES public.patrols (id) ON DELETE SET NULL,
    alert_id               UUID REFERENCES public.route_alerts (id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
    read_by_officer_at     TIMESTAMPTZ,
    read_by_supervisor_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_route_stops_location   ON public.route_stops (location_id);
CREATE INDEX IF NOT EXISTS idx_route_assign_officer   ON public.route_assignments (officer_id);
CREATE INDEX IF NOT EXISTS idx_patrols_route          ON public.patrols (route_id);
CREATE INDEX IF NOT EXISTS idx_route_alerts_open      ON public.route_alerts (created_at) WHERE acknowledged_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_route_alerts_patrol    ON public.route_alerts (patrol_id, detected_at);
CREATE INDEX IF NOT EXISTS idx_messages_thread        ON public.messages (officer_id, created_at);

DROP TRIGGER IF EXISTS trg_patrol_routes_sync ON public.patrol_routes;
CREATE TRIGGER trg_patrol_routes_sync
    BEFORE UPDATE ON public.patrol_routes
    FOR EACH ROW EXECUTE FUNCTION public.set_sync_metadata();


-- ---------------------------------------------------------------------
-- 2. Roles
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._caller_role()
RETURNS TEXT
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT role FROM public.users
    WHERE id = auth.uid() AND is_active AND deleted_at IS NULL
$$;

CREATE OR REPLACE FUNCTION public._is_supervisor()
RETURNS BOOLEAN
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT COALESCE(public._caller_role(), '') IN ('supervisor', 'admin')
$$;

CREATE OR REPLACE FUNCTION public._require_user()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF auth.uid() IS NULL OR public._caller_role() IS NULL THEN
        RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
    END IF;
    RETURN auth.uid();
END;
$$;

CREATE OR REPLACE FUNCTION public._require_supervisor()
RETURNS UUID
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    IF NOT public._is_supervisor() THEN
        RAISE EXCEPTION 'Supervisor access required.' USING ERRCODE = '42501';
    END IF;
    RETURN auth.uid();
END;
$$;


-- ---------------------------------------------------------------------
-- 3. Geometry: distance (m) from a point to a route's path.
--    Plain SQL (no PostGIS needed): local equirectangular projection,
--    accurate to well under a metre over a site-sized route.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._distance_to_route_m(p_route UUID, p_lat NUMERIC, p_lng NUMERIC)
RETURNS NUMERIC
LANGUAGE plpgsql STABLE SET search_path = public
AS $$
DECLARE
    v_kx     DOUBLE PRECISION := 111320.0 * cos(radians(p_lat::DOUBLE PRECISION));
    v_ky     CONSTANT DOUBLE PRECISION := 110574.0;
    v_loop   BOOLEAN;
    v_pts    DOUBLE PRECISION[][] := ARRAY[]::DOUBLE PRECISION[][];
    v_best   DOUBLE PRECISION;
    v_n      INTEGER;
    x1 DOUBLE PRECISION; y1 DOUBLE PRECISION; x2 DOUBLE PRECISION; y2 DOUBLE PRECISION;
    dx DOUBLE PRECISION; dy DOUBLE PRECISION; t DOUBLE PRECISION; d DOUBLE PRECISION;
    r  RECORD;
BEGIN
    SELECT is_loop INTO v_loop FROM public.patrol_routes WHERE id = p_route;

    FOR r IN
        SELECT l.latitude::DOUBLE PRECISION AS lat, l.longitude::DOUBLE PRECISION AS lng
        FROM public.route_stops s
        JOIN public.locations l ON l.id = s.location_id
        WHERE s.route_id = p_route AND l.latitude IS NOT NULL AND l.longitude IS NOT NULL
        ORDER BY s.position
    LOOP
        -- metres relative to the point
        v_pts := v_pts || ARRAY[[(r.lng - p_lng::DOUBLE PRECISION) * v_kx,
                                 (r.lat - p_lat::DOUBLE PRECISION) * v_ky]];
    END LOOP;

    v_n := COALESCE(array_length(v_pts, 1), 0);
    IF v_n = 0 THEN
        RETURN NULL;
    END IF;

    v_best := sqrt(v_pts[1][1] ^ 2 + v_pts[1][2] ^ 2);

    FOR i IN 1 .. (CASE WHEN v_loop AND v_n > 2 THEN v_n ELSE v_n - 1 END) LOOP
        x1 := v_pts[i][1];                     y1 := v_pts[i][2];
        x2 := v_pts[(i % v_n) + 1][1];         y2 := v_pts[(i % v_n) + 1][2];
        dx := x2 - x1;                         dy := y2 - y1;
        IF dx = 0 AND dy = 0 THEN
            t := 0;
        ELSE
            t := greatest(0, least(1, -(x1 * dx + y1 * dy) / (dx * dx + dy * dy)));
        END IF;
        d := sqrt((x1 + t * dx) ^ 2 + (y1 + t * dy) ^ 2);
        v_best := least(v_best, d);
    END LOOP;

    RETURN round(v_best::NUMERIC, 1);
END;
$$;


-- ---------------------------------------------------------------------
-- 4. Routes: read / save / delete
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._route_json(p_id UUID)
RETURNS JSONB
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
    SELECT to_jsonb(r) || jsonb_build_object(
        'stops', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'position', s.position, 'location_id', s.location_id,
                       'name', l.name, 'code', l.code,
                       'latitude', l.latitude, 'longitude', l.longitude)
                   ORDER BY s.position)
            FROM public.route_stops s JOIN public.locations l ON l.id = s.location_id
            WHERE s.route_id = r.id), '[]'::jsonb),
        'officer_ids', COALESCE((
            SELECT jsonb_agg(a.officer_id ORDER BY a.assigned_at)
            FROM public.route_assignments a WHERE a.route_id = r.id), '[]'::jsonb))
    FROM public.patrol_routes r
    WHERE r.id = p_id
$$;

-- Supervisors: every route. Officers: active routes assigned to them.
CREATE OR REPLACE FUNCTION public.list_patrol_routes()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_user UUID := public._require_user();
BEGIN
    RETURN COALESCE((
        SELECT jsonb_agg(public._route_json(r.id) ORDER BY r.name)
        FROM public.patrol_routes r
        WHERE r.deleted_at IS NULL
          AND (public._is_supervisor()
               OR (r.is_active AND EXISTS (
                     SELECT 1 FROM public.route_assignments a
                     WHERE a.route_id = r.id AND a.officer_id = v_user)))
    ), '[]'::jsonb);
END;
$$;

/*
 * Create or update a route with its ordered stops and assigned officers,
 * all in one transaction.
 *   p_route = { id?, version?, name, description?, location_id?, corridor_m?,
 *               strict_order?, is_loop?, expected_minutes?, is_active?,
 *               stops: [location_id, ...], officer_ids: [user_id, ...] }
 * `version` (when updating) must match, so two supervisors editing the
 * same route don't silently overwrite each other (40001 -> 409).
 */
CREATE OR REPLACE FUNCTION public.save_patrol_route(p_route JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_user     UUID := public._require_supervisor();
    v_id       UUID;
    v_current  public.patrol_routes%ROWTYPE;
    v_stops    JSONB := COALESCE(p_route -> 'stops', '[]'::jsonb);
    v_officers JSONB := COALESCE(p_route -> 'officer_ids', '[]'::jsonb);
    v_bad      TEXT;
BEGIN
    IF jsonb_typeof(p_route) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_stops) <> 'array' OR jsonb_typeof(v_officers) <> 'array' THEN
        RAISE EXCEPTION 'Route must be an object with stops and officer_ids arrays.' USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(v_stops) > 200 THEN
        RAISE EXCEPTION 'A route can have at most 200 stops.' USING ERRCODE = '22023';
    END IF;

    -- Every stop must be an existing, active checkpoint.
    SELECT string_agg(e.value #>> '{}', ', ') INTO v_bad
    FROM jsonb_array_elements(v_stops) e
    LEFT JOIN public.locations l
           ON l.id::TEXT = e.value #>> '{}' AND l.location_type = 'checkpoint'
          AND l.deleted_at IS NULL AND l.is_active
    WHERE l.id IS NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Not an active checkpoint: %', v_bad USING ERRCODE = '22023';
    END IF;

    SELECT string_agg(e.value #>> '{}', ', ') INTO v_bad
    FROM jsonb_array_elements(v_officers) e
    LEFT JOIN public.users u ON u.id::TEXT = e.value #>> '{}' AND u.is_active AND u.deleted_at IS NULL
    WHERE u.id IS NULL;
    IF v_bad IS NOT NULL THEN
        RAISE EXCEPTION 'Unknown or inactive user: %', v_bad USING ERRCODE = '22023';
    END IF;

    v_id := NULLIF(p_route ->> 'id', '')::UUID;

    IF v_id IS NOT NULL THEN
        SELECT * INTO v_current FROM public.patrol_routes WHERE id = v_id AND deleted_at IS NULL FOR UPDATE;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0002';
        END IF;
        IF p_route ? 'version' AND (p_route ->> 'version')::INTEGER <> v_current.version THEN
            RAISE EXCEPTION 'This route was changed by someone else (now version %). Reload and try again.',
                v_current.version USING ERRCODE = '40001';
        END IF;

        UPDATE public.patrol_routes SET
            name             = btrim(COALESCE(p_route ->> 'name', name)),
            description      = CASE WHEN p_route ? 'description' THEN NULLIF(btrim(p_route ->> 'description'), '') ELSE description END,
            location_id      = CASE WHEN p_route ? 'location_id' THEN NULLIF(p_route ->> 'location_id', '')::UUID ELSE location_id END,
            corridor_m       = COALESCE((p_route ->> 'corridor_m')::INTEGER, corridor_m),
            strict_order     = COALESCE((p_route ->> 'strict_order')::BOOLEAN, strict_order),
            is_loop          = COALESCE((p_route ->> 'is_loop')::BOOLEAN, is_loop),
            expected_minutes = CASE WHEN p_route ? 'expected_minutes' THEN NULLIF(p_route ->> 'expected_minutes', '')::INTEGER ELSE expected_minutes END,
            is_active        = COALESCE((p_route ->> 'is_active')::BOOLEAN, is_active)
        WHERE id = v_id;
    ELSE
        INSERT INTO public.patrol_routes (name, description, location_id, corridor_m, strict_order,
                                          is_loop, expected_minutes, is_active, created_by)
        VALUES (btrim(p_route ->> 'name'),
                NULLIF(btrim(p_route ->> 'description'), ''),
                NULLIF(p_route ->> 'location_id', '')::UUID,
                COALESCE((p_route ->> 'corridor_m')::INTEGER, 50),
                COALESCE((p_route ->> 'strict_order')::BOOLEAN, TRUE),
                COALESCE((p_route ->> 'is_loop')::BOOLEAN, FALSE),
                NULLIF(p_route ->> 'expected_minutes', '')::INTEGER,
                COALESCE((p_route ->> 'is_active')::BOOLEAN, TRUE),
                v_user)
        RETURNING id INTO v_id;
    END IF;

    DELETE FROM public.route_stops WHERE route_id = v_id;
    INSERT INTO public.route_stops (route_id, position, location_id)
    SELECT v_id, e.n, (e.value #>> '{}')::UUID
    FROM jsonb_array_elements(v_stops) WITH ORDINALITY AS e (value, n);

    DELETE FROM public.route_assignments
    WHERE route_id = v_id
      AND officer_id::TEXT NOT IN (SELECT value #>> '{}' FROM jsonb_array_elements(v_officers));
    INSERT INTO public.route_assignments (route_id, officer_id, assigned_by)
    SELECT DISTINCT v_id, (value #>> '{}')::UUID, v_user FROM jsonb_array_elements(v_officers)
    ON CONFLICT DO NOTHING;

    RETURN public._route_json(v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.delete_patrol_route(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM public._require_supervisor();
    UPDATE public.patrol_routes SET deleted_at = now(), is_active = FALSE
    WHERE id = p_id AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Route not found.' USING ERRCODE = 'P0002';
    END IF;
    RETURN jsonb_build_object('id', p_id, 'deleted', TRUE);
END;
$$;

-- Supervisors add / edit checkpoints (e.g. placed by clicking the map).
--   p = { id?, name, code?, parent_id?, latitude, longitude, description? }
CREATE OR REPLACE FUNCTION public.save_checkpoint(p JSONB)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_id UUID := NULLIF(p ->> 'id', '')::UUID;
    v_parent UUID := NULLIF(p ->> 'parent_id', '')::UUID;
BEGIN
    PERFORM public._require_supervisor();

    IF v_parent IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.locations WHERE id = v_parent AND location_type IN ('building', 'area')
    ) THEN
        RAISE EXCEPTION 'parent_id must be a building or area.' USING ERRCODE = '22023';
    END IF;

    IF v_id IS NULL THEN
        INSERT INTO public.locations (location_type, name, code, parent_id, latitude, longitude, description)
        VALUES ('checkpoint', btrim(p ->> 'name'), NULLIF(btrim(p ->> 'code'), ''), v_parent,
                (p ->> 'latitude')::NUMERIC, (p ->> 'longitude')::NUMERIC, NULLIF(p ->> 'description', ''))
        RETURNING id INTO v_id;
    ELSE
        UPDATE public.locations SET
            name        = btrim(COALESCE(p ->> 'name', name)),
            code        = CASE WHEN p ? 'code' THEN NULLIF(btrim(p ->> 'code'), '') ELSE code END,
            parent_id   = CASE WHEN p ? 'parent_id' THEN v_parent ELSE parent_id END,
            latitude    = COALESCE((p ->> 'latitude')::NUMERIC, latitude),
            longitude   = COALESCE((p ->> 'longitude')::NUMERIC, longitude),
            description = CASE WHEN p ? 'description' THEN NULLIF(p ->> 'description', '') ELSE description END
        WHERE id = v_id AND location_type = 'checkpoint';
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Checkpoint not found.' USING ERRCODE = 'P0002';
        END IF;
    END IF;

    RETURN (SELECT to_jsonb(l) FROM public.locations l WHERE l.id = v_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_officers()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM public._require_supervisor();
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', id, 'email', email, 'full_name', full_name, 'role', role)
                         ORDER BY COALESCE(NULLIF(full_name, ''), email))
        FROM public.users WHERE is_active AND deleted_at IS NULL
    ), '[]'::jsonb);
END;
$$;


-- ---------------------------------------------------------------------
-- 5. Patrols on a route: only routes assigned to that officer
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._check_patrol_route()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
    IF NEW.route_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.route_id IS DISTINCT FROM OLD.route_id) THEN
        IF NOT EXISTS (
            SELECT 1 FROM public.patrol_routes r
            JOIN public.route_assignments a ON a.route_id = r.id
            WHERE r.id = NEW.route_id AND r.is_active AND r.deleted_at IS NULL
              AND a.officer_id = NEW.officer_id
        ) THEN
            RAISE EXCEPTION 'Route is not assigned to this officer.' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_patrols_route_check ON public.patrols;
CREATE TRIGGER trg_patrols_route_check
    BEFORE INSERT OR UPDATE OF route_id ON public.patrols
    FOR EACH ROW EXECUTE FUNCTION public._check_patrol_route();

-- Devices may now send route_id when creating a patrol (not change it later).
CREATE OR REPLACE FUNCTION public._sync_spec(p_type TEXT)
RETURNS TABLE (owner_col TEXT, create_cols TEXT[], update_cols TEXT[], requires_patrol BOOLEAN)
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT s.owner_col, s.create_cols, s.update_cols, s.requires_patrol
    FROM (VALUES
        ('patrols', 'officer_id',
            ARRAY['location_id', 'route_id', 'status', 'scheduled_start', 'started_at', 'ended_at',
                  'notes', 'client_updated_at'],
            ARRAY['location_id', 'status', 'scheduled_start', 'started_at', 'ended_at',
                  'notes', 'client_updated_at'],
            FALSE),
        ('checkpoints', 'officer_id',
            ARRAY['patrol_id', 'location_id', 'status', 'scan_method', 'scanned_at',
                  'latitude', 'longitude', 'notes', 'client_updated_at'],
            ARRAY['status', 'notes', 'latitude', 'longitude', 'client_updated_at'],
            TRUE),
        ('route_points', 'officer_id',
            ARRAY['patrol_id', 'latitude', 'longitude', 'accuracy_m', 'recorded_at',
                  'client_updated_at'],
            ARRAY[]::TEXT[],
            TRUE),
        ('inspections', 'inspector_id',
            ARRAY['location_id', 'patrol_id', 'inspection_type', 'status', 'result',
                  'checklist', 'notes', 'inspected_at', 'client_updated_at'],
            ARRAY['status', 'result', 'checklist', 'notes', 'client_updated_at'],
            FALSE),
        ('incidents', 'reported_by',
            ARRAY['location_id', 'patrol_id', 'title', 'description', 'category',
                  'severity', 'occurred_at', 'attachments', 'latitude', 'longitude',
                  'client_updated_at'],
            ARRAY['title', 'description', 'category', 'severity', 'attachments',
                  'latitude', 'longitude', 'client_updated_at'],
            FALSE)
    ) AS s (entity_type, owner_col, create_cols, update_cols, requires_patrol)
    WHERE s.entity_type = p_type
$$;


-- ---------------------------------------------------------------------
-- 6. Off-route detection on every uploaded GPS point
--    Leaves the corridor when distance > corridor + min(accuracy, corridor);
--    counts as back only when distance <= 80 % of the corridor (hysteresis,
--    so a jittery fix doesn't flap between on and off).
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public._alert_message(p_alert public.route_alerts, p_route_name TEXT)
RETURNS TEXT
LANGUAGE sql IMMUTABLE
AS $$
    SELECT CASE p_alert.kind
        WHEN 'off_route'            THEN format('Left route "%s" — %s m from the planned path.', p_route_name, round(p_alert.distance_m))
        WHEN 'back_on_route'        THEN format('Back on route "%s".', p_route_name)
        WHEN 'out_of_order'         THEN format('Checkpoint out of order on "%s": %s', p_route_name, p_alert.details)
        WHEN 'unplanned_checkpoint' THEN format('Checked in at a checkpoint that is not on "%s": %s', p_route_name, p_alert.details)
    END
$$;

CREATE OR REPLACE FUNCTION public._raise_route_alert(
    p_patrol UUID, p_officer UUID, p_route UUID, p_route_name TEXT, p_kind TEXT,
    p_distance NUMERIC, p_lat NUMERIC, p_lng NUMERIC, p_details TEXT, p_at TIMESTAMPTZ)
RETURNS VOID
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
    v_alert public.route_alerts;
BEGIN
    INSERT INTO public.route_alerts (patrol_id, officer_id, route_id, kind, distance_m,
                                     latitude, longitude, details, detected_at,
                                     acknowledged_at)
    VALUES (p_patrol, p_officer, p_route, p_kind, p_distance, p_lat, p_lng, p_details, p_at,
            CASE WHEN p_kind = 'back_on_route' THEN now() END)    -- informational
    RETURNING * INTO v_alert;

    INSERT INTO public.messages (officer_id, sender_id, kind, body, patrol_id, alert_id)
    VALUES (p_officer, NULL, 'alert', public._alert_message(v_alert, p_route_name), p_patrol, v_alert.id);
END;
$$;

CREATE OR REPLACE FUNCTION public._track_route_point()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
    v_route     public.patrol_routes%ROWTYPE;
    v_officer   UUID;
    v_state     public.patrol_route_state%ROWTYPE;
    v_distance  NUMERIC;
    v_allow     NUMERIC;
    v_off       BOOLEAN;
    v_route_id  UUID;
BEGIN
    SELECT p.officer_id, p.route_id INTO v_officer, v_route_id
    FROM public.patrols p
    WHERE p.id = NEW.patrol_id AND p.status = 'in_progress' AND p.deleted_at IS NULL;

    IF v_route_id IS NULL THEN
        RETURN NEW;                               -- not a route patrol
    END IF;
    SELECT * INTO v_route FROM public.patrol_routes WHERE id = v_route_id;

    v_distance := public._distance_to_route_m(v_route.id, NEW.latitude, NEW.longitude);
    IF v_distance IS NULL THEN
        RETURN NEW;                               -- route has no mapped stops
    END IF;

    SELECT * INTO v_state FROM public.patrol_route_state WHERE patrol_id = NEW.patrol_id FOR UPDATE;

    -- Ignore points older than what we already have (late duplicates).
    IF v_state.patrol_id IS NOT NULL AND v_state.last_point_at IS NOT NULL
       AND NEW.recorded_at < v_state.last_point_at THEN
        RETURN NEW;
    END IF;

    v_allow := v_route.corridor_m + LEAST(COALESCE(NEW.accuracy_m, 0), v_route.corridor_m);

    IF COALESCE(v_state.off_route, FALSE) THEN
        v_off := v_distance > v_route.corridor_m * 0.8;
    ELSE
        v_off := v_distance > v_allow;
    END IF;

    INSERT INTO public.patrol_route_state AS s (patrol_id, off_route, off_since, distance_m,
                                                last_latitude, last_longitude, last_point_at, updated_at)
    VALUES (NEW.patrol_id, v_off, CASE WHEN v_off THEN NEW.recorded_at END, v_distance,
            NEW.latitude, NEW.longitude, NEW.recorded_at, now())
    ON CONFLICT (patrol_id) DO UPDATE SET
        off_route      = EXCLUDED.off_route,
        off_since      = CASE WHEN EXCLUDED.off_route AND NOT s.off_route THEN EXCLUDED.last_point_at
                              WHEN EXCLUDED.off_route THEN s.off_since END,
        distance_m     = EXCLUDED.distance_m,
        last_latitude  = EXCLUDED.last_latitude,
        last_longitude = EXCLUDED.last_longitude,
        last_point_at  = EXCLUDED.last_point_at,
        updated_at     = now();

    IF v_off IS DISTINCT FROM COALESCE(v_state.off_route, FALSE) THEN
        PERFORM public._raise_route_alert(
            NEW.patrol_id, v_officer, v_route.id, v_route.name,
            CASE WHEN v_off THEN 'off_route' ELSE 'back_on_route' END,
            v_distance, NEW.latitude, NEW.longitude, NULL, NEW.recorded_at);
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_route_points_track ON public.route_points;
CREATE TRIGGER trg_route_points_track
    AFTER INSERT ON public.route_points
    FOR EACH ROW EXECUTE FUNCTION public._track_route_point();


-- Check-ins on a route: flag checkpoints that aren't on the route, and (for
-- strict-order routes) ones visited before earlier stops.
CREATE OR REPLACE FUNCTION public._track_route_checkin()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
    v_route    public.patrol_routes%ROWTYPE;
    v_officer  UUID;
    v_position INTEGER;
    v_skipped  TEXT;
    v_name     TEXT;
    v_route_id UUID;
BEGIN
    SELECT p.officer_id, p.route_id INTO v_officer, v_route_id
    FROM public.patrols p WHERE p.id = NEW.patrol_id;

    IF v_route_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT * INTO v_route FROM public.patrol_routes WHERE id = v_route_id;

    SELECT name INTO v_name FROM public.locations WHERE id = NEW.location_id;
    SELECT min(position) INTO v_position
    FROM public.route_stops WHERE route_id = v_route.id AND location_id = NEW.location_id;

    IF v_position IS NULL THEN
        PERFORM public._raise_route_alert(NEW.patrol_id, v_officer, v_route.id, v_route.name,
            'unplanned_checkpoint', NULL, NEW.latitude, NEW.longitude, v_name, NEW.scanned_at);
        RETURN NEW;
    END IF;

    IF v_route.strict_order THEN
        SELECT string_agg(l.name, ', ' ORDER BY s.position) INTO v_skipped
        FROM public.route_stops s JOIN public.locations l ON l.id = s.location_id
        WHERE s.route_id = v_route.id AND s.position < v_position
          AND NOT EXISTS (
              SELECT 1 FROM public.checkpoints c
              WHERE c.patrol_id = NEW.patrol_id AND c.location_id = s.location_id
                AND c.id <> NEW.id AND c.deleted_at IS NULL);

        IF v_skipped IS NOT NULL THEN
            PERFORM public._raise_route_alert(NEW.patrol_id, v_officer, v_route.id, v_route.name,
                'out_of_order', NULL, NEW.latitude, NEW.longitude,
                format('%s before %s', v_name, v_skipped), NEW.scanned_at);
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_checkpoints_route ON public.checkpoints;
CREATE TRIGGER trg_checkpoints_route
    AFTER INSERT ON public.checkpoints
    FOR EACH ROW EXECUTE FUNCTION public._track_route_checkin();


-- ---------------------------------------------------------------------
-- 7. Supervisor views
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.supervisor_overview()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM public._require_supervisor();
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
            'patrol_id', p.id,
            'officer_id', p.officer_id,
            'officer_name', COALESCE(NULLIF(u.full_name, ''), u.email),
            'started_at', p.started_at,
            'route_id', r.id,
            'route_name', r.name,
            'corridor_m', r.corridor_m,
            'stops_total', (SELECT count(*) FROM public.route_stops s WHERE s.route_id = r.id),
            'checkins', (SELECT count(DISTINCT c.location_id) FROM public.checkpoints c
                         WHERE c.patrol_id = p.id AND c.deleted_at IS NULL),
            'off_route', COALESCE(st.off_route, FALSE),
            'off_since', st.off_since,
            'distance_m', st.distance_m,
            'last_latitude', lp.latitude,
            'last_longitude', lp.longitude,
            'last_seen_at', lp.recorded_at,
            'open_alerts', (SELECT count(*) FROM public.route_alerts a
                            WHERE a.patrol_id = p.id AND a.acknowledged_at IS NULL),
            'unread_messages', (SELECT count(*) FROM public.messages m
                                WHERE m.officer_id = p.officer_id AND m.read_by_supervisor_at IS NULL
                                  AND m.sender_id = p.officer_id))
            ORDER BY COALESCE(st.off_route, FALSE) DESC, p.started_at)
        FROM public.patrols p
        JOIN public.users u ON u.id = p.officer_id
        LEFT JOIN public.patrol_routes r ON r.id = p.route_id
        LEFT JOIN public.patrol_route_state st ON st.patrol_id = p.id
        LEFT JOIN LATERAL (
            SELECT rp.latitude, rp.longitude, rp.recorded_at FROM public.route_points rp
            WHERE rp.patrol_id = p.id ORDER BY rp.recorded_at DESC LIMIT 1) lp ON TRUE
        WHERE p.status = 'in_progress' AND p.deleted_at IS NULL
    ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.list_route_alerts(p_open_only BOOLEAN DEFAULT TRUE, p_limit INTEGER DEFAULT 100)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM public._require_supervisor();
    RETURN COALESCE((
        SELECT jsonb_agg(x ORDER BY x ->> 'created_at' DESC)
        FROM (
            SELECT to_jsonb(a) || jsonb_build_object(
                       'officer_name', COALESCE(NULLIF(u.full_name, ''), u.email),
                       'route_name', r.name) AS x
            FROM public.route_alerts a
            JOIN public.users u ON u.id = a.officer_id
            LEFT JOIN public.patrol_routes r ON r.id = a.route_id
            WHERE NOT p_open_only OR a.acknowledged_at IS NULL
            ORDER BY a.created_at DESC
            LIMIT LEAST(GREATEST(p_limit, 1), 500)
        ) q
    ), '[]'::jsonb);
END;
$$;

CREATE OR REPLACE FUNCTION public.acknowledge_route_alert(p_id UUID)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_user UUID := public._require_supervisor();
    v_row  public.route_alerts;
BEGIN
    UPDATE public.route_alerts
    SET acknowledged_by = v_user, acknowledged_at = now()
    WHERE id = p_id AND acknowledged_at IS NULL
    RETURNING * INTO v_row;
    IF NOT FOUND THEN
        SELECT * INTO v_row FROM public.route_alerts WHERE id = p_id;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Alert not found.' USING ERRCODE = 'P0002';
        END IF;
    END IF;
    RETURN to_jsonb(v_row);
END;
$$;


-- ---------------------------------------------------------------------
-- 8. Messages (officer <-> supervisor team)
-- ---------------------------------------------------------------------

-- Officers always write in their own thread; supervisors pick the officer.
CREATE OR REPLACE FUNCTION public.send_message(p_officer_id UUID, p_body TEXT, p_patrol_id UUID DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_user    UUID := public._require_user();
    v_officer UUID;
    v_row     public.messages;
BEGIN
    IF public._is_supervisor() THEN
        v_officer := p_officer_id;
        IF v_officer IS NULL OR NOT EXISTS (SELECT 1 FROM public.users WHERE id = v_officer) THEN
            RAISE EXCEPTION 'Choose which officer to message.' USING ERRCODE = '22023';
        END IF;
    ELSE
        v_officer := v_user;
    END IF;

    IF p_patrol_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.patrols WHERE id = p_patrol_id AND officer_id = v_officer
    ) THEN
        p_patrol_id := NULL;                 -- not that officer's patrol (e.g. not synced yet)
    END IF;

    INSERT INTO public.messages (officer_id, sender_id, kind, body, patrol_id,
                                 read_by_officer_at, read_by_supervisor_at)
    VALUES (v_officer, v_user, 'text', btrim(p_body), p_patrol_id,
            CASE WHEN v_user = v_officer THEN now() END,
            CASE WHEN v_user <> v_officer THEN now() END)
    RETURNING * INTO v_row;

    RETURN to_jsonb(v_row) || jsonb_build_object('from_supervisor', v_user <> v_officer);
EXCEPTION
    WHEN check_violation THEN
        RAISE EXCEPTION 'Message must be 1–2000 characters.' USING ERRCODE = '22023';
END;
$$;

CREATE OR REPLACE FUNCTION public.list_messages(p_officer_id UUID DEFAULT NULL, p_after TIMESTAMPTZ DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_user    UUID := public._require_user();
    v_officer UUID := CASE WHEN public._is_supervisor() THEN p_officer_id ELSE v_user END;
BEGIN
    IF v_officer IS NULL THEN
        RAISE EXCEPTION 'officer_id is required.' USING ERRCODE = '22023';
    END IF;
    RETURN COALESCE((
        SELECT jsonb_agg(to_jsonb(m) || jsonb_build_object(
                   'sender_name', CASE WHEN m.sender_id IS NULL THEN 'System'
                                       ELSE COALESCE(NULLIF(u.full_name, ''), u.email) END,
                   'from_supervisor', m.sender_id IS NOT NULL AND m.sender_id <> m.officer_id)
               ORDER BY m.created_at)
        FROM (SELECT * FROM public.messages
              WHERE officer_id = v_officer AND (p_after IS NULL OR created_at > p_after)
              ORDER BY created_at DESC LIMIT 200) m
        LEFT JOIN public.users u ON u.id = m.sender_id
    ), '[]'::jsonb);
END;
$$;

-- Mark the OTHER side's messages in a thread as read.
CREATE OR REPLACE FUNCTION public.mark_messages_read(p_officer_id UUID DEFAULT NULL)
RETURNS INTEGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
    v_user UUID := public._require_user();
    v_n    INTEGER;
BEGIN
    IF public._is_supervisor() THEN
        UPDATE public.messages SET read_by_supervisor_at = now()
        WHERE officer_id = p_officer_id AND read_by_supervisor_at IS NULL
          AND (sender_id = officer_id OR sender_id IS NULL);
    ELSE
        UPDATE public.messages SET read_by_officer_at = now()
        WHERE officer_id = v_user AND read_by_officer_at IS NULL
          AND sender_id IS NOT NULL AND sender_id <> officer_id;
    END IF;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RETURN v_n;
END;
$$;

CREATE OR REPLACE FUNCTION public.message_threads()
RETURNS JSONB
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
BEGIN
    PERFORM public._require_supervisor();
    RETURN COALESCE((
        SELECT jsonb_agg(t ORDER BY t ->> 'last_at' DESC)
        FROM (
            SELECT jsonb_build_object(
                'officer_id', u.id,
                'officer_name', COALESCE(NULLIF(u.full_name, ''), u.email),
                'last_at', max(m.created_at),
                'last_body', (array_agg(m.body ORDER BY m.created_at DESC))[1],
                'unread', count(*) FILTER (WHERE m.read_by_supervisor_at IS NULL
                                           AND (m.sender_id = m.officer_id OR m.sender_id IS NULL))) AS t
            FROM public.messages m JOIN public.users u ON u.id = m.officer_id
            GROUP BY u.id
        ) q
    ), '[]'::jsonb);
END;
$$;


-- ---------------------------------------------------------------------
-- 9. Who may call what
-- ---------------------------------------------------------------------
DO $$
DECLARE
    f TEXT;
    public_fns TEXT[] := ARRAY[
        'list_patrol_routes()', 'save_patrol_route(jsonb)', 'delete_patrol_route(uuid)',
        'save_checkpoint(jsonb)', 'list_officers()', 'supervisor_overview()',
        'list_route_alerts(boolean, integer)', 'acknowledge_route_alert(uuid)',
        'send_message(uuid, text, uuid)', 'list_messages(uuid, timestamptz)',
        'mark_messages_read(uuid)', 'message_threads()'];
    internal_fns TEXT[] := ARRAY[
        '_route_json(uuid)', '_distance_to_route_m(uuid, numeric, numeric)',
        '_raise_route_alert(uuid, uuid, uuid, text, text, numeric, numeric, numeric, text, timestamptz)'];
BEGIN
    FOREACH f IN ARRAY public_fns || internal_fns LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM PUBLIC', f);
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
            EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM anon', f);
        END IF;
    END LOOP;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        FOREACH f IN ARRAY internal_fns LOOP
            EXECUTE format('REVOKE ALL ON FUNCTION public.%s FROM authenticated', f);
        END LOOP;
        FOREACH f IN ARRAY public_fns LOOP
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.%s TO authenticated', f);
        END LOOP;
    END IF;
END $$;

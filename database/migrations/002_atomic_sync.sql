-- =====================================================================
-- 002 — Atomic sync, GPS route storage, patrol duration
--
-- Run once in: Supabase Dashboard -> SQL Editor, after 001. Safe to re-run.
--
-- Why: previously Flask applied a change and then wrote its sync_logs row
-- as two separate HTTP calls. If the second failed, the change was saved
-- but not logged, so a retry could be misjudged (false conflict, or a
-- create applied twice under different conditions). Now each operation is
-- applied AND logged inside one database transaction by
-- apply_sync_batch(): both commit, or neither does.
-- =====================================================================


-- ---------------------------------------------------------------------
-- 1. GPS route points recorded during a patrol
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.route_points (
    id                  UUID PRIMARY KEY,                 -- generated on the device
    patrol_id           UUID NOT NULL REFERENCES public.patrols (id) ON DELETE CASCADE,
    officer_id          UUID NOT NULL REFERENCES public.users (id) ON DELETE RESTRICT,
    latitude            NUMERIC(9, 6) NOT NULL CHECK (latitude BETWEEN -90 AND 90),
    longitude           NUMERIC(9, 6) NOT NULL CHECK (longitude BETWEEN -180 AND 180),
    accuracy_m          NUMERIC(8, 2) CHECK (accuracy_m >= 0),
    recorded_at         TIMESTAMPTZ NOT NULL,             -- device time of the GPS fix
    device_id           TEXT,
    client_updated_at   TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_route_points_patrol ON public.route_points (patrol_id, recorded_at);
CREATE INDEX IF NOT EXISTS idx_route_points_updated ON public.route_points (updated_at);

DROP TRIGGER IF EXISTS trg_route_points_sync ON public.route_points;
CREATE TRIGGER trg_route_points_sync
    BEFORE UPDATE ON public.route_points
    FOR EACH ROW EXECUTE FUNCTION public.set_sync_metadata();


-- ---------------------------------------------------------------------
-- 2. How long each patrol took (computed by Postgres, always consistent)
-- ---------------------------------------------------------------------
ALTER TABLE public.patrols
    ADD COLUMN IF NOT EXISTS duration_seconds INTEGER
    GENERATED ALWAYS AS (
        CASE
            WHEN started_at IS NOT NULL AND ended_at IS NOT NULL
            THEN EXTRACT(EPOCH FROM (ended_at - started_at))::INTEGER
        END
    ) STORED;


-- ---------------------------------------------------------------------
-- 3. sync_logs must accept the new entity type
-- ---------------------------------------------------------------------
ALTER TABLE public.sync_logs DROP CONSTRAINT IF EXISTS sync_logs_entity_type_check;
ALTER TABLE public.sync_logs ADD CONSTRAINT sync_logs_entity_type_check
    CHECK (entity_type IN ('patrols', 'checkpoints', 'route_points', 'inspections',
                           'incidents', 'locations', 'users'));


-- ---------------------------------------------------------------------
-- 4. What a device may write, per table.
--    owner_col is always forced to the caller; id/device_id/version and
--    timestamps owned by the server can never be set by a device.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._sync_spec(p_type TEXT)
RETURNS TABLE (owner_col TEXT, create_cols TEXT[], update_cols TEXT[], requires_patrol BOOLEAN)
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT s.owner_col, s.create_cols, s.update_cols, s.requires_patrol
    FROM (VALUES
        ('patrols', 'officer_id',
            ARRAY['location_id', 'status', 'scheduled_start', 'started_at', 'ended_at',
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
            ARRAY[]::TEXT[],                                  -- GPS fixes are immutable
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


-- Drop top-level null fields from a result object (keeps nested nulls).
CREATE OR REPLACE FUNCTION public._jsonb_compact(p JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
    SELECT COALESCE(jsonb_object_agg(key, value), '{}'::jsonb)
    FROM jsonb_each(p)
    WHERE value <> 'null'::jsonb
$$;


-- ---------------------------------------------------------------------
-- 5. Apply ONE operation and log it. Internal: callers must go through
--    apply_sync_batch(), which supplies the authenticated user.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public._apply_sync_operation(p_user UUID, p_device_id TEXT, p_op JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
    v_op_id      UUID;
    v_entity     UUID;
    v_type       TEXT;
    v_kind       TEXT;
    v_base       INTEGER;
    v_payload    JSONB;
    v_client_ts  TIMESTAMPTZ;
    v_spec       RECORD;
    v_log        RECORD;
    v_current    JSONB;
    v_row        JSONB;
    v_cols       TEXT;
    v_set        TEXT;
    v_version    INTEGER;
    v_result     JSONB;
BEGIN
    -- 1. Checks needed before the op can even be logged -----------------
    IF jsonb_typeof(p_op) IS DISTINCT FROM 'object' THEN
        RETURN jsonb_build_object('status', 'rejected', 'error', 'Operation must be an object.');
    END IF;

    v_type    := p_op ->> 'entity_type';
    v_kind    := p_op ->> 'operation';
    v_payload := COALESCE(NULLIF(p_op -> 'payload', 'null'::jsonb), '{}'::jsonb);

    BEGIN
        v_op_id  := (p_op ->> 'client_op_id')::UUID;
        v_entity := (p_op ->> 'entity_id')::UUID;
    EXCEPTION WHEN invalid_text_representation THEN
        RETURN public._jsonb_compact(jsonb_build_object(
            'client_op_id', p_op -> 'client_op_id', 'status', 'rejected',
            'error', 'client_op_id and entity_id must be UUIDs.'));
    END;

    IF v_op_id IS NULL OR v_entity IS NULL THEN
        RETURN public._jsonb_compact(jsonb_build_object(
            'client_op_id', p_op -> 'client_op_id', 'status', 'rejected',
            'error', 'Missing client_op_id or entity_id.'));
    END IF;

    SELECT * INTO v_spec FROM public._sync_spec(v_type);
    IF NOT FOUND OR v_kind IS NULL OR v_kind NOT IN ('create', 'update', 'delete') THEN
        RETURN jsonb_build_object('client_op_id', v_op_id, 'status', 'rejected',
            'error', format('Unsupported operation %s on %s.', COALESCE(v_kind, '?'), COALESCE(v_type, '?')));
    END IF;

    BEGIN
        v_client_ts := NULLIF(p_op ->> 'client_timestamp', '')::TIMESTAMPTZ;
    EXCEPTION WHEN data_exception THEN
        v_client_ts := NULL;
    END;

    -- 2. Idempotency: serialise concurrent retries of the same op, and
    --    answer replays from the log instead of applying them again.
    PERFORM pg_advisory_xact_lock(hashtextextended(v_op_id::TEXT, 0));

    SELECT status, result_version, server_snapshot, error_message, user_id
    INTO v_log
    FROM public.sync_logs
    WHERE client_op_id = v_op_id;

    IF FOUND THEN
        IF v_log.user_id IS DISTINCT FROM p_user THEN
            RETURN jsonb_build_object('client_op_id', v_op_id, 'status', 'rejected',
                'error', 'This operation id was already used.');
        END IF;
        RETURN public._jsonb_compact(jsonb_build_object(
            'client_op_id', v_op_id,
            'status', v_log.status,
            'result_version', v_log.result_version,
            'server_snapshot', v_log.server_snapshot,
            'error', v_log.error_message));
    END IF;

    -- 3. Apply. Business-rule failures RAISE inside this block; Postgres
    --    then rolls back every write made in the block, and the op is
    --    logged as rejected below.
    BEGIN
        IF jsonb_typeof(v_payload) <> 'object' THEN
            RAISE EXCEPTION 'payload must be an object.';
        END IF;

        IF v_kind IN ('update', 'delete') THEN
            IF jsonb_typeof(p_op -> 'base_version') IS DISTINCT FROM 'number' THEN
                RAISE EXCEPTION 'base_version (integer) is required for update/delete.';
            END IF;
            v_base := (p_op ->> 'base_version')::INTEGER;
        END IF;

        -- Lock the row so its version can't change between check and write.
        EXECUTE format('SELECT to_jsonb(t) FROM public.%I AS t WHERE t.id = $1 FOR UPDATE', v_type)
        INTO v_current
        USING v_entity;

        IF v_kind = 'create' THEN

            IF v_payload ? v_spec.owner_col
               AND v_payload ->> v_spec.owner_col IS DISTINCT FROM p_user::TEXT THEN
                RAISE EXCEPTION '% must be the logged-in user.', v_spec.owner_col;
            END IF;

            IF v_payload ? 'id' AND v_payload ->> 'id' IS DISTINCT FROM v_entity::TEXT THEN
                RAISE EXCEPTION 'payload.id does not match entity_id.';
            END IF;

            IF v_current IS NOT NULL THEN
                IF v_current ->> v_spec.owner_col IS DISTINCT FROM p_user::TEXT THEN
                    RAISE EXCEPTION 'A record with this id belongs to another user.';
                END IF;
                -- Same record already created (e.g. re-sent under a new op id).
                v_result := jsonb_build_object('status', 'applied',
                    'result_version', (v_current ->> 'version')::INTEGER);
            ELSE
                IF v_spec.requires_patrol AND NULLIF(v_payload ->> 'patrol_id', '') IS NULL THEN
                    RAISE EXCEPTION 'patrol_id is required.';
                END IF;

                IF v_type <> 'patrols' AND NULLIF(v_payload ->> 'patrol_id', '') IS NOT NULL THEN
                    PERFORM 1 FROM public.patrols
                    WHERE id = (v_payload ->> 'patrol_id')::UUID AND officer_id = p_user;
                    IF NOT FOUND THEN
                        RAISE EXCEPTION 'patrol_id is not one of your patrols.';
                    END IF;
                END IF;

                SELECT jsonb_object_agg(key, value) INTO v_row
                FROM jsonb_each(v_payload)
                WHERE key = ANY (v_spec.create_cols);

                v_row := COALESCE(v_row, '{}'::jsonb)
                      || jsonb_build_object('id', v_entity,
                                            v_spec.owner_col, p_user,
                                            'device_id', p_device_id);
                IF NOT v_row ? 'client_updated_at' THEN
                    v_row := v_row || jsonb_build_object('client_updated_at', v_client_ts);
                END IF;

                -- Only the supplied columns are inserted; the rest keep
                -- their table defaults.
                SELECT string_agg(quote_ident(k), ', ') INTO v_cols
                FROM jsonb_object_keys(v_row) AS k;

                EXECUTE format(
                    'INSERT INTO public.%1$I (%2$s) SELECT %2$s FROM jsonb_populate_record(NULL::public.%1$I, $1) RETURNING version',
                    v_type, v_cols)
                INTO v_version
                USING v_row;

                v_result := jsonb_build_object('status', 'applied', 'result_version', v_version);
            END IF;

        ELSE  -- update / delete

            IF v_current IS NULL THEN
                RAISE EXCEPTION 'Record not found on server.';
            END IF;

            IF v_current ->> v_spec.owner_col IS DISTINCT FROM p_user::TEXT THEN
                RAISE EXCEPTION 'You can only change your own records.';
            END IF;

            IF (v_current ->> 'version')::INTEGER <> v_base THEN
                v_result := jsonb_build_object(
                    'status', 'conflict',
                    'server_snapshot', v_current,
                    'error', format('Server is at version %s, you edited version %s.',
                                    v_current ->> 'version', v_base));

            ELSIF v_current ->> 'deleted_at' IS NOT NULL THEN
                RAISE EXCEPTION 'Record has been deleted.';

            ELSE
                IF v_kind = 'delete' THEN
                    v_row := jsonb_build_object('deleted_at', now());
                ELSE
                    SELECT jsonb_object_agg(key, value) INTO v_row
                    FROM jsonb_each(v_payload)
                    WHERE key = ANY (v_spec.update_cols) AND key <> 'client_updated_at';

                    IF v_row IS NULL THEN
                        RAISE EXCEPTION 'No editable fields in update.';
                    END IF;
                END IF;

                v_row := v_row || jsonb_build_object(
                    'device_id', p_device_id,
                    'client_updated_at', COALESCE(
                        CASE WHEN 'client_updated_at' = ANY (v_spec.update_cols)
                             THEN v_payload -> 'client_updated_at' END,
                        to_jsonb(v_client_ts)));

                SELECT string_agg(format('%1$I = r.%1$I', k), ', ') INTO v_set
                FROM jsonb_object_keys(v_row) AS k;

                -- set_sync_metadata() bumps version on this UPDATE.
                EXECUTE format(
                    'UPDATE public.%1$I AS t SET %2$s FROM jsonb_populate_record(NULL::public.%1$I, $1) AS r WHERE t.id = $2 RETURNING t.version',
                    v_type, v_set)
                INTO v_version
                USING v_row, v_entity;

                v_result := jsonb_build_object('status', 'applied', 'result_version', v_version);
            END IF;
        END IF;

    EXCEPTION
        WHEN raise_exception OR integrity_constraint_violation OR data_exception THEN
            v_result := jsonb_build_object('status', 'rejected', 'error', SQLERRM);
    END;

    -- 4. Log in the SAME transaction as the change. If this insert fails,
    --    the whole call fails and the change above is rolled back too.
    INSERT INTO public.sync_logs (
        client_op_id, user_id, device_id, entity_type, entity_id, operation,
        base_version, result_version, status, payload, server_snapshot,
        error_message, client_timestamp, processed_at
    ) VALUES (
        v_op_id, p_user, p_device_id, v_type, v_entity, v_kind,
        v_base, (v_result ->> 'result_version')::INTEGER, v_result ->> 'status',
        v_payload, v_result -> 'server_snapshot',
        v_result ->> 'error', v_client_ts, now()
    );

    RETURN public._jsonb_compact(v_result || jsonb_build_object('client_op_id', v_op_id));
END;
$$;


-- ---------------------------------------------------------------------
-- 6. Entry point used by POST /sync/push (supabase .rpc()).
--    The user comes from the caller's JWT (auth.uid()), never from the
--    request body. One call = one transaction for the whole batch.
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.apply_sync_batch(p_device_id TEXT, p_ops JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_user     UUID := auth.uid();
    v_device   TEXT := left(btrim(COALESCE(p_device_id, '')), 100);
    v_results  JSONB := '[]'::jsonb;
    v_op       JSONB;
BEGIN
    IF v_user IS NULL THEN
        RAISE EXCEPTION 'Not authenticated.' USING ERRCODE = '42501';
    END IF;

    IF v_device = '' THEN
        RAISE EXCEPTION 'device_id is required.' USING ERRCODE = '22023';
    END IF;

    IF jsonb_typeof(p_ops) IS DISTINCT FROM 'array' THEN
        RAISE EXCEPTION 'operations must be an array.' USING ERRCODE = '22023';
    END IF;

    IF jsonb_array_length(p_ops) > 500 THEN
        RAISE EXCEPTION 'Too many operations in one push.' USING ERRCODE = '22023';
    END IF;

    PERFORM 1 FROM public.users
    WHERE id = v_user AND is_active AND deleted_at IS NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No active user profile.' USING ERRCODE = '42501';
    END IF;

    FOR v_op IN
        SELECT value FROM jsonb_array_elements(p_ops) WITH ORDINALITY AS e (value, n) ORDER BY n
    LOOP
        v_results := v_results || jsonb_build_array(
            public._apply_sync_operation(v_user, v_device, v_op));
    END LOOP;

    UPDATE public.users SET last_sync_at = now() WHERE id = v_user;

    RETURN v_results;
END;
$$;


-- Only the batch entry point is callable by logged-in users.
REVOKE ALL ON FUNCTION public._apply_sync_operation(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.apply_sync_batch(TEXT, JSONB) FROM PUBLIC;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public._apply_sync_operation(UUID, TEXT, JSONB) FROM anon';
        EXECUTE 'REVOKE ALL ON FUNCTION public.apply_sync_batch(TEXT, JSONB) FROM anon';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        EXECUTE 'REVOKE ALL ON FUNCTION public._apply_sync_operation(UUID, TEXT, JSONB) FROM authenticated';
        EXECUTE 'GRANT EXECUTE ON FUNCTION public.apply_sync_batch(TEXT, JSONB) TO authenticated';
    END IF;
END $$;

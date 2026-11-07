-- =====================================================================
-- repair_existing_tables.sql — run this FIRST if schema.sql fails with
--   ERROR: 42703: column "updated_at" does not exist   (or any column)
--
-- Why: some tables were created by hand before schema.sql. Because
-- schema.sql uses CREATE TABLE IF NOT EXISTS, it skips those tables and
-- never adds the columns the app needs. This script adds every missing
-- column to tables that already exist. It never drops or changes your
-- data, skips tables that don't exist, and is safe to re-run.
--
-- Then run, in order: schema.sql, migrations/001, 002, 003, check_setup.sql
-- =====================================================================

-- users ---------------------------------------------------------------
ALTER TABLE IF EXISTS public.users
    ADD COLUMN IF NOT EXISTS username        TEXT,
    ADD COLUMN IF NOT EXISTS email           TEXT,
    ADD COLUMN IF NOT EXISTS full_name       TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS role            TEXT NOT NULL DEFAULT 'officer',
    ADD COLUMN IF NOT EXISTS phone           TEXT,
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS last_login_at   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS last_sync_at    TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version         INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

-- locations -----------------------------------------------------------
ALTER TABLE IF EXISTS public.locations
    ADD COLUMN IF NOT EXISTS parent_id       UUID,
    ADD COLUMN IF NOT EXISTS location_type   TEXT NOT NULL DEFAULT 'checkpoint',
    ADD COLUMN IF NOT EXISTS name            TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS code            TEXT,
    ADD COLUMN IF NOT EXISTS description     TEXT,
    ADD COLUMN IF NOT EXISTS latitude        NUMERIC(9, 6),
    ADD COLUMN IF NOT EXISTS longitude       NUMERIC(9, 6),
    ADD COLUMN IF NOT EXISTS is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS version         INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at      TIMESTAMPTZ;

-- patrols -------------------------------------------------------------
ALTER TABLE IF EXISTS public.patrols
    ADD COLUMN IF NOT EXISTS officer_id        UUID,
    ADD COLUMN IF NOT EXISTS location_id       UUID,
    ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'in_progress',
    ADD COLUMN IF NOT EXISTS scheduled_start   TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS started_at        TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS ended_at          TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS notes             TEXT,
    ADD COLUMN IF NOT EXISTS device_id         TEXT,
    ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version           INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- checkpoints (patrol scans) ------------------------------------------
ALTER TABLE IF EXISTS public.checkpoints
    ADD COLUMN IF NOT EXISTS patrol_id         UUID,
    ADD COLUMN IF NOT EXISTS location_id       UUID,
    ADD COLUMN IF NOT EXISTS officer_id        UUID,
    ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'ok',
    ADD COLUMN IF NOT EXISTS scan_method       TEXT NOT NULL DEFAULT 'manual',
    ADD COLUMN IF NOT EXISTS scanned_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS latitude          NUMERIC(9, 6),
    ADD COLUMN IF NOT EXISTS longitude         NUMERIC(9, 6),
    ADD COLUMN IF NOT EXISTS notes             TEXT,
    ADD COLUMN IF NOT EXISTS device_id         TEXT,
    ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version           INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- inspections ---------------------------------------------------------
ALTER TABLE IF EXISTS public.inspections
    ADD COLUMN IF NOT EXISTS location_id       UUID,
    ADD COLUMN IF NOT EXISTS inspector_id      UUID,
    ADD COLUMN IF NOT EXISTS patrol_id         UUID,
    ADD COLUMN IF NOT EXISTS inspection_type   TEXT NOT NULL DEFAULT 'general',
    ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'draft',
    ADD COLUMN IF NOT EXISTS result            TEXT,
    ADD COLUMN IF NOT EXISTS checklist         JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS notes             TEXT,
    ADD COLUMN IF NOT EXISTS inspected_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS reviewed_by       UUID,
    ADD COLUMN IF NOT EXISTS reviewed_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS device_id         TEXT,
    ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version           INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- incidents -----------------------------------------------------------
ALTER TABLE IF EXISTS public.incidents
    ADD COLUMN IF NOT EXISTS reported_by       UUID,
    ADD COLUMN IF NOT EXISTS location_id       UUID,
    ADD COLUMN IF NOT EXISTS patrol_id         UUID,
    ADD COLUMN IF NOT EXISTS title             TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS description       TEXT,
    ADD COLUMN IF NOT EXISTS category          TEXT NOT NULL DEFAULT 'other',
    ADD COLUMN IF NOT EXISTS severity          TEXT NOT NULL DEFAULT 'low',
    ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'open',
    ADD COLUMN IF NOT EXISTS occurred_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS assigned_to       UUID,
    ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolution_notes  TEXT,
    ADD COLUMN IF NOT EXISTS attachments       JSONB NOT NULL DEFAULT '[]'::jsonb,
    ADD COLUMN IF NOT EXISTS latitude          NUMERIC(9, 6),
    ADD COLUMN IF NOT EXISTS longitude         NUMERIC(9, 6),
    ADD COLUMN IF NOT EXISTS device_id         TEXT,
    ADD COLUMN IF NOT EXISTS client_updated_at TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS version           INTEGER NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS deleted_at        TIMESTAMPTZ;

-- sync_logs -----------------------------------------------------------
ALTER TABLE IF EXISTS public.sync_logs
    ADD COLUMN IF NOT EXISTS client_op_id      UUID,
    ADD COLUMN IF NOT EXISTS user_id           UUID,
    ADD COLUMN IF NOT EXISTS device_id         TEXT NOT NULL DEFAULT '',
    ADD COLUMN IF NOT EXISTS entity_type       TEXT,
    ADD COLUMN IF NOT EXISTS entity_id         UUID,
    ADD COLUMN IF NOT EXISTS operation         TEXT,
    ADD COLUMN IF NOT EXISTS base_version      INTEGER,
    ADD COLUMN IF NOT EXISTS result_version    INTEGER,
    ADD COLUMN IF NOT EXISTS status            TEXT NOT NULL DEFAULT 'pending',
    ADD COLUMN IF NOT EXISTS payload           JSONB,
    ADD COLUMN IF NOT EXISTS server_snapshot   JSONB,
    ADD COLUMN IF NOT EXISTS error_message     TEXT,
    ADD COLUMN IF NOT EXISTS client_timestamp  TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS received_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    ADD COLUMN IF NOT EXISTS processed_at      TIMESTAMPTZ,
    ADD COLUMN IF NOT EXISTS resolved_by       UUID,
    ADD COLUMN IF NOT EXISTS resolved_at       TIMESTAMPTZ;

-- Show what each existing table's id column is. The app needs UUID ids;
-- if any row below says something else (e.g. bigint), tell your helper.
SELECT table_name, data_type AS id_type,
       CASE WHEN data_type = 'uuid' THEN 'OK' ELSE 'NOT UUID — needs attention' END AS status
FROM information_schema.columns
WHERE table_schema = 'public' AND column_name = 'id'
  AND table_name IN ('users', 'locations', 'patrols', 'checkpoints',
                     'inspections', 'incidents', 'sync_logs')
ORDER BY table_name;

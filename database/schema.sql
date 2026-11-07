-- =====================================================================
-- Offline-first security patrol app — database schema (PostgreSQL / Supabase)
--
-- Run in: Supabase Dashboard -> SQL Editor (or psql).
-- Safe to re-run: uses IF NOT EXISTS / CREATE OR REPLACE.
--
-- Sync design (applies to every table a field device can write to):
--   id                 UUID generated ON THE DEVICE, so records created offline
--                      keep the same identity when synced (no duplicates on retry).
--   version            Bumped by the server on every update. The client sends the
--                      version it last saw; a mismatch = conflict.
--   created_at /
--   updated_at         Server clock. updated_at drives "give me everything changed
--                      since X" pulls.
--   client_updated_at  Device clock at the moment of the edit (audit / tie-break).
--   deleted_at         Soft delete. Hard deletes can't be synced to offline devices.
--   device_id          Which device produced the latest change.
-- =====================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- gen_random_uuid()

-- ---------------------------------------------------------------------
-- Shared trigger: maintain updated_at and version on every UPDATE
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION set_sync_metadata()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at := now();
    NEW.version    := OLD.version + 1;
    NEW.created_at := OLD.created_at;   -- never let a client rewrite creation time
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ---------------------------------------------------------------------
-- 1. users — accounts and roles
-- ---------------------------------------------------------------------
-- Passwords are stored by Supabase Auth (auth.users), never here. Each row
-- is the profile of one auth account and is created by the
-- on_auth_user_created trigger in migrations/001_supabase_auth_profiles.sql
-- (run that file after this one).
CREATE TABLE IF NOT EXISTS users (
    id              UUID PRIMARY KEY REFERENCES auth.users (id) ON DELETE CASCADE,
    username        TEXT,
    email           TEXT NOT NULL UNIQUE,
    full_name       TEXT NOT NULL DEFAULT '',
    role            TEXT NOT NULL DEFAULT 'officer'
                    CHECK (role IN ('admin', 'supervisor', 'officer')),
    phone           TEXT,
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    last_sync_at    TIMESTAMPTZ,                        -- last successful sync from any device
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ
);


-- ---------------------------------------------------------------------
-- 2. locations — buildings, areas and checkpoint points (hierarchical)
--    building  -> area -> checkpoint   via parent_id
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    parent_id       UUID REFERENCES locations(id) ON DELETE RESTRICT,
    location_type   TEXT NOT NULL
                    CHECK (location_type IN ('building', 'area', 'checkpoint')),
    name            TEXT NOT NULL,
    code            TEXT UNIQUE,                        -- QR / NFC tag value scanned on site
    description     TEXT,
    latitude        NUMERIC(9, 6),
    longitude       NUMERIC(9, 6),
    is_active       BOOLEAN NOT NULL DEFAULT TRUE,
    version         INTEGER NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at      TIMESTAMPTZ,
    CHECK (parent_id IS NULL OR parent_id <> id),
    CHECK (location_type <> 'building' OR parent_id IS NULL)   -- buildings are top level
);


-- ---------------------------------------------------------------------
-- 3. patrols — one patrol session by one officer
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS patrols (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    officer_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    location_id         UUID REFERENCES locations(id) ON DELETE RESTRICT,  -- building/area patrolled
    status              TEXT NOT NULL DEFAULT 'in_progress'
                        CHECK (status IN ('scheduled', 'in_progress', 'completed', 'abandoned')),
    scheduled_start     TIMESTAMPTZ,
    started_at          TIMESTAMPTZ,
    ended_at            TIMESTAMPTZ,
    notes               TEXT,
    -- sync
    device_id           TEXT,
    client_updated_at   TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ,
    CHECK (ended_at IS NULL OR started_at IS NULL OR ended_at >= started_at)
);


-- ---------------------------------------------------------------------
-- 4. checkpoints — each checkpoint visit/scan recorded during a patrol
--    (the physical checkpoint itself lives in locations, type='checkpoint')
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS checkpoints (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    patrol_id           UUID NOT NULL REFERENCES patrols(id) ON DELETE CASCADE,
    location_id         UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    officer_id          UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    status              TEXT NOT NULL DEFAULT 'ok'
                        CHECK (status IN ('ok', 'issue_found', 'missed', 'skipped')),
    scan_method         TEXT NOT NULL DEFAULT 'manual'
                        CHECK (scan_method IN ('qr', 'nfc', 'gps', 'manual')),
    scanned_at          TIMESTAMPTZ NOT NULL,           -- device time of the scan (offline-safe)
    latitude            NUMERIC(9, 6),
    longitude           NUMERIC(9, 6),
    notes               TEXT,
    -- sync
    device_id           TEXT,
    client_updated_at   TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);


-- ---------------------------------------------------------------------
-- 5. inspections — inspection records (checklist answers stored as JSON)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS inspections (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id         UUID NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
    inspector_id        UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    patrol_id           UUID REFERENCES patrols(id) ON DELETE SET NULL,     -- optional
    inspection_type     TEXT NOT NULL,                  -- e.g. 'fire_safety', 'door_lock', 'cctv'
    status              TEXT NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'submitted', 'reviewed')),
    result              TEXT
                        CHECK (result IN ('pass', 'fail', 'needs_attention')),
    checklist           JSONB NOT NULL DEFAULT '[]'::jsonb,
                        -- e.g. [{"item":"Fire exit clear","answer":"yes","note":null}, ...]
    notes               TEXT,
    inspected_at        TIMESTAMPTZ NOT NULL,           -- device time
    reviewed_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    reviewed_at         TIMESTAMPTZ,
    -- sync
    device_id           TEXT,
    client_updated_at   TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);


-- ---------------------------------------------------------------------
-- 6. incidents — incident reports
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS incidents (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    reported_by         UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
    location_id         UUID REFERENCES locations(id) ON DELETE RESTRICT,
    patrol_id           UUID REFERENCES patrols(id) ON DELETE SET NULL,     -- optional
    title               TEXT NOT NULL,
    description         TEXT,
    category            TEXT NOT NULL DEFAULT 'other'
                        CHECK (category IN ('intrusion', 'theft', 'vandalism', 'fire',
                                            'medical', 'hazard', 'equipment_fault', 'other')),
    severity            TEXT NOT NULL DEFAULT 'low'
                        CHECK (severity IN ('low', 'medium', 'high', 'critical')),
    status              TEXT NOT NULL DEFAULT 'open'
                        CHECK (status IN ('open', 'investigating', 'resolved', 'closed')),
    occurred_at         TIMESTAMPTZ NOT NULL,           -- device time
    assigned_to         UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ,
    resolution_notes    TEXT,
    attachments         JSONB NOT NULL DEFAULT '[]'::jsonb,   -- photo/file URLs or storage keys
    latitude            NUMERIC(9, 6),
    longitude           NUMERIC(9, 6),
    -- sync
    device_id           TEXT,
    client_updated_at   TIMESTAMPTZ,
    version             INTEGER NOT NULL DEFAULT 1,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    deleted_at          TIMESTAMPTZ
);


-- ---------------------------------------------------------------------
-- 7. sync_logs — one row per change a device pushes (audit + idempotency)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sync_logs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_op_id        UUID NOT NULL UNIQUE,           -- generated on device; a retried push
                                                        -- with the same id is ignored, not re-applied
    user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
    device_id           TEXT NOT NULL,
    entity_type         TEXT NOT NULL
                        CHECK (entity_type IN ('patrols', 'checkpoints', 'inspections',
                                               'incidents', 'locations', 'users')),
    entity_id           UUID NOT NULL,
    operation           TEXT NOT NULL
                        CHECK (operation IN ('create', 'update', 'delete')),
    base_version        INTEGER,                        -- version the device edited from
    result_version      INTEGER,                        -- version after the server applied it
    status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'applied', 'conflict', 'rejected', 'resolved')),
    payload             JSONB,                          -- what the device sent
    server_snapshot     JSONB,                          -- server row at conflict time
    error_message       TEXT,
    client_timestamp    TIMESTAMPTZ,                    -- when the change happened on device
    received_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at        TIMESTAMPTZ,
    resolved_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    resolved_at         TIMESTAMPTZ
);


-- ---------------------------------------------------------------------
-- Triggers: updated_at + version on every synced table
-- ---------------------------------------------------------------------
DO $$
DECLARE t TEXT;
BEGIN
    FOREACH t IN ARRAY ARRAY['users', 'locations', 'patrols', 'checkpoints',
                             'inspections', 'incidents']
    LOOP
        EXECUTE format('DROP TRIGGER IF EXISTS trg_%1$s_sync ON %1$I', t);
        EXECUTE format(
            'CREATE TRIGGER trg_%1$s_sync BEFORE UPDATE ON %1$I
             FOR EACH ROW EXECUTE FUNCTION set_sync_metadata()', t);
    END LOOP;
END $$;


-- ---------------------------------------------------------------------
-- Indexes
-- ---------------------------------------------------------------------
-- Incremental pull: "everything changed since my last sync"
CREATE INDEX IF NOT EXISTS idx_users_updated        ON users (updated_at);
CREATE INDEX IF NOT EXISTS idx_locations_updated    ON locations (updated_at);
CREATE INDEX IF NOT EXISTS idx_patrols_updated      ON patrols (updated_at);
CREATE INDEX IF NOT EXISTS idx_checkpoints_updated  ON checkpoints (updated_at);
CREATE INDEX IF NOT EXISTS idx_inspections_updated  ON inspections (updated_at);
CREATE INDEX IF NOT EXISTS idx_incidents_updated    ON incidents (updated_at);

-- Foreign-key lookups
CREATE INDEX IF NOT EXISTS idx_locations_parent     ON locations (parent_id);
CREATE INDEX IF NOT EXISTS idx_patrols_officer      ON patrols (officer_id, status);
CREATE INDEX IF NOT EXISTS idx_checkpoints_patrol   ON checkpoints (patrol_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_location ON checkpoints (location_id);
CREATE INDEX IF NOT EXISTS idx_inspections_location ON inspections (location_id);
CREATE INDEX IF NOT EXISTS idx_inspections_inspector ON inspections (inspector_id);
CREATE INDEX IF NOT EXISTS idx_incidents_status     ON incidents (status, severity);
CREATE INDEX IF NOT EXISTS idx_incidents_location   ON incidents (location_id);

-- Sync log lookups
CREATE INDEX IF NOT EXISTS idx_sync_logs_entity     ON sync_logs (entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_device     ON sync_logs (device_id, received_at);
CREATE INDEX IF NOT EXISTS idx_sync_logs_conflicts  ON sync_logs (status) WHERE status = 'conflict';


-- ---------------------------------------------------------------------
-- Row Level Security (OPTIONAL — read before enabling)
-- If Flask connects with the SERVICE ROLE key, RLS is bypassed and this is
-- just a safety net against the public anon key. If Flask uses the ANON key,
-- enabling this with no policies will block Flask too.
-- ---------------------------------------------------------------------
-- ALTER TABLE users       ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE locations   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE patrols     ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE checkpoints ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE inspections ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE incidents   ENABLE ROW LEVEL SECURITY;
-- ALTER TABLE sync_logs   ENABLE ROW LEVEL SECURITY;

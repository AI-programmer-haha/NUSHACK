-- =====================================================================
-- check_setup.sql — is the database ready for the supervisor console?
--
-- Paste into Supabase Dashboard -> SQL Editor and Run. Read-only: it
-- changes nothing. Every row should say OK. For anything MISSING, run the
-- setup files in this order (each is safe to re-run):
--
--   1. database/schema.sql
--   2. database/migrations/001_supabase_auth_profiles.sql
--   3. database/migrations/002_atomic_sync.sql
--   4. database/migrations/003_routes_alerts_messages.sql
--
-- A MISSING *column* on a table that exists means that table was created
-- by hand before schema.sql ("CREATE TABLE IF NOT EXISTS" won't add
-- columns to it). Add the column with ALTER TABLE ... ADD COLUMN, or, if
-- the table holds nothing you need, drop it and re-run the files above.
--
-- Note: physical checkpoints are rows in `locations` with
-- location_type = 'checkpoint'. The `checkpoints` table stores the scans
-- officers make during patrols. Migration 003 attaches a trigger to it, so
-- if `checkpoints` is missing, 003 fails as a whole and save_checkpoint()
-- (the function behind "Create checkpoint") never gets created.
-- =====================================================================

WITH required_tables(name, created_by) AS (
    VALUES ('users', 'schema.sql'), ('locations', 'schema.sql'),
           ('patrols', 'schema.sql'), ('checkpoints', 'schema.sql'),
           ('sync_logs', 'schema.sql'), ('route_points', '002'),
           ('patrol_routes', '003'), ('route_stops', '003'),
           ('route_assignments', '003'), ('route_alerts', '003'),
           ('messages', '003')
),
required_columns(tbl, col) AS (
    VALUES ('locations', 'location_type'), ('locations', 'parent_id'),
           ('locations', 'code'), ('locations', 'latitude'),
           ('locations', 'longitude'), ('locations', 'deleted_at'),
           ('locations', 'updated_at'), ('locations', 'version'),
           ('users', 'updated_at'), ('patrols', 'updated_at'),
           ('users', 'role'), ('users', 'username'), ('patrols', 'route_id')
),
required_functions(name, created_by) AS (
    VALUES ('save_checkpoint', '003'), ('save_patrol_route', '003'),
           ('list_patrol_routes', '003'), ('list_officers', '003'),
           ('supervisor_overview', '003'), ('apply_sync_batch', '002')
)
SELECT 'table' AS kind, t.name AS item, t.created_by AS created_by,
       CASE WHEN to_regclass('public.' || t.name) IS NULL THEN 'MISSING' ELSE 'OK' END AS status
FROM required_tables t
UNION ALL
SELECT 'column', c.tbl || '.' || c.col, 'schema.sql / 003',
       CASE WHEN EXISTS (SELECT 1 FROM information_schema.columns ic
                         WHERE ic.table_schema = 'public' AND ic.table_name = c.tbl
                           AND ic.column_name = c.col)
            THEN 'OK' ELSE 'MISSING' END
FROM required_columns c
UNION ALL
SELECT 'function', f.name || '()', f.created_by,
       CASE WHEN EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
                         WHERE n.nspname = 'public' AND p.proname = f.name)
            THEN 'OK' ELSE 'MISSING' END
FROM required_functions f
UNION ALL
SELECT 'supervisors', 'users with role supervisor/admin', 'UPDATE users SET role = ''supervisor'' ...',
       CASE WHEN to_regclass('public.users') IS NULL THEN 'MISSING'
            -- dynamic query, so this script still runs when users doesn't exist yet
            WHEN (xpath('/row/n/text()', query_to_xml(
                    'SELECT count(*) AS n FROM public.users WHERE role IN (''supervisor'', ''admin'')',
                    false, true, '')))[1]::text::int > 0 THEN 'OK'
            ELSE 'MISSING' END
ORDER BY status, kind, item;   -- MISSING rows first

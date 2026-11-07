-- =====================================================================
-- 001 — Make public.users match Supabase Auth registration
--
-- Run once in: Supabase Dashboard -> SQL Editor. Safe to re-run.
--
-- Problem: schema.sql was written for a self-managed password table
-- (password_hash NOT NULL), but app.py registers users through Supabase
-- Auth, which stores passwords itself. Inserting a profile without a
-- password_hash violated the NOT NULL constraint, so profiles were never
-- created and patrols could not reference officer_id.
-- =====================================================================

-- 1. Passwords live in auth.users. Relax the column rather than dropping
--    it so no existing data is destroyed. (Drop it later once confirmed
--    unused:  ALTER TABLE public.users DROP COLUMN password_hash;)
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users'
          AND column_name = 'password_hash'
    ) THEN
        ALTER TABLE public.users ALTER COLUMN password_hash DROP NOT NULL;
    END IF;
END $$;

-- 2. full_name is optional at sign-up. username is chosen at sign-up
--    (login.html / app.py ensure_profile) and stored on the profile.
ALTER TABLE public.users ALTER COLUMN full_name SET DEFAULT '';
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS username TEXT;

-- 3. Create the profile automatically whenever someone signs up.

CREATE OR REPLACE FUNCTION public.handle_new_auth_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    INSERT INTO public.users (
        id,
        username,
        email,
        full_name,
        role
    )
    VALUES (
        NEW.id,
        COALESCE(
            NULLIF(NEW.raw_user_meta_data ->> 'username', ''),
            split_part(NEW.email, '@', 1)
        ),
        lower(NEW.email),
        COALESCE(NEW.raw_user_meta_data ->> 'full_name', ''),
        'officer'
    )
    ON CONFLICT (id) DO NOTHING;

    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;

CREATE TRIGGER on_auth_user_created
    AFTER INSERT ON auth.users
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_new_auth_user();

-- 4. Backfill profiles for accounts that registered before this fix.

INSERT INTO public.users (
    id,
    username,
    email,
    full_name,
    role
)
SELECT
    a.id,
    COALESCE(
        NULLIF(a.raw_user_meta_data ->> 'username', ''),
        split_part(a.email, '@', 1)
    ),
    lower(a.email),
    COALESCE(a.raw_user_meta_data ->> 'full_name', ''),
    'officer'
FROM auth.users a
WHERE a.email IS NOT NULL
ON CONFLICT DO NOTHING;

-- 5. Link profiles to auth accounts. NOT VALID = enforce for new rows
--    without failing on any legacy rows that have no auth account.
DO $$
BEGIN
    IF NOT EXISTS (                       -- any FK from users to auth.users
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.users'::regclass
          AND confrelid = 'auth.users'::regclass
          AND contype = 'f'
    ) THEN
        ALTER TABLE public.users
            ADD CONSTRAINT users_id_auth_fkey
            FOREIGN KEY (id) REFERENCES auth.users (id) ON DELETE CASCADE
            NOT VALID;
    END IF;
END $$;

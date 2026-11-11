-- ============================================================
-- COVAULT DATABASE SCHEMA — GENERATED FROM THE LIVE PROJECT
-- ============================================================
-- What a brand-new Covault database needs, in one file. Run it once, in the
-- Supabase SQL editor of an EMPTY project, before the app signs anyone in.
--
-- Where it came from. On 2026-10-03 this was generated from the live
-- project's own catalog (tables, constraints, indexes, functions, access
-- rules, grants, the sign-up trigger and the nightly job) through the
-- read-only Supabase connection, not reconstructed from the migration files.
-- The previous version of this file WAS reconstructed from them, and by
-- September it was missing household sharing, partner linking by code,
-- account deletion and most of the access rules that keep two households
-- apart. It was then loaded into an empty Supabase Postgres 17.6 and that
-- database's catalog compared against the live one. Every part matches; see
-- docs/DATABASE_SETUP.md for what was compared. (Until
-- migrations/2026_09_settings_insert_columns.sql was applied to live later
-- the same day, the settings INSERT grant was the one difference.)
--
-- What this file is NOT:
--   - A migration for an existing database. It refuses to run if the tables
--     already exist. An existing database is brought up to date by the
--     migration files instead — docs/DATABASE_SETUP.md says which.
--   - Something to edit by hand when the live database changes. Write a
--     migration, apply it, and regenerate this file the same way.
--
-- Supabase-specific: it assumes the auth schema, the anon / authenticated /
-- service_role roles, and the pgcrypto and pg_cron extensions a Supabase
-- project provides. It will not run on plain Postgres.
-- ============================================================

DO $$ BEGIN
  IF to_regclass('public.transactions') IS NOT NULL THEN
    RAISE EXCEPTION 'Covault tables already exist here. schema.sql is for an empty project only; see docs/DATABASE_SETUP.md for updating an existing one.';
  END IF;
END $$;

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pg_cron;


-- ============================================================
-- ENUMS
-- ============================================================
-- These are Postgres enums, not free text: a value the enum does not list is
-- rejected on insert, and a query that FILTERS on one fails outright. Adding
-- a category or a cadence is a migration first and app code second.
-- schemaEnumsMatchTheApp.test.ts pins these lists to the app's own.

CREATE TYPE public."Budgets" AS ENUM (
  'Housing',
  'Groceries',
  'Leisure',
  'Utilities',
  'Transport',
  'Services',
  'Other',
  'Shopping',
  'Personal',
  'Travel'
);

CREATE TYPE public."Recurrence" AS ENUM (
  'One-time',
  'Biweekly',
  'Monthly',
  'Yearly'
);

CREATE TYPE public."Type" AS ENUM (
  'Manual',
  'Automatic'
);


-- ============================================================
-- TABLES
-- ============================================================

CREATE TABLE public.banks (
  package_name text NOT NULL,
  display_name text NOT NULL
);

-- No primary key and no sort column, on purpose of history rather than
-- design: the app fixes the order in lib/budgetOrder.ts, and reads both
-- user_uuid/user_id and Visible/visible spellings.
CREATE TABLE public.budgets (
  user_uuid uuid,
  budget public."Budgets",
  amount numeric,
  "Visible" boolean DEFAULT true NOT NULL
);

CREATE TABLE public.community_rules (
  match_key text NOT NULL,
  category_id public."Budgets" NOT NULL,
  household_count integer NOT NULL,
  agreement numeric NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.notification_rules (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  pattern text NOT NULL,
  pattern_type text DEFAULT 'exact'::text NOT NULL,
  use_count integer DEFAULT 0 NOT NULL,
  last_used_at timestamp with time zone DEFAULT now(),
  created_at timestamp with time zone DEFAULT now(),
  recent_uses jsonb DEFAULT '[]'::jsonb NOT NULL,
  source_text text
);

CREATE TABLE public.overrides (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  category_id public."Budgets" NOT NULL,
  proper_name text,
  match_key text,
  match_type text DEFAULT 'exact'::text NOT NULL,
  updated_at timestamp with time zone DEFAULT now()
);

CREATE TABLE public.rule_contributions (
  user_id uuid NOT NULL,
  match_key text NOT NULL,
  category_id public."Budgets" NOT NULL,
  updated_at timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE public.settings (
  user_id uuid NOT NULL,
  name text NOT NULL,
  email text NOT NULL,
  partner_id uuid,
  partner_email text,
  partner_name text,
  budgeting_solo boolean DEFAULT true,
  monthly_income numeric DEFAULT 0,
  rollover_enabled boolean DEFAULT true,
  leisure_buffer_enabled boolean DEFAULT true,
  show_savings_insight boolean DEFAULT true,
  app_notifications_enabled boolean DEFAULT false,
  theme_selected text DEFAULT 'dark'::text,
  trial_started_at timestamp with time zone,
  trial_ends_at timestamp with time zone,
  trial_consumed boolean DEFAULT false,
  subscription_status text DEFAULT 'none'::text,
  link_code text,
  smart_notifications_enabled boolean DEFAULT true NOT NULL,
  auto_accept_known_vendors boolean DEFAULT false NOT NULL,
  haptics_enabled boolean DEFAULT true NOT NULL,
  community_rules_enabled boolean DEFAULT true NOT NULL,
  community_rules_contribute boolean DEFAULT false NOT NULL,
  is_tester boolean DEFAULT false NOT NULL,
  share_level text DEFAULT 'transactions'::text NOT NULL,
  budget_mode text DEFAULT 'separate'::text NOT NULL,
  link_code_expires_at timestamp with time zone
);

CREATE TABLE public.transactions (
  id uuid DEFAULT gen_random_uuid() NOT NULL,
  user_id uuid NOT NULL,
  vendor text NOT NULL,
  amount numeric(12,2) NOT NULL,
  date date NOT NULL,
  is_projected boolean DEFAULT false NOT NULL,
  budget public."Budgets" NOT NULL,
  type public."Type" DEFAULT 'Manual'::"Type" NOT NULL,
  recur public."Recurrence" DEFAULT 'One-time'::"Recurrence" NOT NULL,
  created_at timestamp with time zone DEFAULT now(),
  caught_cleared boolean DEFAULT false NOT NULL,
  source text DEFAULT 'manual'::text NOT NULL,
  refunded boolean DEFAULT false NOT NULL,
  raw_notification text,
  confidence numeric,
  auto_filed boolean DEFAULT false NOT NULL
);


-- ============================================================
-- CONSTRAINTS
-- ============================================================

ALTER TABLE public.banks ADD CONSTRAINT known_banking_apps_pkey PRIMARY KEY (package_name);
ALTER TABLE public.community_rules ADD CONSTRAINT community_rules_pkey PRIMARY KEY (match_key);
ALTER TABLE public.notification_rules ADD CONSTRAINT notification_rules_pkey PRIMARY KEY (id);
ALTER TABLE public.overrides ADD CONSTRAINT vendor_overrides_pkey PRIMARY KEY (id);
ALTER TABLE public.rule_contributions ADD CONSTRAINT rule_contributions_pkey PRIMARY KEY (user_id, match_key);
ALTER TABLE public.settings ADD CONSTRAINT settings_pkey PRIMARY KEY (user_id);
ALTER TABLE public.transactions ADD CONSTRAINT transactions_pkey PRIMARY KEY (id);

ALTER TABLE public.budgets ADD CONSTRAINT unique_user_budget UNIQUE (user_uuid, budget);
ALTER TABLE public.overrides ADD CONSTRAINT overrides_id_key UNIQUE (id);
ALTER TABLE public.settings ADD CONSTRAINT settings_email_key UNIQUE (email);
ALTER TABLE public.settings ADD CONSTRAINT settings_user_id_key UNIQUE (user_id);
ALTER TABLE public.transactions ADD CONSTRAINT transactions_id_key UNIQUE (id);

ALTER TABLE public.notification_rules ADD CONSTRAINT notification_rules_pattern_type_check CHECK ((pattern_type = ANY (ARRAY['exact'::text, 'contains'::text])));
ALTER TABLE public.overrides ADD CONSTRAINT overrides_match_type_check CHECK ((match_type = ANY (ARRAY['exact'::text, 'prefix'::text, 'contains'::text])));
ALTER TABLE public.settings ADD CONSTRAINT settings_budget_mode_check CHECK ((budget_mode = ANY (ARRAY['separate'::text, 'combined'::text])));
ALTER TABLE public.settings ADD CONSTRAINT settings_monthly_income_check CHECK ((monthly_income >= (0)::numeric));
ALTER TABLE public.settings ADD CONSTRAINT settings_share_level_check CHECK ((share_level = ANY (ARRAY['transactions'::text, 'categories'::text, 'totals'::text])));
ALTER TABLE public.settings ADD CONSTRAINT settings_subscription_status_check CHECK ((subscription_status = ANY (ARRAY['none'::text, 'active'::text, 'expired'::text])));
ALTER TABLE public.transactions ADD CONSTRAINT transactions_source_check CHECK ((source = ANY (ARRAY['executor'::text, 'notification'::text, 'manual'::text, 'import'::text])));

ALTER TABLE public.budgets ADD CONSTRAINT budgets_user_uuid_fkey FOREIGN KEY (user_uuid) REFERENCES auth.users(id);
ALTER TABLE public.notification_rules ADD CONSTRAINT notification_rules_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
ALTER TABLE public.overrides ADD CONSTRAINT vendor_overrides_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.rule_contributions ADD CONSTRAINT rule_contributions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.settings ADD CONSTRAINT settings_partner_id_fkey FOREIGN KEY (partner_id) REFERENCES auth.users(id);
ALTER TABLE public.settings ADD CONSTRAINT settings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
ALTER TABLE public.transactions ADD CONSTRAINT transactions_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;


-- ============================================================
-- INDEXES
-- ============================================================

CREATE INDEX idx_community_rules_key ON public.community_rules USING btree (match_key);
CREATE INDEX idx_notification_rules_user ON public.notification_rules USING btree (user_id);
CREATE INDEX idx_overrides_user_match_key ON public.overrides USING btree (user_id, match_key);
CREATE INDEX idx_overrides_user_updated_at ON public.overrides USING btree (user_id, updated_at DESC);
CREATE INDEX overrides_match_key_idx ON public.overrides USING btree (match_key);
CREATE INDEX idx_rule_contributions_match_key ON public.rule_contributions USING btree (match_key);
CREATE INDEX idx_transactions_date ON public.transactions USING btree (date);
CREATE INDEX idx_transactions_user_date_unrefunded ON public.transactions USING btree (user_id, date) WHERE ((refunded = false) AND (amount > (0)::numeric) AND (is_projected = false));
CREATE INDEX idx_transactions_user_id ON public.transactions USING btree (user_id);
CREATE INDEX idx_transactions_user_source_date ON public.transactions USING btree (user_id, source, date);
CREATE INDEX idx_transactions_user_vendor ON public.transactions USING btree (user_id, vendor);
CREATE INDEX idx_transactions_user_vendor_amount ON public.transactions USING btree (user_id, vendor, amount) WHERE (is_projected = false);


-- ============================================================
-- COMMENTS
-- ============================================================

COMMENT ON COLUMN public.settings.theme_selected IS 'dark or light theme';
COMMENT ON COLUMN public.transactions.type IS 'Is the transaction manual or automatic?';
COMMENT ON COLUMN public.transactions.raw_notification IS 'Original raw notification text that produced this transaction. Populated by the notification pipeline. Used by the <> page to show the user what the parser saw, and to enable vendor correction.';


-- ============================================================
-- FUNCTIONS
-- ============================================================
-- Every SECURITY DEFINER function pins search_path, and each one checks
-- auth.uid() itself, because it runs as the table owner and RLS does not
-- apply inside it. definerFunctionGrants.test.ts holds the rule.

CREATE FUNCTION public.delete_own_account()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_me uuid := auth.uid();
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  UPDATE public.settings SET partner_id = NULL, partner_name = NULL, partner_email = NULL WHERE partner_id = v_me;
  DELETE FROM public.transactions       WHERE user_id   = v_me;
  DELETE FROM public.overrides          WHERE user_id   = v_me;
  DELETE FROM public.rule_contributions WHERE user_id   = v_me;
  DELETE FROM public.notification_rules WHERE user_id   = v_me;
  DELETE FROM public.budgets            WHERE user_uuid = v_me;
  DELETE FROM public.settings           WHERE user_id   = v_me;
  DELETE FROM auth.users WHERE id = v_me;
END;
$function$;

CREATE FUNCTION public.generate_link_code()
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_alphabet CONSTANT text := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
  v_me uuid := auth.uid();
  v_code text;
  v_try int := 0;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  LOOP
    v_try := v_try + 1;
    IF v_try > 20 THEN RAISE EXCEPTION 'Could not mint a link code'; END IF;
    SELECT string_agg(substr(v_alphabet, 1 + (get_byte(b.bytes, i) % length(v_alphabet)), 1), '')
      INTO v_code
      FROM (SELECT extensions.gen_random_bytes(8) AS bytes) b, generate_series(0, 7) AS i;
    EXIT WHEN NOT EXISTS (
      SELECT 1 FROM public.settings s WHERE s.link_code = v_code AND s.link_code_expires_at > now()
    );
  END LOOP;
  UPDATE public.settings s
     SET link_code = v_code, link_code_expires_at = now() + interval '30 minutes'
   WHERE s.user_id = v_me;
  RETURN v_code;
END;
$function$;

CREATE FUNCTION public.generate_transaction_hash(p_amount numeric, p_vendor text, p_date date)
 RETURNS text
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  RETURN md5(p_amount::TEXT || '|' || LOWER(TRIM(p_vendor)) || '|' || p_date::TEXT);
END;
$function$;

-- The sign-up trigger. Every account gets its settings row here, which is
-- why a client almost never needs to create one itself.
CREATE FUNCTION public.handle_new_user()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  INSERT INTO public.settings (
    user_id,
    name,
    email,
    monthly_income,
    trial_started_at,
    trial_ends_at,
    trial_consumed,
    subscription_status
  )
  VALUES (
    NEW.id,
    COALESCE(
      NEW.raw_user_meta_data ->> 'full_name',
      split_part(NEW.email, '@', 1),
      'User'
    ),
    NEW.email,
    5000,
    now(),
    now() + interval '1 month',
    true,
    'none'
  )
  ON CONFLICT (user_id) DO NOTHING;

  RETURN NEW;
END;
$function$;

CREATE FUNCTION public.link_partner_by_code(p_code text)
 RETURNS TABLE(partner_id uuid, partner_name text, partner_email text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me uuid := auth.uid();
  v_my_name text; v_my_email text;
  v_other_id uuid; v_other_name text; v_other_email text;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_code IS NULL OR btrim(p_code) = '' THEN RAISE EXCEPTION 'Invalid or expired link code'; END IF;
  SELECT s.name, s.email INTO v_my_name, v_my_email FROM public.settings s WHERE s.user_id = v_me;
  UPDATE public.settings s
     SET partner_id = v_me, partner_name = v_my_name, partner_email = v_my_email,
         link_code = NULL, link_code_expires_at = NULL
   WHERE upper(s.link_code) = upper(btrim(p_code))
     AND s.link_code_expires_at > now()
     AND s.user_id <> v_me
  RETURNING s.user_id, s.name, s.email INTO v_other_id, v_other_name, v_other_email;
  IF v_other_id IS NULL THEN RAISE EXCEPTION 'Invalid or expired link code'; END IF;
  UPDATE public.settings s
     SET partner_id = v_other_id, partner_name = v_other_name, partner_email = v_other_email
   WHERE s.user_id = v_me;
  RETURN QUERY SELECT v_other_id, v_other_name, v_other_email;
END;
$function$;

CREATE FUNCTION public.linked_partner_id()
 RETURNS uuid
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT mine.partner_id
    FROM public.settings mine
    JOIN public.settings theirs ON theirs.user_id = mine.partner_id
   WHERE mine.user_id = auth.uid()
     AND mine.partner_id IS NOT NULL
     AND theirs.partner_id = mine.user_id;
$function$;

COMMENT ON FUNCTION public.linked_partner_id() IS 'The mutually-confirmed partner of the calling user, or NULL. SECURITY DEFINER because confirming the other row points back requires reading it. Every partner SELECT policy goes through this - a one-sided partner_id is not a link.';

-- Not a SECURITY DEFINER function, so RLS still applies inside it: a caller
-- passing someone else's user id gets no rows back.
CREATE FUNCTION public.match_vendor(p_user_id uuid, p_raw_vendor text)
 RETURNS TABLE(rule_id text, proper_name text, category_id text, category_name text, confidence double precision, match_type text)
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_key text;
BEGIN
  v_key := lower(regexp_replace(p_raw_vendor, '[^a-z0-9]', '', 'g'));

  -- 1. Exact match
  RETURN QUERY
    SELECT o.id::text, o.proper_name, o.category_id, o.category_id,
           0.95, 'exact'
      FROM overrides o
     WHERE o.user_id = p_user_id
       AND (lower(regexp_replace(o.match_key, '[^a-z0-9]', '', 'g')) = v_key
            OR lower(regexp_replace(o.proper_name, '[^a-z0-9]', '', 'g')) = v_key)
     LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- 2. Prefix match
  RETURN QUERY
    SELECT o.id::text, o.proper_name, o.category_id, o.category_id,
           0.75, 'prefix'
      FROM overrides o
     WHERE o.user_id = p_user_id
       AND (v_key LIKE lower(regexp_replace(o.match_key, '[^a-z0-9]', '', 'g')) || '%'
            OR lower(regexp_replace(o.match_key, '[^a-z0-9]', '', 'g')) LIKE v_key || '%')
     LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- 3. Contains match
  RETURN QUERY
    SELECT o.id::text, o.proper_name, o.category_id, o.category_id,
           0.55, 'contains'
      FROM overrides o
     WHERE o.user_id = p_user_id
       AND (v_key LIKE '%' || lower(regexp_replace(o.match_key, '[^a-z0-9]', '', 'g')) || '%'
            OR lower(regexp_replace(o.match_key, '[^a-z0-9]', '', 'g')) LIKE '%' || v_key || '%')
     LIMIT 1;

  IF FOUND THEN RETURN; END IF;

  -- No match
  RETURN QUERY SELECT NULL::text, NULL::text, NULL::text, NULL::text, 0.0, 'none';
END;
$function$;

CREATE FUNCTION public.partner_month_summary(p_month text)
 RETURNS TABLE(share_level text, budget text, total numeric)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_partner uuid; v_level text;
BEGIN
  IF p_month IS NULL OR p_month !~ '^\d{4}-\d{2}$' THEN
    RAISE EXCEPTION 'Month must look like 2026-09';
  END IF;
  v_partner := public.linked_partner_id();
  IF v_partner IS NULL THEN RETURN; END IF;
  v_level := public.partner_share_level();
  IF v_level IS NULL OR v_level = 'transactions' THEN RETURN; END IF;
  IF v_level = 'categories' THEN
    RETURN QUERY
      SELECT v_level, t.budget::text, SUM(t.amount)::numeric
        FROM public.transactions t
       WHERE t.user_id = v_partner AND to_char(t.date, 'YYYY-MM') = p_month AND t.is_projected = false AND t.refunded = false
       GROUP BY t.budget;
  ELSE
    RETURN QUERY
      SELECT v_level, NULL::text, COALESCE(SUM(t.amount), 0)::numeric
        FROM public.transactions t
       WHERE t.user_id = v_partner AND to_char(t.date, 'YYYY-MM') = p_month AND t.is_projected = false AND t.refunded = false;
  END IF;
END;
$function$;

CREATE FUNCTION public.partner_monthly_income()
 RETURNS numeric
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.monthly_income FROM public.settings s WHERE s.user_id = public.linked_partner_id();
$function$;

CREATE FUNCTION public.partner_share_level()
 RETURNS text
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT s.share_level FROM public.settings s WHERE s.user_id = public.linked_partner_id();
$function$;

-- Run nightly by the cron job at the bottom of this file, never by a client.
CREATE FUNCTION public.refresh_community_rules()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  MIN_HOUSEHOLDS constant integer := 5;
  MIN_AGREEMENT  constant numeric := 0.7;
  EXCLUDED_CATEGORIES constant public."Budgets"[] := ARRAY[]::public."Budgets"[];
BEGIN
  DELETE FROM public.community_rules;

  WITH households AS (
    SELECT DISTINCT
      COALESCE(LEAST(c.user_id, s.partner_id), c.user_id) AS household_key,
      c.match_key,
      c.category_id
    FROM public.rule_contributions c
    LEFT JOIN public.settings s ON s.user_id = c.user_id
    WHERE c.match_key <> ''
      AND c.category_id <> ALL (EXCLUDED_CATEGORIES)
  ),
  tally AS (
    SELECT
      match_key,
      category_id,
      COUNT(*) AS votes,
      SUM(COUNT(*)) OVER (PARTITION BY match_key) AS total_votes,
      ROW_NUMBER() OVER (PARTITION BY match_key ORDER BY COUNT(*) DESC, category_id) AS rank
    FROM households
    GROUP BY match_key, category_id
  )
  INSERT INTO public.community_rules (match_key, category_id, household_count, agreement, updated_at)
  SELECT
    match_key,
    category_id,
    total_votes::integer,
    ROUND(votes::numeric / total_votes, 3),
    now()
  FROM tally
  WHERE rank = 1
    AND total_votes >= MIN_HOUSEHOLDS
    AND votes::numeric / total_votes >= MIN_AGREEMENT;
END $function$;

-- The trial is judged on the database's clock, not the phone's
-- (lib/serverClock.ts).
CREATE FUNCTION public.server_now()
 RETURNS timestamp with time zone
 LANGUAGE sql
 STABLE
 SET search_path TO 'public', 'pg_temp'
AS $function$
  SELECT now();
$function$;

CREATE FUNCTION public.set_household_budget_mode(p_mode text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE v_me uuid := auth.uid(); v_partner uuid;
BEGIN
  IF v_me IS NULL THEN RAISE EXCEPTION 'Not authenticated'; END IF;
  IF p_mode NOT IN ('separate', 'combined') THEN RAISE EXCEPTION 'Unknown budget mode'; END IF;
  v_partner := public.linked_partner_id();
  UPDATE public.settings s SET budget_mode = p_mode WHERE s.user_id = v_me;
  IF v_partner IS NOT NULL THEN
    UPDATE public.settings s SET budget_mode = p_mode WHERE s.user_id = v_partner;
  END IF;
END;
$function$;

CREATE FUNCTION public.unlink_partner()
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  v_me    uuid := auth.uid();
  v_other uuid;
BEGIN
  IF v_me IS NULL THEN
    RAISE EXCEPTION 'Not authenticated';
  END IF;

  SELECT s.partner_id INTO v_other
    FROM public.settings s WHERE s.user_id = v_me;

  UPDATE public.settings s
     SET partner_id = NULL, partner_name = NULL, partner_email = NULL
   WHERE s.user_id = v_me;

  -- Only clear the other row if it actually points back at us, so this can
  -- never be used to detach two unrelated accounts.
  IF v_other IS NOT NULL THEN
    UPDATE public.settings s
       SET partner_id = NULL, partner_name = NULL, partner_email = NULL
     WHERE s.user_id = v_other
       AND s.partner_id = v_me;
  END IF;
END;
$function$;

-- Present on live but attached to no table: nothing keeps updated_at current
-- automatically. Kept so a fresh database matches.
CREATE FUNCTION public.update_updated_at_column()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$function$;


-- ============================================================
-- ROW LEVEL SECURITY
-- ============================================================
-- Every table has it on. A table with RLS on and no policy for an action
-- refuses that action outright, which is how banks and community_rules stay
-- read-only to clients, and why no one can delete their own settings row.

ALTER TABLE public.banks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.community_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rule_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Signed-in users can read the bank list" ON public.banks
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users can insert own budgets" ON public.budgets
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((user_uuid = auth.uid()));

CREATE POLICY "Users can update own budgets" ON public.budgets
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((user_uuid = auth.uid()))
  WITH CHECK ((user_uuid = auth.uid()));

CREATE POLICY "Users can view own budgets" ON public.budgets
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_uuid = auth.uid()));

-- A partner's rows are visible only through linked_partner_id(), which
-- requires BOTH settings rows to point at each other.
CREATE POLICY "Users can view partner budgets" ON public.budgets
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((user_uuid = public.linked_partner_id()));

CREATE POLICY "Anyone can read community rules" ON public.community_rules
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (true);

CREATE POLICY "Users can delete own notification rules" ON public.notification_rules
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own notification rules" ON public.notification_rules
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own notification rules" ON public.notification_rules
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own notification rules" ON public.notification_rules
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can delete own overrides" ON public.overrides
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can update own vendor overrides" ON public.overrides
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can upsert own vendor overrides" ON public.overrides
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own vendor overrides" ON public.overrides
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can view partner overrides" ON public.overrides
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = public.linked_partner_id()) AND (public.partner_share_level() = 'transactions'::text)));

CREATE POLICY "Households can amend their contribution" ON public.rule_contributions
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Households can contribute" ON public.rule_contributions
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Households can see their own contributions" ON public.rule_contributions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Households can withdraw" ON public.rule_contributions
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own settings" ON public.settings
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own settings" ON public.settings
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id))
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can view own settings" ON public.settings
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can delete own transactions" ON public.transactions
  AS PERMISSIVE FOR DELETE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can insert own transactions" ON public.transactions
  AS PERMISSIVE FOR INSERT TO authenticated
  WITH CHECK ((auth.uid() = user_id));

CREATE POLICY "Users can update own transactions" ON public.transactions
  AS PERMISSIVE FOR UPDATE TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can view own transactions" ON public.transactions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING ((auth.uid() = user_id));

CREATE POLICY "Users can view partner transactions" ON public.transactions
  AS PERMISSIVE FOR SELECT TO authenticated
  USING (((user_id = public.linked_partner_id()) AND (public.partner_share_level() = 'transactions'::text)));

CREATE POLICY service_delete ON public.transactions
  AS PERMISSIVE FOR DELETE TO service_role
  USING (true);


-- ============================================================
-- SIGN-UP TRIGGER
-- ============================================================

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();


-- ============================================================
-- GRANTS
-- ============================================================
-- A Supabase project hands every new table and function to anon,
-- authenticated and service_role by default. Everything is taken back first
-- and then granted by name, so the result does not depend on those defaults.
-- anon (signed out) gets no table at all.

REVOKE ALL ON public.banks FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.budgets FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.community_rules FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.notification_rules FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.overrides FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.rule_contributions FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.settings FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON public.transactions FROM PUBLIC, anon, authenticated, service_role;

GRANT ALL ON public.banks TO authenticated, service_role;
GRANT ALL ON public.budgets TO authenticated, service_role;
GRANT ALL ON public.community_rules TO authenticated, service_role;
GRANT ALL ON public.notification_rules TO authenticated, service_role;
GRANT ALL ON public.overrides TO authenticated, service_role;
GRANT ALL ON public.rule_contributions TO authenticated, service_role;
GRANT ALL ON public.transactions TO authenticated, service_role;

-- settings is the paywall: trial dates, subscription status, the tester flag
-- and the partner link live here. A client may UPDATE only its ordinary
-- preferences (2026_09_security_review.sql) and CREATE its row with only the
-- four columns the app's own fallback sends (2026_09_settings_insert_columns.sql).
-- Everything else is written by the sign-up trigger and the SECURITY DEFINER
-- functions above, which run as the table owner.
GRANT ALL ON public.settings TO service_role;
GRANT SELECT, DELETE, REFERENCES, TRIGGER, TRUNCATE ON public.settings TO authenticated;
GRANT UPDATE (app_notifications_enabled, auto_accept_known_vendors, budgeting_solo, community_rules_contribute, community_rules_enabled, email, haptics_enabled, leisure_buffer_enabled, monthly_income, name, rollover_enabled, share_level, show_savings_insight, smart_notifications_enabled, theme_selected) ON public.settings TO authenticated;
GRANT INSERT (user_id, name, email, monthly_income) ON public.settings TO authenticated;

REVOKE ALL ON FUNCTION public.delete_own_account() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.generate_link_code() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.generate_transaction_hash(p_amount numeric, p_vendor text, p_date date) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.link_partner_by_code(p_code text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.linked_partner_id() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.match_vendor(p_user_id uuid, p_raw_vendor text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.partner_month_summary(p_month text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.partner_monthly_income() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.partner_share_level() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.refresh_community_rules() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.server_now() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.set_household_budget_mode(p_mode text) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.unlink_partner() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_updated_at_column() FROM PUBLIC, anon, authenticated, service_role;

-- Signed-in only.
GRANT EXECUTE ON FUNCTION public.delete_own_account() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_link_code() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.link_partner_by_code(p_code text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.linked_partner_id() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.partner_month_summary(p_month text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.partner_monthly_income() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.partner_share_level() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_household_budget_mode(p_mode text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.unlink_partner() TO authenticated, service_role;

-- Server only.
GRANT EXECUTE ON FUNCTION public.handle_new_user() TO service_role;
GRANT EXECUTE ON FUNCTION public.refresh_community_rules() TO service_role;

-- Open to everyone, as on live. None of these is SECURITY DEFINER, so none
-- of them can read past RLS.
GRANT EXECUTE ON FUNCTION public.server_now() TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.generate_transaction_hash(p_amount numeric, p_vendor text, p_date date) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.match_vendor(p_user_id uuid, p_raw_vendor text) TO PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.update_updated_at_column() TO PUBLIC, anon, authenticated, service_role;


-- ============================================================
-- NIGHTLY JOB
-- ============================================================
-- Rebuilds the community rule pool from what households have contributed.

SELECT cron.schedule('refresh-community-rules', '17 4 * * *', 'SELECT public.refresh_community_rules()');

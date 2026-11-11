# Database setup

One page for the three things anyone ever does with Covault's database: start
a new one, bring an existing one up to date, and change it. Everything here was
checked against the live project on **2026-10-03** through the read-only
Supabase connection, not inferred from the migration files.

## Start a new database

1. Create a Supabase project. Live runs Postgres 17.6, and `schema.sql` was
   tested on that version. Check **Settings → Infrastructure** if the new
   project shows something older.
2. Open **SQL Editor → New query**, paste the whole of `supabase/schema.sql`,
   and run it. It refuses to run if the Covault tables already exist, so
   running it on the wrong project by mistake does nothing.
3. Do the sign-in setup in the README (**Auth configuration**) and put the
   project URL and public key in `.env`.

That is the whole path. `schema.sql` creates every table, constraint, index,
function, access rule and grant the app needs, the sign-up trigger that gives
each new account its settings row, and the nightly job that rebuilds the
community rule pool. None of the files in `supabase/migrations/` is needed for
a new database.

If step 2 stops at `CREATE EXTENSION pg_cron`, switch on **pg_cron** under
**Database → Extensions** and run the file again.

### How this was verified

- `schema.sql` was generated from the live project's own definitions, then
  built into an empty copy of Supabase's Postgres 17.6 (`scripts/verify-schema.sh`).
- `scripts/schema-fingerprint.sql` was run against that copy and against live.
  Columns, constraints, indexes, access rules, function bodies, function
  permissions, the trigger, comments and the nightly job all match exactly.
- The settings INSERT grant was the one difference at first. Live matched in
  full once that fix was applied; see **The settings insert fix** below.
- `scripts/rls-check.sql` then signed in as three test accounts on the copy.
  Strangers see only themselves. A one-sided partner link reads nothing, and a
  mutual one shares at the level the partner chose. Nobody can write into
  another account. The trial, subscription, tester and partner fields cannot
  be raised by the app.

**Not verified:** running `schema.sql` on a real new Supabase project, and
signing a real account in to one. The Docker copy has Supabase's database
but not its sign-in or API servers.

## Bring an existing database up to date

There is one existing database, the household's live project. It is fully
up to date as of 2026-10-03.

### The settings insert fix

`supabase/migrations/2026_09_settings_insert_columns.sql` was the last
outstanding migration, and it was applied on 2026-10-03. Before it, a
signed-in account whose settings row was missing could create the row already
marked as subscribed or as a tester. No account was exposed: every account
gets its row at sign-up, nobody can delete their own, and all three had
theirs.

Before it was run, an independent review (GPT-6.1 Sol) and the checks above
confirmed that the app's writes were unaffected. Live had no other insert
route, and the two statements were wrapped in one transaction so a failure
could not leave it half-applied. Afterwards the read-only connection confirmed
that a client can insert exactly the four ordinary columns. The undo is
noted at the top of the file.

Not checked: whether any existing row was already marked subscribed or as a
tester before the fix. That needs reading account data.

### Checking any database

Supabase keeps a log of migrations applied through its tools: **Database →
Migrations**, or `list_migrations` on the read-only connection. Every change
since 2026-08-20 is in it. Compare that log with the table below. For a
complete answer, run `scripts/schema-fingerprint.sql` in the SQL editor and
compare it with `scripts/verify-schema.sh`. On an up-to-date database every
line matches.

| Migration file | Name in live's log | On live |
|---|---|---|
| `2026_add_auto_filed_column.sql` | `add_auto_filed_column` | applied 2026-08-20 |
| `2026_add_yearly_recurrence.sql` | `add_yearly_recurrence` | applied 2026-09-04 |
| `2026_09_collaborative_rules.sql` | `collaborative_rules` (+ `_revoke_client_execute`, `_schedule_tally`) | applied 2026-09-04 |
| `2026_09_harden_definer_functions.sql` | `harden_definer_functions_and_rpc_grants` | applied 2026-09-07 |
| `2026_09_delete_own_account.sql` | `delete_own_account` | applied 2026-09-09 |
| `2026_09_trial_and_tester_flag.sql` | `trial_and_tester_flag` | applied 2026-09-09 |
| `2026_09_add_shopping_personal_travel_budgets.sql` | `add_shopping_personal_travel_budgets` | applied 2026-09-12 |
| `2026_09_skip_rule_recent_uses.sql` | `skip_rule_recent_uses` | applied 2026-09-13 |
| `2026_09_skip_rule_source_text.sql` | `skip_rule_source_text` | applied 2026-09-13 |
| `2026_09_server_clock_for_trial.sql` | `server_clock_for_trial` | applied 2026-09-13 |
| `2026_09_drop_email_linking.sql` | `drop_unilateral_email_linking` | applied 2026-09-13 |
| `2026_09_household_sharing.sql` | `household_sharing_modes`, `household_partner_reads` | applied 2026-09-13 |
| `2026_09_security_review.sql` | four `security_review_*` entries | applied 2026-09-14 |
| `2026_09_settings_insert_columns.sql` | — (run in the SQL editor) | applied 2026-10-03 |
| `2026_11_partner_summary_skips_refunded.sql` | — (run in the SQL editor) | **not applied yet** — until it is, a partner's refunded purchase still counts in the total their partner's phone is given |

Everything else in `supabase/migrations/` was run by hand in the SQL editor
before the log existed, and live already reflects it. The four files marked
SUPERSEDED, `2026_08_01_sync_schema_to_app.sql`, `consolidate_schema.sql`,
`fix_all_rls_policies_and_constraints.sql` and the older column additions are
history. Do not run them again: some drop tables or replace functions with
older versions. `2026_verify_rls.sql` is a check, not a change.

## Change the database

1. Write a new file in `supabase/migrations/`. Say at the top what it is for
   and whether it has been applied.
2. Apply it to live. Either the owner runs it in the SQL editor, or it is
   applied through Supabase's migration tool so it lands in the log. The
   read-only connection cannot apply anything, by design.
3. Make the same change in `supabase/schema.sql`, so a new database gets it
   too.
4. Run `scripts/verify-schema.sh`, then run `scripts/schema-fingerprint.sql`
   on live, and compare. They must match except for differences listed on this
   page. A mismatch means `schema.sql` and live have drifted, which is how the
   previous `schema.sql` ended up describing a database without household
   sharing.
5. Update the table above.

## Loose ends found on 2026-10-03

None of these is urgent. Each would need its own migration.

- **Three leftover functions nothing calls:** `generate_transaction_hash`,
  `match_vendor` and `update_updated_at_column`. All three are open to
  signed-out callers. None runs with elevated rights, so none can read past
  the access rules, but they are surface for no benefit.
  `2026_cleanup_dead_rpcs.sql` meant to drop the first one and never did,
  because it named the arguments in a different order than the real function
  has.
- **`updated_at` is not maintained by the database.** The trigger function
  exists, but no table uses it. Any `updated_at` the app shows is whatever the
  app itself last wrote.
- **Signed-in accounts hold broad table rights,** including TRUNCATE. The
  access rules decide what each request can actually touch, and the app's API
  cannot issue a TRUNCATE, so this is tidiness rather than exposure.

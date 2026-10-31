# Go-live checklist: accounts, sync and Family

What the owner does, in order, before turning `ENABLE_ACCOUNTS`, `ENABLE_SYNC` and `ENABLE_SPACES` on in production. Tick every box; stop at the first one that fails. Background: spec §17–§23 (`docs/free-tier-spec.md`), `docs/db.md` §8–§9 and the ADRs in `docs/adr/`.

Nothing here changes the app's behaviour while the flags are off: with all three off the app is local-only, exactly as today.

## 1. Database migrations (production Supabase)

- [ ] Apply the migrations in order with the Supabase CLI (`supabase db push`) or the SQL editor:
  1. `supabase/migrations/20261023000000_sync_server.sql` (accounts, plans and the sync server, spec §18)
  2. `supabase/migrations/20261029000000_family_spaces.sql` (Family spaces, spec §21; run it again whenever the first one is re-run)
  3. any later migration in `supabase/migrations/`, by file name order
- [ ] Run `supabase/tests/sync_server_checks.sql` in the SQL editor: it finishes without an exception.
- [ ] Run `supabase/tests/family_spaces_checks.sql`: it finishes without an exception.
- [ ] Row Level Security is enabled on every new table (`sync_records`, `space_records` and the other space tables) and the functions are granted to `authenticated` only (the check scripts cover this; look at the Database → Tables view once).

## 2. Google OAuth

- [ ] Google Cloud console: the OAuth consent screen is **published** (not "Testing"), with the app name, support email and logo.
- [ ] The consent screen links the production privacy policy (`https://<production domain>/privacy`) and terms (`https://<production domain>/terms`); both pages open while signed out.
- [ ] Authorised redirect URIs include the Supabase callback; Supabase → Authentication → URL configuration has the production Site URL and the redirect URLs `https://<production domain>/auth/callback` (plus the Preview pattern if Previews sign in).
- [ ] Sign in once on production with a test account and land back on the app.

## 3. Legal texts

- [ ] `src/lib/legal.ts`: `LEGAL_OPERATOR_NAME` and `LEGAL_CONTACT_EMAIL` are the real operator name and a monitored contact address (no `TODO(owner)` left).
- [ ] `/privacy` and `/terms` reviewed in both languages (accounts, encrypted sync, the Family space: who sees what); `LEGAL_LAST_UPDATED` updated if the text changed.

## 4. Plans and free access

- [ ] The `plans` table: each plan's `features` (`sync`, `max_devices`, `max_records`, `max_bytes`, `shared_spaces`, `max_members`, `max_space_records`, `max_space_bytes`) reviewed and as intended.
- [ ] `app_config.sync_free_for_all = true` (beta: every signed-in account gets the `beta` plan).

## 5. Vercel environment variables and enable order

The flags are build-time Vite variables, so each change needs a redeploy. Set them per environment (Production, Preview, Development) in Vercel → Settings → Environment Variables. Enable them one at a time, in this order, with one deploy and a smoke test between steps:

- [ ] `VITE_ENABLE_ACCOUNTS=true`, redeploy; check sign-in, sign-out and Settings → Account.
- [ ] `VITE_ENABLE_SYNC=true`, redeploy; check turning sync on, a second device restoring from the cloud and Settings → Sync.
- [ ] `VITE_ENABLE_SPACES=true`, redeploy; check creating a Family, inviting, joining and the space switcher.
- [ ] Supabase URL and anon key env vars are set for the same environments.

**Rollback:** set the last flag you turned on back to `false` (or remove it) and redeploy. Turn them off in the reverse order (spaces, then sync, then accounts). Local data on every device is untouched; cloud data stays on the server and is used again when the flag comes back. Never delete tables or run migrations down as a rollback.

## 6. Two-device and two-account smoke test

Run on a Vercel Preview with all three flags on, with a phone and a laptop, and two Google accounts.

Sync (run 3):

- [ ] Phone and laptop with the same account: turn on sync on the laptop, then restore on the phone with the password.
- [ ] Add an expense offline on the phone and edit another on the laptop; online again, both show both changes within about a minute.
- [ ] Change the password on the laptop: the phone shows the toast and its next unlock needs the new password.
- [ ] Remove the phone from the laptop's devices list: the phone shows "removed".
- [ ] Delete cloud data: the Supabase tables are empty for that user and local data is still there on both devices.
- [ ] In the table editor, `sync_records` holds only opaque keys and ciphertext.

Family sharing (run C):

- [ ] Account 1 creates a Family and shares the invite link to account 2's phone.
- [ ] Account 2 opens the link, unlocks or creates a vault, signs in and asks to join; both compare the safety code, account 1 approves.
- [ ] Settings → Family shows the same member list and entry count on both phones.
- [ ] Account 1 removes account 2: account 2's phone shows the read-only copy. (Re-invite account 2 for the next steps.)
- [ ] In the table editor, `space_records` contains only opaque keys and ciphertext.

Family in daily use (run D):

- [ ] On the phone, switch to Family: the title, Quick Add and drawer clearly say Family.
- [ ] Add an expense paid by the other member: on the other phone it appears with their chip, and the dashboard card splits the month by member.
- [ ] Move two personal expenses to Family: they disappear from Personal and appear for both members.
- [ ] Set "Open the app in: Family", close and reopen the app: it opens in Family.
- [ ] Light and dark themes and a narrow phone: the switcher, chips and bulk bar fit and nothing overflows.

## 7. Backups and monitoring

- [ ] Supabase backups enabled for the production project (daily backups, and point-in-time recovery if the plan offers it); a restore has been tried once on a copy.
- [ ] Watch weekly at first: the row counts and table sizes of `sync_records` and `space_records` (Database → Tables, or `pg_total_relation_size`), against the plan limits.
- [ ] Watch the function error rates in Supabase logs (Postgres and API logs, `MINIMA:` error codes) and auth errors (Authentication → Logs).
- [ ] Watch Vercel function errors and the client error reports after each enable step.

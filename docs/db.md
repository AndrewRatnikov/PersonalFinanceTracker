# Database Schema: MinimaSpend

This document contains the full SQL schema for **MinimaSpend**, including tables, Row Level Security (RLS) policies, and triggers. Execute this SQL in the Supabase Dashboard SQL Editor.

## 1. Categories Table

Allows users to define their own labels for expenses.

```sql
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  name text not null,
  icon text,
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.categories enable row level security;

-- Policies
create policy "Users can view their own categories"
  on public.categories for select
  using (auth.uid() = user_id);

create policy "Users can insert their own categories"
  on public.categories for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own categories"
  on public.categories for update
  using (auth.uid() = user_id);

create policy "Users can delete their own categories"
  on public.categories for delete
  using (auth.uid() = user_id);
```

## 2. Expenses Table

Stores individual spending entries.

```sql
create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  amount numeric not null,
  currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
  description text,
  is_recurring boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.expenses enable row level security;

-- Policies
create policy "Users can view their own expenses"
  on public.expenses for select
  using (auth.uid() = user_id);

create policy "Users can insert their own expenses"
  on public.expenses for insert
  with check (auth.uid() = user_id);

create policy "Users can update their own expenses"
  on public.expenses for update
  using (auth.uid() = user_id);

create policy "Users can delete their own expenses"
  on public.expenses for delete
  using (auth.uid() = user_id);
```

## 3. Automation & Triggers

### Updated At Timestamp

This function and trigger ensure that the `updated_at` column is automatically updated on every change.

```sql
-- Function to handle updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- Trigger for expenses
create trigger set_expenses_updated_at
  before update on public.expenses
  for each row
  execute function public.handle_updated_at();
```

## 4. Default Categories Provisioning (Reference)

On first login, the application should auto-provision a set of default categories if they don't exist:

- Food
- Transport
- Rent
- Coffee
- Server Costs
- Entertainment

## 5. Budgets Table

Stores per-category monthly spending limits set by the user.

```sql
create table public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
  category_id uuid not null references public.categories(id) on delete cascade,
  monthly_limit numeric not null check (monthly_limit > 0),
  currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category_id)
);

-- Enable RLS
alter table public.budgets enable row level security;

-- Policies
create policy "Users can view their own budgets" on public.budgets for select using (auth.uid() = user_id);
create policy "Users can insert their own budgets" on public.budgets for insert with check (auth.uid() = user_id);
create policy "Users can update their own budgets" on public.budgets for update using (auth.uid() = user_id);
create policy "Users can delete their own budgets" on public.budgets for delete using (auth.uid() = user_id);

-- Trigger
create trigger set_budgets_updated_at
  before update on public.budgets
  for each row execute function public.handle_updated_at();
```

## 6. Income Table

```sql
  create table public.income (
    id uuid primary key default gen_random_uuid(),
    user_id uuid not null references auth.users(id) on delete cascade default auth.uid(),
    source text not null,
    amount numeric not null,
    currency text not null check (currency in ('UAH', 'USD', 'EUR')) default 'UAH',
    description text,
    created_at timestamptz not null default now()
  );
  alter table public.income enable row level security;
  create policy "Users can view their own income" on public.income for select using (auth.uid() = user_id);
  create policy "Users can insert their own income" on public.income for insert with check (auth.uid() = user_id);
  create policy "Users can update their own income" on public.income for update using (auth.uid() = user_id);
  create policy "Users can delete their own income" on public.income for delete using (auth.uid() = user_id);
```

## 7. Account Deletion RPC

**Manual step:** run this SQL in the Supabase Dashboard SQL Editor. It enables in-app account deletion (see `src/lib/account.ts`) without requiring the service-role key on the client: the authenticated user calls the `delete_own_account()` RPC, which runs with elevated (`SECURITY DEFINER`) privileges but hardcodes `auth.uid()` as the deletion target, so a caller can only ever delete their own row. Deleting the `auth.users` row cascades (via the `on delete cascade` foreign keys above) to all of that user's `categories`, `expenses`, `budgets`, and `income` rows.

```sql
create or replace function public.delete_own_account()
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from auth.users where id = auth.uid();
end;
$$;

grant execute on function public.delete_own_account() to authenticated;
```

An earlier version of this used a `public.profiles` table with an insert/delete RLS dance plus a delete-trigger as an indirect way to delete `auth.users` from the client. That approach hit a still-unexplained RLS failure on this project (see git history) and was replaced with this direct RPC, which is simpler and is the standard Supabase pattern for self-service account deletion. If `public.profiles` and its policies/trigger still exist in your project from the earlier approach, they can be dropped:

```sql
drop trigger if exists on_profile_deleted on public.profiles;
drop function if exists public.handle_user_delete();
drop table if exists public.profiles;
```

## 8. Sync server (2026-10-23)

The server side of encrypted sync: plans, the beta switch, entitlements, vaults, devices and encrypted sync records. The client never reads plaintext data from here and nothing syncs yet (run 3 adds the sync engine). The SQL lives in `supabase/migrations/20261023000000_sync_server.sql`; **that file is authoritative**, the copy at the end of this section is for reference. It is idempotent: safe to run again. Re-running it resets the `plans` rows to the seeds (an upsert, so after payments go live `sync.is_public` would go back to `false` and must be set again); `app_config` is seeded only once, so a re-run never switches the beta back on. It drops nothing and does not touch the legacy tables or `delete_own_account()`.

**Re-running this migration requires re-running the §9 one** (`supabase/migrations/20261029000000_family_spaces.sql`) afterwards: it resets the plan features, `effective_plan()`, `has_feature()` and `get_sync_status()` to the run 2 versions, which drops the Family plan keys and the `space` key of the status until §9 runs again.

### Tables

| Table | Purpose | Client access |
| --- | --- | --- |
| `plans` | `id`, `name`, `features` (JSON: `sync`, `max_devices`, `max_records`, `max_bytes`), `is_public`. Seeds: `free` (no sync), `beta` (5 devices, 100,000 records, 100 MB), `sync` (10 devices, 200,000 records, 200 MB, not public until payments). **All limits live here, never in code.** | `select` of public plans |
| `app_config` | `key`, `value` (JSON). `sync_free_for_all` = `true` (the beta switch). | none (functions only) |
| `entitlements` | One row per user: `plan_id`, `status` (`active` / `past_due` / `canceled`), `source` (`beta` / `manual` / `payment`), `current_period_end`, `beta_joined_at`. | `select` of the own row; no writes |
| `vaults` | One row per user: `vault_id`, a copy of the vault header (≤ 8 KB), `header_rev`, `last_seq`, `record_count`, `total_bytes`. | `select` of the own row |
| `devices` | `(user_id, device_id)`, `label` (1–60 chars), `created_at`, `last_seen_at`, `removed_at`. | `select` of the own rows |
| `sync_records` | `(user_id, record_key)`, `vault_id`, `ciphertext`, `iv`, `enc_v`, `updated_at_ms`, `device_id`, `seq`, `size`, `server_updated_at`; index `(user_id, seq)`. | none (functions only) |

RLS is enabled on all six tables. Every `user_id` references `auth.users(id) on delete cascade`, so `delete_own_account()` (unchanged, §7) also removes the user's entitlement, vault, devices and records. Supabase grants everything on new tables and functions to `anon` and `authenticated` by default, so the migration revokes all of it first.

### Functions

Every function is `SECURITY DEFINER` with `set search_path = ''`, uses only schema-qualified names, takes the user from `auth.uid()` (never from a parameter), raises `MINIMA:not_signed_in` when there is no user, and is executable by `authenticated` only (revoked from `public` and `anon`).

| Function | Needs sync | Returns |
| --- | --- | --- |
| `effective_plan()` | no | the plan id |
| `has_feature(p_feature)` | no | boolean, from the effective plan's `features` |
| `get_sync_status()` | no | `{ plan_id, has_sync, free_for_all, granted_by, beta_joined_at, entitlement_status, current_period_end, limits, vault, devices_count }` |
| `register_device(p_device_id, p_label)` | yes | the device |
| `list_devices()` | no | the devices, removed ones included |
| `rename_device(p_device_id, p_label)` / `remove_device(p_device_id)` | no | the device |
| `create_vault(p_device_id, p_vault_id, p_header)` | yes | `{ vault_id, header_rev }` |
| `get_vault()` | no | `{ vault_id, header, header_rev }` or null |
| `update_vault_header(p_device_id, p_vault_id, p_header, p_expected_rev)` | yes | `{ vault_id, header_rev }` |
| `push_records(p_device_id, p_vault_id, p_records)` | yes | `{ results: [{ record_key, status: 'accepted', seq } \| { record_key, status: 'stale', current }], last_seq }` |
| `pull_records(p_device_id, p_vault_id, p_since, p_limit = 500)` | yes | `{ records, has_more, last_seq, vault_id }` |
| `delete_cloud_data()` | no | `{ deleted_records }` |

- **Devices.** The first successful `register_device` creates the entitlements row (`free`, `active`, source `beta`, `beta_joined_at = now()` while the beta switch is on) for later grandfathering. A known device only gets `last_seen_at` refreshed (a renamed label is kept); a removed device raises `device_removed` on register, push and pull; a new device beyond `max_devices` non-removed devices raises `device_limit`.
- **Push.** The user's vault row is locked (`for update`), so `seq` order is commit order per user. At most 500 records and 1,048,576 ciphertext characters per call (`batch_too_large`); every element is validated first (`invalid_input`, also for a repeated `record_key`). A record is written only when it is new or its `updated_at_ms` is strictly newer, and then gets `seq = ++last_seq`; otherwise it is `stale` and the stored row comes back. **An equal `updated_at_ms` is stale: the server copy wins exact ties.** Going over `max_records` or `max_bytes` raises `quota_exceeded` and rolls the whole batch back.
- **Pull.** Rows with `seq > p_since`, in `seq` order, at most `p_limit` (1–1000), with `has_more`. After `delete_cloud_data` a new vault starts again at seq 1, so a client must reset its cursor when `last_seq` is below it or the `vault_id` changed.

### Permission model

- `effective_plan()`: an entitlement whose plan is not `free` and which is `active` (no `current_period_end`, or one in the future) or `past_due` before its `current_period_end` gives its plan. Otherwise the plan is `beta` while `app_config.sync_free_for_all` is `true`, else `free`. `free` is the floor plan: an entitlement to `free` never overrides the beta switch (the row `register_device` creates is one).
- `has_feature(p_feature)` reads `features -> p_feature = true` of that plan. **It is the only place a permission is decided**; every sync function calls it, and the limits are read from the same plan row.
- `get_sync_status().granted_by` is `entitlement` (a valid entitlement decided the plan), `free_for_all` (the beta switch did) or `default` (neither). The app shows plan names from its catalog by plan id and never compares plan ids.

### Error codes

Raised as `MINIMA:<code>` (the whole message; details, if any, in `DETAIL`): `not_signed_in`, `sync_not_included`, `device_not_registered`, `device_removed`, `device_limit`, `no_vault`, `vault_exists`, `vault_mismatch`, `header_conflict`, `quota_exceeded`, `batch_too_large`, `invalid_input`. The client (`src/lib/cloud/api.ts`) maps them to `CloudError` codes, plus `network` and `unknown`.

### Without sync

When a user has no sync (the beta switch off and no valid entitlement), their data is kept and **paused**: `register_device`, `create_vault`, `update_vault_header`, `push_records` and `pull_records` raise `sync_not_included`, while `get_vault`, `list_devices` / `rename_device` / `remove_device` and `delete_cloud_data` still work, so a user can always reach their header and delete their data.

### Switching to payments later (do NOT do it now)

1. Turn the beta switch off:

   ```sql
   update public.app_config set value = 'false' where key = 'sync_free_for_all';
   ```

2. Optionally grandfather the beta users until a date (one statement; it leaves paying users alone):

   ```sql
   update public.entitlements
      set plan_id = 'beta', status = 'active', current_period_end = '<date>', updated_at = now()
    where beta_joined_at is not null and source <> 'payment';
   ```

3. The payment webhook (run 4) upserts `entitlements` with the service role (`source = 'payment'`). The service-role key never goes into the client or the repo.
4. Show the paid plan: `update public.plans set is_public = true where id = 'sync';`

No schema or client change is needed.

### Manual steps (in this order)

1. In the Supabase SQL editor, run `supabase/migrations/20261023000000_sync_server.sql`, then `supabase/tests/sync_server_checks.sql`. The checks script runs in one transaction that is rolled back, raises `CHECK FAILED: <name>` on any failure and must finish with the notice `sync_server_checks: all checks passed`.
2. Legacy tables: count what is left in the pre-local-first tables (§1–§6):

   ```sql
   select 'categories' as table_name, count(*) from public.categories
   union all select 'expenses', count(*) from public.expenses
   union all select 'budgets', count(*) from public.budgets
   union all select 'income', count(*) from public.income;
   ```

   Dropping them is the owner's decision and is not done by the migration. When you decide to, uncomment and run:

   ```sql
   -- drop table if exists public.income;
   -- drop table if exists public.budgets;
   -- drop table if exists public.expenses;
   -- drop table if exists public.categories;
   ```

3. Google OAuth consent screen: add the `/privacy` and `/terms` URLs of the site. Supabase Auth → URL configuration: add the Vercel preview domain for `/auth/callback`.
4. Set `VITE_ENABLE_ACCOUNTS=true` on the Vercel **Preview** environment only, and test sign-in, the redirect back to Settings → Account and the Plan card (Beta) there.

`delete_own_account()` keeps the `PUBLIC` execute grant it got when it was created by hand (§7); with no signed-in user `auth.uid()` is null and it deletes nothing.

### Migration SQL (copy; the file is authoritative)

```sql
-- MinimaSpend encrypted sync server (run 2): plans, the beta switch,
-- entitlements, vaults, devices and encrypted sync records, plus the
-- SECURITY DEFINER functions the client calls. See docs/db.md section 8.
--
-- Safe to run more than once: tables and indexes use IF NOT EXISTS, functions
-- are replaced, policies are dropped and created again, plan rows are upserted
-- (a re-run resets them to these seeds) and app_config is seeded only once (a
-- re-run never switches the beta back on).
--
-- Rules every function below follows:
--   * SECURITY DEFINER with an empty search path, schema-qualified names only;
--   * the caller is always auth.uid(), never a parameter, and a missing user
--     raises MINIMA:not_signed_in first;
--   * EXECUTE is granted to authenticated only (revoked from public and anon);
--   * errors are raised with the message exactly MINIMA:<code>.
-- public.has_feature() is the only place a permission is decided; limits are
-- read from public.plans.features of public.effective_plan().
--
-- The server never sees amounts, categories, record types or ids: a record is
-- an opaque HMAC record_key plus an AES-GCM ciphertext (src/lib/cloud/types.ts).
-- updated_at_ms is the one value kept in the clear.

-- ── Tables ──────────────────────────────────────────────────────────────────

create table if not exists public.plans (
  id text primary key,
  name text not null,
  features jsonb not null,
  is_public boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists public.app_config (
  key text primary key,
  value jsonb not null
);

create table if not exists public.entitlements (
  user_id uuid primary key references auth.users (id) on delete cascade,
  plan_id text not null references public.plans (id),
  status text not null check (status in ('active', 'past_due', 'canceled')),
  source text not null check (source in ('beta', 'manual', 'payment')),
  current_period_end timestamptz null,
  beta_joined_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.vaults (
  user_id uuid primary key references auth.users (id) on delete cascade,
  vault_id text not null,
  header jsonb not null check (octet_length(header::text) <= 8192),
  header_rev int not null default 1,
  last_seq bigint not null default 0,
  record_count int not null default 0,
  total_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.devices (
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id uuid not null,
  label text not null check (char_length(label) between 1 and 60),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  removed_at timestamptz null,
  primary key (user_id, device_id)
);

create table if not exists public.sync_records (
  user_id uuid not null references auth.users (id) on delete cascade,
  record_key text not null check (record_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  vault_id text not null,
  ciphertext text not null check (char_length(ciphertext) between 1 and 65536),
  iv text not null check (char_length(iv) between 1 and 32),
  enc_v smallint not null,
  updated_at_ms bigint not null,
  device_id uuid not null,
  seq bigint not null,
  size int not null,
  server_updated_at timestamptz not null default now(),
  primary key (user_id, record_key)
);

create index if not exists sync_records_user_seq_idx
  on public.sync_records (user_id, seq);

alter table public.plans enable row level security;
alter table public.app_config enable row level security;
alter table public.entitlements enable row level security;
alter table public.vaults enable row level security;
alter table public.devices enable row level security;
alter table public.sync_records enable row level security;

-- ── Seeds ───────────────────────────────────────────────────────────────────

insert into public.plans (id, name, features, is_public)
values
  ('free', 'Free', '{"sync": false, "max_devices": 0, "max_records": 0, "max_bytes": 0}'::jsonb, true),
  ('beta', 'Beta', '{"sync": true, "max_devices": 5, "max_records": 100000, "max_bytes": 104857600}'::jsonb, true),
  ('sync', 'Sync', '{"sync": true, "max_devices": 10, "max_records": 200000, "max_bytes": 209715200}'::jsonb, false)
on conflict (id) do update
  set name = excluded.name,
      features = excluded.features,
      is_public = excluded.is_public;

insert into public.app_config (key, value)
values ('sync_free_for_all', 'true'::jsonb)
on conflict (key) do nothing;

-- ── Table privileges and policies ───────────────────────────────────────────
-- Supabase grants everything on new public tables to anon and authenticated by
-- default, so the revokes matter. app_config and sync_records get no grant and
-- no policy: they are reached only through the functions below.

revoke all on table
  public.plans,
  public.app_config,
  public.entitlements,
  public.vaults,
  public.devices,
  public.sync_records
from public, anon, authenticated;

grant select on table
  public.plans,
  public.entitlements,
  public.vaults,
  public.devices
to authenticated;

drop policy if exists plans_select_public on public.plans;
create policy plans_select_public on public.plans
  for select to authenticated
  using (is_public);

drop policy if exists entitlements_select_own on public.entitlements;
create policy entitlements_select_own on public.entitlements
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists vaults_select_own on public.vaults;
create policy vaults_select_own on public.vaults
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists devices_select_own on public.devices;
create policy devices_select_own on public.devices
  for select to authenticated
  using (user_id = auth.uid());

-- ── Plans and permissions ───────────────────────────────────────────────────

-- The caller's plan: a valid entitlement to a plan other than 'free' (active
-- with no end or a future end, or past_due until the period ends); otherwise
-- 'beta' while app_config.sync_free_for_all is true; otherwise 'free'. 'free'
-- is the floor plan, so an entitlement to it never overrides the beta switch.
create or replace function public.effective_plan()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan text;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  select e.plan_id
    into v_plan
    from public.entitlements e
   where e.user_id = v_uid
     and e.plan_id <> 'free'
     and (
       (e.status = 'active'
         and (e.current_period_end is null or e.current_period_end > now()))
       or (e.status = 'past_due' and e.current_period_end > now())
     );
  if v_plan is not null then
    return v_plan;
  end if;

  if coalesce(
    (select c.value from public.app_config c where c.key = 'sync_free_for_all') = 'true'::jsonb,
    false
  ) then
    return 'beta';
  end if;
  return 'free';
end;
$$;

-- The only place a permission is decided.
create or replace function public.has_feature(p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  return coalesce(
    (select p.features -> p_feature
       from public.plans p
      where p.id = public.effective_plan()) = 'true'::jsonb,
    false
  );
end;
$$;

-- One call for the UI. granted_by says what decided the plan: a valid
-- entitlement, the beta switch, or neither (the default 'free').
create or replace function public.get_sync_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_plan text;
  v_features jsonb;
  v_free_for_all boolean;
  v_ent public.entitlements%rowtype;
  v_has_ent boolean;
  v_ent_valid boolean;
  v_granted_by text;
  v_vault jsonb;
  v_devices int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  v_plan := public.effective_plan();
  select p.features into v_features from public.plans p where p.id = v_plan;
  v_free_for_all := coalesce(
    (select c.value from public.app_config c where c.key = 'sync_free_for_all') = 'true'::jsonb,
    false
  );

  select * into v_ent from public.entitlements e where e.user_id = v_uid;
  v_has_ent := found;
  v_ent_valid := v_has_ent
    and v_ent.plan_id <> 'free'
    and v_ent.plan_id = v_plan
    and (
      (v_ent.status = 'active'
        and (v_ent.current_period_end is null or v_ent.current_period_end > now()))
      or (v_ent.status = 'past_due' and v_ent.current_period_end > now())
    );

  if v_ent_valid then
    v_granted_by := 'entitlement';
  elsif v_free_for_all and v_plan = 'beta' then
    v_granted_by := 'free_for_all';
  else
    v_granted_by := 'default';
  end if;

  select jsonb_build_object(
           'vault_id', v.vault_id,
           'header_rev', v.header_rev,
           'record_count', v.record_count,
           'total_bytes', v.total_bytes,
           'last_seq', v.last_seq
         )
    into v_vault
    from public.vaults v
   where v.user_id = v_uid;

  select count(*) into v_devices
    from public.devices d
   where d.user_id = v_uid and d.removed_at is null;

  return jsonb_build_object(
    'plan_id', v_plan,
    'has_sync', public.has_feature('sync'),
    'free_for_all', v_free_for_all,
    'granted_by', v_granted_by,
    'beta_joined_at', v_ent.beta_joined_at,
    'entitlement_status', v_ent.status,
    'current_period_end', v_ent.current_period_end,
    'limits', coalesce(v_features, '{}'::jsonb),
    'vault', v_vault,
    'devices_count', v_devices
  );
end;
$$;

-- ── Devices ─────────────────────────────────────────────────────────────────

-- Registers this device, or refreshes last_seen_at of a known one (its label
-- is kept, so a rename survives). A removed device stays removed. A new device
-- counts against the plan's max_devices among non-removed devices. The first
-- successful call creates the user's entitlements row ('free', source 'beta')
-- with the beta join date while the beta switch is on.
create or replace function public.register_device(p_device_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_label text := btrim(p_label);
  v_dev public.devices%rowtype;
  v_max int;
  v_count int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  if not public.has_feature('sync') then
    raise exception 'MINIMA:%', 'sync_not_included';
  end if;
  if p_device_id is null or v_label is null or char_length(v_label) not between 1 and 60 then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  select * into v_dev
    from public.devices d
   where d.user_id = v_uid and d.device_id = p_device_id
     for update;

  if found then
    if v_dev.removed_at is not null then
      raise exception 'MINIMA:%', 'device_removed';
    end if;
    update public.devices d
       set last_seen_at = now()
     where d.user_id = v_uid and d.device_id = p_device_id
    returning * into v_dev;
  else
    select (p.features ->> 'max_devices')::int into v_max
      from public.plans p
     where p.id = public.effective_plan();
    select count(*) into v_count
      from public.devices d
     where d.user_id = v_uid and d.removed_at is null;
    if v_count >= coalesce(v_max, 0) then
      raise exception 'MINIMA:%', 'device_limit';
    end if;
    insert into public.devices (user_id, device_id, label)
    values (v_uid, p_device_id, v_label)
    returning * into v_dev;
  end if;

  insert into public.entitlements (user_id, plan_id, status, source, beta_joined_at)
  values (
    v_uid,
    'free',
    'active',
    'beta',
    case
      when coalesce(
        (select c.value from public.app_config c where c.key = 'sync_free_for_all') = 'true'::jsonb,
        false
      ) then now()
    end
  )
  on conflict (user_id) do nothing;

  return jsonb_build_object(
    'device_id', v_dev.device_id,
    'label', v_dev.label,
    'created_at', v_dev.created_at,
    'last_seen_at', v_dev.last_seen_at,
    'removed_at', v_dev.removed_at
  );
end;
$$;

-- Every device of the caller, removed ones included, oldest first. Works
-- without sync: managing your own devices grants no data access.
create or replace function public.list_devices()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  return coalesce(
    (select jsonb_agg(
              jsonb_build_object(
                'device_id', d.device_id,
                'label', d.label,
                'created_at', d.created_at,
                'last_seen_at', d.last_seen_at,
                'removed_at', d.removed_at
              )
              order by d.created_at, d.device_id
            )
       from public.devices d
      where d.user_id = v_uid),
    '[]'::jsonb
  );
end;
$$;

create or replace function public.rename_device(p_device_id uuid, p_label text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_label text := btrim(p_label);
  v_dev public.devices%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  select * into v_dev
    from public.devices d
   where d.user_id = v_uid and d.device_id = p_device_id
     for update;
  if not found then
    raise exception 'MINIMA:%', 'device_not_registered';
  end if;
  if v_dev.removed_at is not null then
    raise exception 'MINIMA:%', 'device_removed';
  end if;
  if v_label is null or char_length(v_label) not between 1 and 60 then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  update public.devices d
     set label = v_label
   where d.user_id = v_uid and d.device_id = p_device_id
  returning * into v_dev;

  return jsonb_build_object(
    'device_id', v_dev.device_id,
    'label', v_dev.label,
    'created_at', v_dev.created_at,
    'last_seen_at', v_dev.last_seen_at,
    'removed_at', v_dev.removed_at
  );
end;
$$;

-- Marks a device as removed (idempotent: the first removal time is kept). A
-- removed device can't register, push or pull again.
create or replace function public.remove_device(p_device_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_dev public.devices%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  update public.devices d
     set removed_at = coalesce(d.removed_at, now())
   where d.user_id = v_uid and d.device_id = p_device_id
  returning * into v_dev;
  if not found then
    raise exception 'MINIMA:%', 'device_not_registered';
  end if;

  return jsonb_build_object(
    'device_id', v_dev.device_id,
    'label', v_dev.label,
    'created_at', v_dev.created_at,
    'last_seen_at', v_dev.last_seen_at,
    'removed_at', v_dev.removed_at
  );
end;
$$;

-- ── Vault ───────────────────────────────────────────────────────────────────

create or replace function public.create_vault(p_device_id uuid, p_vault_id text, p_header jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_removed timestamptz;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  if not public.has_feature('sync') then
    raise exception 'MINIMA:%', 'sync_not_included';
  end if;
  select d.removed_at into v_removed
    from public.devices d
   where d.user_id = v_uid and d.device_id = p_device_id;
  if not found then
    raise exception 'MINIMA:%', 'device_not_registered';
  end if;
  if v_removed is not null then
    raise exception 'MINIMA:%', 'device_removed';
  end if;

  if p_vault_id is null or p_vault_id !~ '^[A-Za-z0-9_-]{1,100}$' then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if p_header is null
     or jsonb_typeof(p_header) <> 'object'
     or octet_length(p_header::text) > 8192
     or (p_header ->> 'vaultId') is distinct from p_vault_id then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  insert into public.vaults (user_id, vault_id, header)
  values (v_uid, p_vault_id, p_header)
  on conflict (user_id) do nothing;
  if not found then
    raise exception 'MINIMA:%', 'vault_exists';
  end if;

  return jsonb_build_object('vault_id', p_vault_id, 'header_rev', 1);
end;
$$;

-- The caller's vault header copy, or SQL null. Works without sync, so a user
-- can always reach the header of their own data.
create or replace function public.get_vault()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_out jsonb;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  select jsonb_build_object(
           'vault_id', v.vault_id,
           'header', v.header,
           'header_rev', v.header_rev
         )
    into v_out
    from public.vaults v
   where v.user_id = v_uid;
  return v_out;
end;
$$;

-- Replaces the header (password change or new recovery key, same DEK) when the
-- caller still has the latest revision.
create or replace function public.update_vault_header(
  p_device_id uuid,
  p_vault_id text,
  p_header jsonb,
  p_expected_rev int
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_removed timestamptz;
  v_vault public.vaults%rowtype;
  v_rev int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  if not public.has_feature('sync') then
    raise exception 'MINIMA:%', 'sync_not_included';
  end if;
  select d.removed_at into v_removed
    from public.devices d
   where d.user_id = v_uid and d.device_id = p_device_id;
  if not found then
    raise exception 'MINIMA:%', 'device_not_registered';
  end if;
  if v_removed is not null then
    raise exception 'MINIMA:%', 'device_removed';
  end if;

  select * into v_vault
    from public.vaults v
   where v.user_id = v_uid
     for update;
  if not found then
    raise exception 'MINIMA:%', 'no_vault';
  end if;
  if v_vault.vault_id is distinct from p_vault_id then
    raise exception 'MINIMA:%', 'vault_mismatch';
  end if;
  if p_header is null
     or jsonb_typeof(p_header) <> 'object'
     or octet_length(p_header::text) > 8192
     or (p_header ->> 'vaultId') is distinct from p_vault_id then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if v_vault.header_rev is distinct from p_expected_rev then
    raise exception 'MINIMA:%', 'header_conflict';
  end if;

  update public.vaults v
     set header = p_header,
         header_rev = v.header_rev + 1,
         updated_at = now()
   where v.user_id = v_uid
  returning v.header_rev into v_rev;

  return jsonb_build_object('vault_id', v_vault.vault_id, 'header_rev', v_rev);
end;
$$;

-- ── Records ─────────────────────────────────────────────────────────────────

-- Writes a batch of encrypted records. The vault row is locked first, so seq
-- order equals commit order per user. A record is written only when it is new
-- or its updated_at_ms is strictly newer than the stored one; otherwise it is
-- 'stale' and the stored row comes back (the server copy wins exact ties).
-- Any error, including quota_exceeded after the loop, rolls back the batch.
create or replace function public.push_records(p_device_id uuid, p_vault_id text, p_records jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_removed timestamptz;
  v_vault public.vaults%rowtype;
  v_features jsonb;
  v_elem jsonb;
  v_num numeric;
  v_chars bigint;
  v_key text;
  v_ct text;
  v_iv text;
  v_ms bigint;
  v_size int;
  v_old public.sync_records%rowtype;
  v_seq bigint;
  v_record_count bigint;
  v_total_bytes bigint;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  if not public.has_feature('sync') then
    raise exception 'MINIMA:%', 'sync_not_included';
  end if;
  select d.removed_at into v_removed
    from public.devices d
   where d.user_id = v_uid and d.device_id = p_device_id;
  if not found then
    raise exception 'MINIMA:%', 'device_not_registered';
  end if;
  if v_removed is not null then
    raise exception 'MINIMA:%', 'device_removed';
  end if;

  select * into v_vault
    from public.vaults v
   where v.user_id = v_uid
     for update;
  if not found then
    raise exception 'MINIMA:%', 'no_vault';
  end if;
  if v_vault.vault_id is distinct from p_vault_id then
    raise exception 'MINIMA:%', 'vault_mismatch';
  end if;

  if p_records is null or jsonb_typeof(p_records) <> 'array' then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if jsonb_array_length(p_records) > 500 then
    raise exception 'MINIMA:%', 'batch_too_large';
  end if;
  select coalesce(sum(
           case when jsonb_typeof(e.value -> 'ciphertext') = 'string'
                then char_length(e.value ->> 'ciphertext')
                else 0 end
         ), 0)
    into v_chars
    from jsonb_array_elements(p_records) as e(value);
  if v_chars > 1048576 then
    raise exception 'MINIMA:%', 'batch_too_large';
  end if;

  -- Validate every element before writing anything. One check per statement,
  -- so a cast never runs on a value that failed its type check.
  for v_elem in select e.value from jsonb_array_elements(p_records) as e(value) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if jsonb_typeof(v_elem -> 'record_key') is distinct from 'string'
       or (v_elem ->> 'record_key') !~ '^[A-Za-z0-9_-]{16,128}$' then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if jsonb_typeof(v_elem -> 'ciphertext') is distinct from 'string'
       or char_length(v_elem ->> 'ciphertext') not between 1 and 65536 then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if jsonb_typeof(v_elem -> 'iv') is distinct from 'string'
       or char_length(v_elem ->> 'iv') not between 1 and 32 then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if jsonb_typeof(v_elem -> 'enc_v') is distinct from 'number' then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if (v_elem -> 'enc_v') <> '1'::jsonb then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if jsonb_typeof(v_elem -> 'updated_at_ms') is distinct from 'number' then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    v_num := (v_elem ->> 'updated_at_ms')::numeric;
    if v_num < 0 or v_num > 9007199254740991 or v_num <> trunc(v_num) then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
  end loop;

  if (select count(distinct e.value ->> 'record_key') <> count(*)
        from jsonb_array_elements(p_records) as e(value)) then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  v_seq := v_vault.last_seq;
  v_record_count := v_vault.record_count;
  v_total_bytes := v_vault.total_bytes;

  for v_elem in
    select e.value
      from jsonb_array_elements(p_records) with ordinality as e(value, ord)
     order by e.ord
  loop
    v_key := v_elem ->> 'record_key';
    v_ct := v_elem ->> 'ciphertext';
    v_iv := v_elem ->> 'iv';
    v_ms := (v_elem ->> 'updated_at_ms')::bigint;
    v_size := char_length(v_ct);

    select * into v_old
      from public.sync_records r
     where r.user_id = v_uid and r.record_key = v_key
       for update;

    if not found then
      v_seq := v_seq + 1;
      insert into public.sync_records (
        user_id, record_key, vault_id, ciphertext, iv, enc_v,
        updated_at_ms, device_id, seq, size
      )
      values (
        v_uid, v_key, p_vault_id, v_ct, v_iv, 1,
        v_ms, p_device_id, v_seq, v_size
      );
      v_record_count := v_record_count + 1;
      v_total_bytes := v_total_bytes + v_size;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('record_key', v_key, 'status', 'accepted', 'seq', v_seq)
      );
    elsif v_ms > v_old.updated_at_ms then
      v_seq := v_seq + 1;
      update public.sync_records r
         set vault_id = p_vault_id,
             ciphertext = v_ct,
             iv = v_iv,
             enc_v = 1,
             updated_at_ms = v_ms,
             device_id = p_device_id,
             size = v_size,
             seq = v_seq,
             server_updated_at = now()
       where r.user_id = v_uid and r.record_key = v_key;
      v_total_bytes := v_total_bytes + v_size - v_old.size;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('record_key', v_key, 'status', 'accepted', 'seq', v_seq)
      );
    else
      v_results := v_results || jsonb_build_array(
        jsonb_build_object(
          'record_key', v_key,
          'status', 'stale',
          'current', jsonb_build_object(
            'record_key', v_old.record_key,
            'ciphertext', v_old.ciphertext,
            'iv', v_old.iv,
            'enc_v', v_old.enc_v,
            'updated_at_ms', v_old.updated_at_ms,
            'device_id', v_old.device_id,
            'seq', v_old.seq
          )
        )
      );
    end if;
  end loop;

  select p.features into v_features
    from public.plans p
   where p.id = public.effective_plan();
  if v_record_count > coalesce((v_features ->> 'max_records')::bigint, 0)
     or v_total_bytes > coalesce((v_features ->> 'max_bytes')::bigint, 0) then
    raise exception 'MINIMA:%', 'quota_exceeded';
  end if;

  update public.vaults v
     set last_seq = v_seq,
         record_count = v_record_count,
         total_bytes = v_total_bytes,
         updated_at = now()
   where v.user_id = v_uid;
  update public.devices d
     set last_seen_at = now()
   where d.user_id = v_uid and d.device_id = p_device_id;

  return jsonb_build_object('results', v_results, 'last_seq', v_seq);
end;
$$;

-- The caller's records with seq > p_since, in seq order, at most p_limit.
create or replace function public.pull_records(
  p_device_id uuid,
  p_vault_id text,
  p_since bigint,
  p_limit int default 500
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_removed timestamptz;
  v_vault public.vaults%rowtype;
  v_records jsonb;
  v_found int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  if not public.has_feature('sync') then
    raise exception 'MINIMA:%', 'sync_not_included';
  end if;
  select d.removed_at into v_removed
    from public.devices d
   where d.user_id = v_uid and d.device_id = p_device_id;
  if not found then
    raise exception 'MINIMA:%', 'device_not_registered';
  end if;
  if v_removed is not null then
    raise exception 'MINIMA:%', 'device_removed';
  end if;

  select * into v_vault from public.vaults v where v.user_id = v_uid;
  if not found then
    raise exception 'MINIMA:%', 'no_vault';
  end if;
  if v_vault.vault_id is distinct from p_vault_id then
    raise exception 'MINIMA:%', 'vault_mismatch';
  end if;
  if p_since is null or p_since < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  select count(*) into v_found
    from (
      select 1
        from public.sync_records r
       where r.user_id = v_uid and r.seq > p_since
       order by r.seq
       limit p_limit + 1
    ) as x;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'record_key', s.record_key,
               'ciphertext', s.ciphertext,
               'iv', s.iv,
               'enc_v', s.enc_v,
               'updated_at_ms', s.updated_at_ms,
               'device_id', s.device_id,
               'seq', s.seq
             )
             order by s.seq
           ),
           '[]'::jsonb
         )
    into v_records
    from (
      select r.record_key, r.ciphertext, r.iv, r.enc_v, r.updated_at_ms, r.device_id, r.seq
        from public.sync_records r
       where r.user_id = v_uid and r.seq > p_since
       order by r.seq
       limit p_limit
    ) as s;

  update public.devices d
     set last_seen_at = now()
   where d.user_id = v_uid and d.device_id = p_device_id;

  return jsonb_build_object(
    'records', v_records,
    'has_more', v_found > p_limit,
    'last_seq', v_vault.last_seq,
    'vault_id', v_vault.vault_id
  );
end;
$$;

-- Deletes the caller's records, vault and devices. Keeps the account and the
-- entitlements row. Works without sync, so a user can always delete.
create or replace function public.delete_cloud_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_deleted int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  delete from public.sync_records r where r.user_id = v_uid;
  get diagnostics v_deleted = row_count;
  delete from public.vaults v where v.user_id = v_uid;
  delete from public.devices d where d.user_id = v_uid;

  return jsonb_build_object('deleted_records', v_deleted);
end;
$$;

-- ── Function privileges ─────────────────────────────────────────────────────

revoke all on function public.effective_plan() from public, anon, authenticated;
grant execute on function public.effective_plan() to authenticated;

revoke all on function public.has_feature(text) from public, anon, authenticated;
grant execute on function public.has_feature(text) to authenticated;

revoke all on function public.get_sync_status() from public, anon, authenticated;
grant execute on function public.get_sync_status() to authenticated;

revoke all on function public.register_device(uuid, text) from public, anon, authenticated;
grant execute on function public.register_device(uuid, text) to authenticated;

revoke all on function public.list_devices() from public, anon, authenticated;
grant execute on function public.list_devices() to authenticated;

revoke all on function public.rename_device(uuid, text) from public, anon, authenticated;
grant execute on function public.rename_device(uuid, text) to authenticated;

revoke all on function public.remove_device(uuid) from public, anon, authenticated;
grant execute on function public.remove_device(uuid) to authenticated;

revoke all on function public.create_vault(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.create_vault(uuid, text, jsonb) to authenticated;

revoke all on function public.get_vault() from public, anon, authenticated;
grant execute on function public.get_vault() to authenticated;

revoke all on function public.update_vault_header(uuid, text, jsonb, int) from public, anon, authenticated;
grant execute on function public.update_vault_header(uuid, text, jsonb, int) to authenticated;

revoke all on function public.push_records(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.push_records(uuid, text, jsonb) to authenticated;

revoke all on function public.pull_records(uuid, text, bigint, int) from public, anon, authenticated;
grant execute on function public.pull_records(uuid, text, bigint, int) to authenticated;

revoke all on function public.delete_cloud_data() from public, anon, authenticated;
grant execute on function public.delete_cloud_data() to authenticated;
```

## 9. Family spaces (2026-10-29)

The server side of a shared Family space next to the Personal one: spaces, members, invites, wrapped space keys, encrypted space records and an event log. The SQL lives in `supabase/migrations/20261029000000_family_spaces.sql`; **that file is authoritative** (it is not copied here). It requires the §8 migration applied first, and it is idempotent: tables and indexes use `if not exists`, functions are replaced, policies and the trigger are dropped and created again, and plan features are merged with `||`. **Re-running the §8 migration resets the plan features and `get_sync_status()`; run this one again afterwards.** Nothing in the app calls these functions yet: the typed client `src/lib/cloud/spacesApi.ts` (`createSpacesApi(rpc)`) exists for the next run.

The server never sees the space key, amounts, categories, descriptions or the space name. A member's space key reaches them only wrapped for their identity public key (`{ v: 1, epk, iv, ct }`, ECIES from `src/lib/spaces/spaceCrypto.ts`), and a record is an opaque `record_key` plus an AES-GCM ciphertext. An invite stores only `token_hash`, the SHA-256 of the invite token; the secret the token is derived from never leaves the link's URL fragment.

### Plan features

| Plan | New keys |
| --- | --- |
| `free` | `shared_spaces: false` |
| `beta` | `shared_spaces: true`, `max_members: 6`, `max_space_records: 100000`, `max_space_bytes: 104857600` (100 MB) |
| `sync` | `shared_spaces: false` |
| `family` (new, `is_public = false`) | `sync: true`, `max_devices: 10`, `max_records: 200000`, `max_bytes: 209715200`, `shared_spaces: true`, `max_members: 6`, `max_space_records: 100000`, `max_space_bytes: 104857600` |

The other keys of every plan are kept. A re-run merges the `family` features and never changes its `name` or `is_public`, so a family plan made public later stays public. `supabase/tests/sync_server_checks.sql` compares the run 2 seeds without the four new keys, so it passes before and after this migration.

### Tables

| Table | Purpose | Client access (`select` via RLS) |
| --- | --- | --- |
| `spaces` | `id` (client-generated uuid), `owner_id`, `key_version` (≥ 1), `last_seq`, `record_count`, `total_bytes`, `created_at`, `updated_at`. | active members of the space |
| `space_members` | `(space_id, user_id)`, `role` (`owner` / `member`), `status` (`pending` / `active`; an owner is always active), `public_key` (the member's identity JWK, ≤ 2 KB), `requested_at`, `joined_at`, `invite_id`. Unique indexes: one pending-or-active row per user (`space_members_one_per_user_idx`, "one space per user") and one owner per space (`space_members_one_owner_idx`). | active members see every row of their space, pending ones and public keys included |
| `space_invites` | `id`, `space_id`, `created_by`, `token_hash` (64 lowercase hex), `expires_at` (default 48 h, at most 7 days after `created_at`), `used_by`, `used_at`, `revoked_at`, `created_at`. | none (functions only) |
| `space_keys` | `(space_id, user_id, key_version)`, `wrapped_key` (`{ v, epk, iv, ct }`, ≤ 2 KB), `created_at`. Old versions are kept after a rotation. | own rows only, while an active member |
| `space_records` | `(space_id, record_key)`, `key_version`, `ciphertext`, `iv`, `enc_v`, `updated_at_ms`, `author_id`, `device_id`, `seq`, `size`, `server_updated_at`; index `(space_id, seq)`. Same field rules as `sync_records`. | none (functions only) |
| `space_events` | `id` (bigserial), `space_id`, `kind` (`created`, `invite_created`, `invite_revoked`, `join_requested`, `approved`, `rejected`, `removed`, `left`, `key_rotated`, `ownership_transferred`), `actor_id`, `subject_id`, `created_at`. | active members of the space |

RLS is enabled on all six tables. Everything is revoked from `public`, `anon` and `authenticated` first; `authenticated` gets `select` only on `spaces`, `space_members`, `space_keys` and `space_events`, filtered by the policies `spaces_select_member`, `space_members_select_member`, `space_events_select_member` and `space_keys_select_own` (all through `is_active_space_member(space_id)`). No client can insert, update or delete: every write goes through a function. A pending user sees no rows in any table.

Every `space_id` cascades from `spaces`, and `spaces.owner_id`, `space_members.user_id`, `space_invites.created_by` / `used_by` and `space_keys.user_id` reference `auth.users(id) on delete cascade`. **`space_records.author_id`, `space_events.actor_id` and `space_events.subject_id` have no foreign key** (decision D5): a cascade would delete the Family records a member wrote, and the `left` event itself, when that member deletes their account. The opaque user id stays until the space is deleted.

Deleting an account: an owner's `auth.users` delete cascades the whole space. For a member, the `before delete` trigger `space_member_left_on_user_delete` on `auth.users` writes a `left` event (actor = the user) before the cascade removes their member row and keys.

### Functions

Every function is `SECURITY DEFINER` with `set search_path = ''` and schema-qualified names, takes the caller from `auth.uid()`, raises `MINIMA:not_signed_in` first when there is no user, and is executable by `authenticated` only. "Paused-gated" functions raise `space_paused` when the owner's plan has no `shared_spaces`; the others keep working while paused.

| Function | Checks after `not_signed_in` (in order) | Paused-gated | Returns |
| --- | --- | --- | --- |
| `is_active_space_member(p_space_id)` | none | no | boolean (the RLS helper) |
| `get_my_space()` | none | no | the caller's space (shape below) or null |
| `create_space(p_space_id, p_public_key, p_wrapped_key_for_self)` | `sync_not_included` (no `shared_spaces` on the caller's own plan) → `invalid_input` (null id, bad JWK, bad wrapped key) → `already_in_space` → `invalid_input` (id taken) | – | `{ space_id, key_version }` |
| `create_invite(p_space_id, p_token_hash, p_expires_in_hours = 48)` | space_gone → not_space_member → not_space_owner → space_paused → `invalid_input` (hash not 64 hex; hours not 1..168) → `quota_exceeded` (5 open invites already) | yes | `{ invite_id, expires_at }` |
| `revoke_invite(p_invite_id)` | `invite_invalid` (unknown) → not_space_member → not_space_owner | no | `{ invite_id, revoked_at }` |
| `get_invite(p_invite_id, p_token)` | `invite_invalid` → space_paused | yes | `{ space_id, owner_email, members_count, expires_at }` |
| `request_join(p_invite_id, p_token, p_public_key)` | `invite_invalid` (invite row locked) → space_paused → `invalid_input` (JWK) → `already_in_space` → `member_limit` (active + pending ≥ `max_members`) | yes | `{ space_id, status: 'pending' }` |
| `approve_member(p_space_id, p_user_id, p_key_version, p_wrapped_key)` | space_gone → not_space_member → not_space_owner → space_paused → not_space_member (target not pending) → `invalid_input` → `wrong_key_version` → `member_limit` (active ≥ `max_members`) | yes | `{ user_id, status: 'active', key_version }` |
| `reject_member(p_space_id, p_user_id)` | space_gone → not_space_member → not_space_owner → not_space_member (target not pending) | no | `{ user_id }` |
| `remove_member(p_space_id, p_user_id)` | space_gone → not_space_member → not_space_owner → `cannot_remove_owner` (yourself) → not_space_member (target has no row) | no | `{ user_id }` |
| `rotate_space_key(p_space_id, p_new_version, p_wraps)` | space_gone → not_space_member → not_space_owner → `invalid_input` (wraps not an array of `{ user_id, wrapped_key }`, a repeated user) → `wrong_key_version` (≠ current + 1) → `members_mismatch` (wrap users ≠ active members, owner included) | no | `{ space_id, key_version }` |
| `leave_space()` | not_space_member (no row) → `owner_must_transfer_or_delete` | no | `{ space_id }` |
| `transfer_ownership(p_space_id, p_user_id)` | space_gone → not_space_member → not_space_owner → `invalid_input` (yourself) → not_space_member (target not active) | no | `{ space_id, owner_id }` |
| `delete_space(p_space_id)` | space_gone → not_space_member → not_space_owner | no | `{ space_id }` |
| `push_space_records(p_space_id, p_device_id, p_key_version, p_records)` | space_gone → not_space_member → space_paused → `device_not_registered` / `device_removed` → `invalid_input` → `key_outdated:<n>` → `invalid_input` / `batch_too_large` / per-record `invalid_input` (as `push_records`) → `quota_exceeded` after the batch | yes | `{ results: [{ record_key, status: 'accepted', seq } \| { record_key, status: 'stale', current }], last_seq }` |
| `pull_space_records(p_space_id, p_device_id, p_since, p_limit = 500)` | space_gone → not_space_member → space_paused → device checks → `invalid_input` (since < 0, limit not 1..1000) | yes | `{ records, has_more, last_seq, key_version }` |

A record row is `{ record_key, ciphertext, iv, enc_v, updated_at_ms, key_version, author_id, device_id, seq }`.

- **Order of checks.** Always `not_signed_in` → `space_gone` (no such space; writers lock the `spaces` row `for update`, so `seq` order is commit order per space) → `not_space_member` (no **active** row of the caller) → `not_space_owner` → `space_paused` (only where gated). Problems with the *target* user of an owner action raise `not_space_member` too. "Open invite" means unused, unrevoked and not expired.
- **Invites.** Only the hash is stored. `get_invite` and `request_join` raise the same `invite_invalid` for an unknown, expired, used or revoked invite and for a wrong, null or empty token, comparing `encode(sha256(convert_to(p_token, 'UTF8')), 'hex')` with `token_hash`. An invite is single use: `request_join` sets `used_by` / `used_at`, and a rejected request does not free it. `revoke_invite` is idempotent and writes `invite_revoked` only the first time.
- **Join and approval.** `request_join` adds a pending member with their public key. The owner's device wraps the current space key for that key and calls `approve_member` with the current `key_version`; only then does the member get a `space_keys` row (written with `on conflict do update`, so a retried approval just replaces the wrap).
- **Removal and rotation.** `remove_member` deletes the member row and all their `space_keys` at once, so they lose server access immediately. The owner's device then generates a new space key and calls `rotate_space_key` with version `key_version + 1` and one wrap for every remaining active member (owner included), in one transaction. Old key rows are kept so older records stay readable.
- **Records.** `push_space_records` takes the current `p_key_version`; any other value raises **`MINIMA:key_outdated:<current key_version>`** (the client reads it with `currentKeyVersionOf(err)`). A record is accepted when it is new, when its `updated_at_ms` is strictly newer, or when the time is equal and it was re-encrypted with a newer `key_version`; otherwise it is `stale` and the stored row comes back. `author_id` is always the caller. `enc_v` must be 1, as in §8. A batch over the owner's `max_space_records` / `max_space_bytes` raises `quota_exceeded` and rolls back.
- **Ownership.** `transfer_ownership` demotes the caller, then promotes the target (two statements because of the one-owner index) and updates `spaces.owner_id`. An owner can leave only after a transfer, or delete the space.
- **`get_my_space()`** returns `{ space_id, role, status, key_version, owner_id, members, my_keys, open_invites, paused, limits, last_seq, record_count, total_bytes }`. For a pending caller `key_version`, `owner_id`, `limits` and the counters are null and `members` / `my_keys` / `open_invites` are `[]` (`paused` is still computed). `members` (owner first, then by `requested_at`) carry `email` from `auth.users`, shown only to active members of the same space; `open_invites` is filled for the owner only.
- **`get_sync_status()`** keeps its run 2 keys and adds `space`: `{ space_id, role, status, paused }` for the caller's pending or active membership, else null. The client's `SyncStatus` ignores it for now.

Internal functions (`SECURITY DEFINER`, revoked from everyone, never granted): `effective_plan_for(p_user)`, `has_feature_for(p_user, p_feature)`, `is_valid_public_jwk(p)` (EC P-256 with string `x` / `y`, no private `d`, ≤ 2 KB) and `is_valid_wrapped_key(p)` (`v = 1`, object `epk`, string `iv` / `ct`, ≤ 2 KB), both declared `immutable`, and the trigger function `space_member_left_on_user_delete()`.

### Permission model

- **Space access follows the owner's plan** (decision D2): `has_feature_for(spaces.owner_id, 'shared_spaces')`, and `max_members`, `max_space_records` and `max_space_bytes` are read from the owner's plan, never from code. A member's own plan does not matter, except that pushing and pulling need a registered §8 device (see Known gaps). Creating a space needs `shared_spaces` on the creator's own plan (`sync_not_included` otherwise).
- **Paused.** When the owner loses `shared_spaces`, the space is paused: push, pull, `create_invite`, `get_invite`, `request_join` and `approve_member` raise `space_paused`. `get_my_space` (with `paused: true`), `revoke_invite`, `reject_member`, `remove_member`, `rotate_space_key`, `leave_space`, `transfer_ownership` and `delete_space` keep working, so members can always manage, leave or delete. Nothing is deleted while paused; restoring the plan resumes the space.
- **One place for permissions.** `effective_plan()` / `has_feature()` keep their run 2 behaviour but now call `effective_plan_for(auth.uid())` / `has_feature_for(auth.uid(), …)`, so `has_feature_for` is the same rule for any user.

### Error codes

New codes (`SPACE_SERVER_ERROR_CODES` in `src/lib/cloud/types.ts`; `SERVER_ERROR_CODES` is unchanged):

| Code | Meaning |
| --- | --- |
| `not_space_member` | the caller (or the target user of an owner action) has no row of the needed kind in that space |
| `not_space_owner` | the caller is an active member but not the owner |
| `already_in_space` | the caller already has a pending or active membership (one space per user) |
| `invite_invalid` | unknown, expired, used or revoked invite, or a wrong token (deliberately one code) |
| `member_limit` | the owner's `max_members` is reached |
| `wrong_key_version` | approve: not the current version; rotate: not current + 1 |
| `key_outdated` | push with a stale key version; the message is `MINIMA:key_outdated:<current>` (the one exception to §8's "the whole message" rule) |
| `members_mismatch` | the rotation wraps don't match the active members |
| `space_paused` | the owner's plan has no `shared_spaces` |
| `space_gone` | no such space (deleted, or never existed) |
| `cannot_remove_owner` | `remove_member` on yourself as owner |
| `owner_must_transfer_or_delete` | the owner called `leave_space` |

Reused §8 codes: `not_signed_in`; `invalid_input` (bad arguments, a taken space id, transferring to yourself); `quota_exceeded` (a 6th open invite, or the owner's space record / byte limits); `sync_not_included` (`create_space` without `shared_spaces`); `batch_too_large`, `device_not_registered`, `device_removed` (push / pull). `spacesApi.ts` maps all of them to `CloudError` codes, any other `MINIMA:` code to `unknown`, plus `network`.

### Family plan switch

The `family` plan exists but is not public. To give an owner a Family plan by hand (it gives them sync and `shared_spaces`; members follow the owner's plan):

```sql
insert into public.entitlements (user_id, plan_id, status, source)
values ('<owner user id>', 'family', 'active', 'manual')
on conflict (user_id) do update
  set plan_id = 'family', status = 'active', source = 'manual', current_period_end = null, updated_at = now();
```

The plan features that matter for a space are `shared_spaces`, `max_members`, `max_space_records` and `max_space_bytes` (and `sync` / `max_devices` for the owner's own devices). During the beta every user gets `beta`, which already has `shared_spaces`. When payments go live, the payment webhook writes `family` entitlements like `sync` ones, and the plan is shown with `update public.plans set is_public = true where id = 'family';` (a re-run of this migration keeps it public).

### Known gaps

- **G1: members without sync of their own.** `push_space_records` / `pull_space_records` need a §8 device, and `register_device` (unchanged) needs the caller's own `sync` feature. In the beta everyone has it; under a paid Family plan a member without personal sync could not register a device. The next run must solve this (e.g. allow `register_device` for active members of a non-paused space).
- The client does not read `get_sync_status().space` or call `spacesApi.ts` yet, and must gate Family data movement on `get_my_space().paused` when it does (the server already enforces it).
- Only `enc_v = 1` is accepted; a new record format needs a new migration.

### Manual steps (in this order)

1. In the Supabase SQL editor, run `supabase/migrations/20261029000000_family_spaces.sql`, then `supabase/tests/sync_server_checks.sql` and `supabase/tests/family_spaces_checks.sql`. Each check script runs in one transaction that is rolled back, raises `CHECK FAILED: <name>` on any failure and must finish with its notice (`sync_server_checks: all checks passed`, `family_spaces_checks: all checks passed`). The family script uses the throwaway users `00000000-0000-4000-8000-0000000000f1` … `…f4` and gives f1–f3 a `family` entitlement inside its transaction, so it passes whether or not the beta switch is on.
2. Confirm in the Supabase dashboard that the trigger `space_member_left_on_user_delete` exists on `auth.users`. The migration must be run by a role allowed to create triggers on `auth.users` (the SQL editor's `postgres` is).
3. No env changes. If the §8 migration is ever re-run, run this one again afterwards.

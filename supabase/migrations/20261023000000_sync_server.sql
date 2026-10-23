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

-- MinimaSpend Family space server: the shared Family space next to the
-- Personal one. Spaces, members, invites, wrapped space keys, encrypted space
-- records and an event log, plus the SECURITY DEFINER functions the client
-- calls (src/lib/cloud/spacesApi.ts). See docs/db.md section 9 and
-- docs/free-tier-spec.md section 21.
--
-- Requires 20261023000000_sync_server.sql applied first (plans, entitlements,
-- app_config, devices, effective_plan(), has_feature(), get_sync_status()).
-- Re-running 20261023000000_sync_server.sql resets the plan features and
-- get_sync_status; run this file again afterwards.
--
-- Safe to run more than once: tables and indexes use IF NOT EXISTS, functions
-- are replaced, policies and the trigger are dropped and created again, and
-- the plan features are merged with || (other keys, and the name / is_public
-- of the family plan, are kept).
--
-- Rules every function below follows:
--   * SECURITY DEFINER with an empty search path, schema-qualified names only;
--   * the caller is always auth.uid(), never a parameter, and a missing user
--     raises MINIMA:not_signed_in first (the internal helpers, which nobody
--     may call directly, are the exception);
--   * EXECUTE is granted to authenticated only (revoked from public and anon);
--     the internal helpers are granted to nobody;
--   * errors are raised with the message exactly MINIMA:<code>, except
--     MINIMA:key_outdated:<current key_version> (decision D4).
-- Common checks, always in this order: not_signed_in, space_gone (no such
-- space; writers lock the row FOR UPDATE), not_space_member (no ACTIVE row of
-- the caller in that space), not_space_owner, space_paused (only where noted).
-- Space permissions follow the OWNER's plan: has_feature_for(owner_id,
-- 'shared_spaces') and the owner's max_members / max_space_records /
-- max_space_bytes. has_feature() now delegates to has_feature_for(), so
-- permissions are still decided in one place.
--
-- The server never sees the space key, amounts, categories or descriptions:
-- a member's space key arrives wrapped for their identity public key
-- ({ v, epk, iv, ct }), and a record is an opaque record_key plus an AES-GCM
-- ciphertext. An invite stores only SHA-256 of the invite token; the secret the
-- token is derived from never leaves the link's URL fragment.

-- ── Plan features ───────────────────────────────────────────────────────────
-- CONTRACT_GAP: a re-run merges the features and never touches the family
-- plan's name or is_public, so making it public later survives a re-run.

update public.plans
   set features = features || '{"shared_spaces": false}'::jsonb
 where id = 'free';

update public.plans
   set features = features || '{"shared_spaces": true, "max_members": 6, "max_space_records": 100000, "max_space_bytes": 104857600}'::jsonb
 where id = 'beta';

update public.plans
   set features = features || '{"shared_spaces": false}'::jsonb
 where id = 'sync';

insert into public.plans (id, name, features, is_public)
values (
  'family',
  'Family',
  '{"sync": true, "max_devices": 10, "max_records": 200000, "max_bytes": 209715200,
    "shared_spaces": true, "max_members": 6, "max_space_records": 100000, "max_space_bytes": 104857600}'::jsonb,
  false
)
on conflict (id) do update
  set features = public.plans.features || excluded.features;

-- ── Tables ──────────────────────────────────────────────────────────────────
-- CONTRACT_GAP (D5): space_records.author_id, space_events.actor_id and
-- space_events.subject_id have no foreign key. A cascade would delete shared
-- Family records and history when one member deletes their account (and the
-- 'left' event the trigger below writes). The opaque user id stays until the
-- space is deleted.

create table if not exists public.spaces (
  id uuid primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  key_version int not null default 1 check (key_version >= 1),
  last_seq bigint not null default 0,
  record_count int not null default 0,
  total_bytes bigint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.space_members (
  space_id uuid not null references public.spaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('owner', 'member')),
  status text not null check (status in ('pending', 'active')),
  public_key jsonb not null
    check (jsonb_typeof(public_key) = 'object' and octet_length(public_key::text) <= 2048),
  requested_at timestamptz not null default now(),
  joined_at timestamptz null,
  invite_id uuid null,
  primary key (space_id, user_id),
  check (role = 'member' or status = 'active')
);

create table if not exists public.space_invites (
  id uuid primary key default gen_random_uuid(),
  space_id uuid not null references public.spaces (id) on delete cascade,
  created_by uuid not null references auth.users (id) on delete cascade,
  token_hash text not null check (token_hash ~ '^[0-9a-f]{64}$'),
  expires_at timestamptz not null default (now() + interval '48 hours'),
  used_by uuid null references auth.users (id) on delete cascade,
  used_at timestamptz null,
  revoked_at timestamptz null,
  created_at timestamptz not null default now(),
  check (expires_at <= created_at + interval '7 days')
);

create table if not exists public.space_keys (
  space_id uuid not null references public.spaces (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  key_version int not null check (key_version >= 1),
  wrapped_key jsonb not null
    check (jsonb_typeof(wrapped_key) = 'object' and octet_length(wrapped_key::text) <= 2048),
  created_at timestamptz not null default now(),
  primary key (space_id, user_id, key_version)
);

create table if not exists public.space_records (
  space_id uuid not null references public.spaces (id) on delete cascade,
  record_key text not null check (record_key ~ '^[A-Za-z0-9_-]{16,128}$'),
  key_version int not null,
  ciphertext text not null check (char_length(ciphertext) between 1 and 65536),
  iv text not null check (char_length(iv) between 1 and 32),
  enc_v smallint not null,
  updated_at_ms bigint not null,
  author_id uuid not null,
  device_id uuid not null,
  seq bigint not null,
  size int not null,
  server_updated_at timestamptz not null default now(),
  primary key (space_id, record_key)
);

create table if not exists public.space_events (
  id bigserial primary key,
  space_id uuid not null references public.spaces (id) on delete cascade,
  kind text not null check (kind in (
    'created', 'invite_created', 'invite_revoked', 'join_requested', 'approved',
    'rejected', 'removed', 'left', 'key_rotated', 'ownership_transferred'
  )),
  actor_id uuid null,
  subject_id uuid null,
  created_at timestamptz not null default now()
);

-- One space per user: at most one pending-or-active membership.
create unique index if not exists space_members_one_per_user_idx
  on public.space_members (user_id)
  where status in ('pending', 'active');

create unique index if not exists space_members_one_owner_idx
  on public.space_members (space_id)
  where role = 'owner';

create index if not exists space_records_space_seq_idx
  on public.space_records (space_id, seq);

create index if not exists space_invites_space_idx
  on public.space_invites (space_id);

create index if not exists space_events_space_idx
  on public.space_events (space_id, id);

alter table public.spaces enable row level security;
alter table public.space_members enable row level security;
alter table public.space_invites enable row level security;
alter table public.space_keys enable row level security;
alter table public.space_records enable row level security;
alter table public.space_events enable row level security;

-- ── Plans and permissions ───────────────────────────────────────────────────

-- The plan of any user: the body of run 2's effective_plan() for p_user. A
-- valid entitlement to a plan other than 'free' (active with no end or a
-- future end, or past_due until the period ends); otherwise 'beta' while
-- app_config.sync_free_for_all is true; otherwise 'free'. A null user gets
-- the beta / free fallback. Internal: no EXECUTE for anyone.
create or replace function public.effective_plan_for(p_user uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_plan text;
begin
  if p_user is not null then
    select e.plan_id
      into v_plan
      from public.entitlements e
     where e.user_id = p_user
       and e.plan_id <> 'free'
       and (
         (e.status = 'active'
           and (e.current_period_end is null or e.current_period_end > now()))
         or (e.status = 'past_due' and e.current_period_end > now())
       );
    if v_plan is not null then
      return v_plan;
    end if;
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

-- The only place a permission is decided, for any user. Internal.
create or replace function public.has_feature_for(p_user uuid, p_feature text)
returns boolean
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  return coalesce(
    (select p.features -> p_feature
       from public.plans p
      where p.id = public.effective_plan_for(p_user)) = 'true'::jsonb,
    false
  );
end;
$$;

-- Run 2's functions, now delegating. Same behaviour, same grants.
create or replace function public.effective_plan()
returns text
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  return public.effective_plan_for(auth.uid());
end;
$$;

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
  return public.has_feature_for(auth.uid(), p_feature);
end;
$$;

-- ── Internal helpers ────────────────────────────────────────────────────────

-- An identity public key: an EC P-256 JWK with string x and y and never a
-- private part (no 'd'). The server never checks that the point is on the
-- curve; the owner's device does when it wraps the space key.
create or replace function public.is_valid_public_jwk(p jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  return coalesce(
    p is not null
    and jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 2048
    and jsonb_typeof(p -> 'kty') = 'string'
    and (p ->> 'kty') = 'EC'
    and jsonb_typeof(p -> 'crv') = 'string'
    and (p ->> 'crv') = 'P-256'
    and jsonb_typeof(p -> 'x') = 'string'
    and jsonb_typeof(p -> 'y') = 'string'
    and not (p ? 'd'),
    false
  );
end;
$$;

-- A space key wrapped for a public key (run A's { v: 1, epk, iv, ct }).
create or replace function public.is_valid_wrapped_key(p jsonb)
returns boolean
language plpgsql
immutable
security definer
set search_path = ''
as $$
begin
  return coalesce(
    p is not null
    and jsonb_typeof(p) = 'object'
    and octet_length(p::text) <= 2048
    and (p -> 'v') = '1'::jsonb
    and jsonb_typeof(p -> 'epk') = 'object'
    and jsonb_typeof(p -> 'iv') = 'string'
    and jsonb_typeof(p -> 'ct') = 'string',
    false
  );
end;
$$;

-- RLS helper (callable): does the caller have an ACTIVE row in the space?
-- SECURITY DEFINER, so the policy on space_members does not recurse.
create or replace function public.is_active_space_member(p_space_id uuid)
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
  return exists (
    select 1
      from public.space_members m
     where m.space_id = p_space_id
       and m.user_id = auth.uid()
       and m.status = 'active'
  );
end;
$$;

-- ── Table privileges and policies ───────────────────────────────────────────
-- Supabase grants everything on new public tables to anon and authenticated by
-- default, so the revokes matter. Active members read their space's rows
-- (members with public keys and emails only through get_my_space, events, the
-- space row) and only their own wrapped keys. A pending user sees no row at
-- all. space_invites and space_records get no grant and no policy: they are
-- reached only through the functions below.

revoke all on table
  public.spaces,
  public.space_members,
  public.space_invites,
  public.space_keys,
  public.space_records,
  public.space_events
from public, anon, authenticated;

revoke all on sequence public.space_events_id_seq from public, anon, authenticated;

grant select on table
  public.spaces,
  public.space_members,
  public.space_keys,
  public.space_events
to authenticated;

drop policy if exists spaces_select_member on public.spaces;
create policy spaces_select_member on public.spaces
  for select to authenticated
  using (public.is_active_space_member(id));

drop policy if exists space_members_select_member on public.space_members;
create policy space_members_select_member on public.space_members
  for select to authenticated
  using (public.is_active_space_member(space_id));

drop policy if exists space_events_select_member on public.space_events;
create policy space_events_select_member on public.space_events
  for select to authenticated
  using (public.is_active_space_member(space_id));

drop policy if exists space_keys_select_own on public.space_keys;
create policy space_keys_select_own on public.space_keys
  for select to authenticated
  using (user_id = auth.uid() and public.is_active_space_member(space_id));

-- ── Status ──────────────────────────────────────────────────────────────────

-- Run 2's get_sync_status plus one key, 'space': the caller's membership
-- (pending or active) with whether the space is paused, or null.
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
  v_space jsonb;
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

  select jsonb_build_object(
           'space_id', m.space_id,
           'role', m.role,
           'status', m.status,
           'paused', not public.has_feature_for(s.owner_id, 'shared_spaces')
         )
    into v_space
    from public.space_members m
    join public.spaces s on s.id = m.space_id
   where m.user_id = v_uid;

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
    'devices_count', v_devices,
    'space', v_space
  );
end;
$$;

-- ── Account deletion ────────────────────────────────────────────────────────

-- Before an auth user is deleted: a non-owner membership (pending or active)
-- leaves a 'left' event with the user as actor. The FK cascade then removes the
-- member row and the keys. For an owner nothing is written: spaces.owner_id
-- cascades the whole space.
create or replace function public.space_member_left_on_user_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.space_events (space_id, kind, actor_id)
  select m.space_id, 'left', old.id
    from public.space_members m
   where m.user_id = old.id
     and m.role = 'member';
  return old;
end;
$$;

drop trigger if exists space_member_left_on_user_delete on auth.users;
create trigger space_member_left_on_user_delete
  before delete on auth.users
  for each row
  execute function public.space_member_left_on_user_delete();

-- ── Membership ──────────────────────────────────────────────────────────────

-- The caller's membership (pending or active, any space), or SQL null. A
-- pending user gets only their own status: no members, keys, invites, limits
-- or totals. Works while paused.
create or replace function public.get_my_space()
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.space_members%rowtype;
  v_space public.spaces%rowtype;
  v_paused boolean;
  v_members jsonb;
  v_keys jsonb;
  v_invites jsonb;
  v_limits jsonb;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;

  select * into v_me from public.space_members m where m.user_id = v_uid;
  if not found then
    return null;
  end if;
  select * into v_space from public.spaces s where s.id = v_me.space_id;
  v_paused := not public.has_feature_for(v_space.owner_id, 'shared_spaces');

  if v_me.status <> 'active' then
    return jsonb_build_object(
      'space_id', v_me.space_id,
      'role', v_me.role,
      'status', v_me.status,
      'key_version', null,
      'owner_id', null,
      'members', '[]'::jsonb,
      'my_keys', '[]'::jsonb,
      'open_invites', '[]'::jsonb,
      'paused', v_paused,
      'limits', null,
      'last_seq', null,
      'record_count', null,
      'total_bytes', null
    );
  end if;

  select coalesce(
           jsonb_agg(
             jsonb_build_object(
               'user_id', m.user_id,
               'email', u.email,
               'role', m.role,
               'status', m.status,
               'public_key', m.public_key,
               'requested_at', m.requested_at,
               'joined_at', m.joined_at
             )
             order by (m.role = 'owner') desc, m.requested_at, m.user_id
           ),
           '[]'::jsonb
         )
    into v_members
    from public.space_members m
    left join auth.users u on u.id = m.user_id
   where m.space_id = v_me.space_id;

  select coalesce(
           jsonb_agg(
             jsonb_build_object('key_version', k.key_version, 'wrapped_key', k.wrapped_key)
             order by k.key_version
           ),
           '[]'::jsonb
         )
    into v_keys
    from public.space_keys k
   where k.space_id = v_me.space_id and k.user_id = v_uid;

  if v_me.role = 'owner' then
    select coalesce(
             jsonb_agg(
               jsonb_build_object('id', i.id, 'expires_at', i.expires_at)
               order by i.created_at, i.id
             ),
             '[]'::jsonb
           )
      into v_invites
      from public.space_invites i
     where i.space_id = v_me.space_id
       and i.used_at is null
       and i.revoked_at is null
       and i.expires_at > now();
  else
    v_invites := '[]'::jsonb;
  end if;

  select p.features into v_limits
    from public.plans p
   where p.id = public.effective_plan_for(v_space.owner_id);

  return jsonb_build_object(
    'space_id', v_me.space_id,
    'role', v_me.role,
    'status', v_me.status,
    'key_version', v_space.key_version,
    'owner_id', v_space.owner_id,
    'members', v_members,
    'my_keys', v_keys,
    'open_invites', v_invites,
    'paused', v_paused,
    'limits', v_limits,
    'last_seq', v_space.last_seq,
    'record_count', v_space.record_count,
    'total_bytes', v_space.total_bytes
  );
end;
$$;

-- Creates a space owned by the caller with key version 1. The space id is
-- generated by the client. CONTRACT_GAP (D6): without the shared_spaces
-- feature this raises sync_not_included; a space id that is already taken is
-- invalid_input.
create or replace function public.create_space(
  p_space_id uuid,
  p_public_key jsonb,
  p_wrapped_key_for_self jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  if not public.has_feature_for(v_uid, 'shared_spaces') then
    raise exception 'MINIMA:%', 'sync_not_included';
  end if;
  if p_space_id is null
     or not public.is_valid_public_jwk(p_public_key)
     or not public.is_valid_wrapped_key(p_wrapped_key_for_self) then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if exists (select 1 from public.space_members m where m.user_id = v_uid) then
    raise exception 'MINIMA:%', 'already_in_space';
  end if;
  if exists (select 1 from public.spaces s where s.id = p_space_id) then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  insert into public.spaces (id, owner_id) values (p_space_id, v_uid);
  insert into public.space_members (space_id, user_id, role, status, public_key, joined_at)
  values (p_space_id, v_uid, 'owner', 'active', p_public_key, now());
  insert into public.space_keys (space_id, user_id, key_version, wrapped_key)
  values (p_space_id, v_uid, 1, p_wrapped_key_for_self);
  insert into public.space_events (space_id, kind, actor_id)
  values (p_space_id, 'created', v_uid);

  return jsonb_build_object('space_id', p_space_id, 'key_version', 1);
end;
$$;

-- ── Invites ─────────────────────────────────────────────────────────────────

-- Stores an invite: only the SHA-256 hex of the invite token, never the token
-- or the secret. Owner only, paused-gated. Expiry 1..168 hours (default 48).
-- CONTRACT_GAP (D6): a 6th open invite (unused, unrevoked, unexpired) raises
-- quota_exceeded.
create or replace function public.create_invite(
  p_space_id uuid,
  p_token_hash text,
  p_expires_in_hours int default 48
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_space public.spaces%rowtype;
  v_me public.space_members%rowtype;
  v_open int;
  v_id uuid;
  v_expires timestamptz;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_space from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;
  if not public.has_feature_for(v_space.owner_id, 'shared_spaces') then
    raise exception 'MINIMA:%', 'space_paused';
  end if;
  if p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$'
     or p_expires_in_hours is null or p_expires_in_hours not between 1 and 168 then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  select count(*) into v_open
    from public.space_invites i
   where i.space_id = p_space_id
     and i.used_at is null
     and i.revoked_at is null
     and i.expires_at > now();
  if v_open >= 5 then
    raise exception 'MINIMA:%', 'quota_exceeded';
  end if;

  insert into public.space_invites (space_id, created_by, token_hash, expires_at)
  values (p_space_id, v_uid, p_token_hash, now() + make_interval(hours => p_expires_in_hours))
  returning id, expires_at into v_id, v_expires;
  insert into public.space_events (space_id, kind, actor_id)
  values (p_space_id, 'invite_created', v_uid);

  return jsonb_build_object('invite_id', v_id, 'expires_at', v_expires);
end;
$$;

-- Revokes an invite (idempotent: the first revocation time is kept and the
-- event is written once). Owner only. Works while paused.
create or replace function public.revoke_invite(p_invite_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.space_invites%rowtype;
  v_me public.space_members%rowtype;
  v_revoked timestamptz;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_invite from public.space_invites i where i.id = p_invite_id for update;
  if not found then
    raise exception 'MINIMA:%', 'invite_invalid';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = v_invite.space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;

  if v_invite.revoked_at is null then
    update public.space_invites i
       set revoked_at = now()
     where i.id = p_invite_id
    returning i.revoked_at into v_revoked;
    insert into public.space_events (space_id, kind, actor_id)
    values (v_invite.space_id, 'invite_revoked', v_uid);
  else
    v_revoked := v_invite.revoked_at;
  end if;

  return jsonb_build_object('invite_id', p_invite_id, 'revoked_at', v_revoked);
end;
$$;

-- What an invite link leads to, for any signed-in user holding the token.
-- Every problem with the invite (unknown, wrong or empty token, used, revoked,
-- expired) is the same invite_invalid. Paused-gated. Uses nothing up.
create or replace function public.get_invite(p_invite_id uuid, p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.space_invites%rowtype;
  v_found boolean;
  v_space public.spaces%rowtype;
  v_email text;
  v_count int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_invite from public.space_invites i where i.id = p_invite_id;
  v_found := found;
  if not coalesce(
    v_found
    and p_token is not null
    and p_token <> ''
    and v_invite.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and v_invite.used_at is null
    and v_invite.revoked_at is null
    and v_invite.expires_at > now(),
    false
  ) then
    raise exception 'MINIMA:%', 'invite_invalid';
  end if;

  select * into v_space from public.spaces s where s.id = v_invite.space_id;
  if not public.has_feature_for(v_space.owner_id, 'shared_spaces') then
    raise exception 'MINIMA:%', 'space_paused';
  end if;

  select u.email into v_email from auth.users u where u.id = v_space.owner_id;
  select count(*) into v_count
    from public.space_members m
   where m.space_id = v_space.id and m.status = 'active';

  return jsonb_build_object(
    'space_id', v_space.id,
    'owner_email', v_email,
    'members_count', v_count,
    'expires_at', v_invite.expires_at
  );
end;
$$;

-- Asks to join with an invite and the caller's identity public key. The
-- caller becomes a pending member (no key, no data) and the invite is used up,
-- even if the request is later rejected. Paused-gated. The member limit counts
-- active and pending members against the owner's max_members.
create or replace function public.request_join(
  p_invite_id uuid,
  p_token text,
  p_public_key jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_invite public.space_invites%rowtype;
  v_found boolean;
  v_space public.spaces%rowtype;
  v_max int;
  v_count int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_invite from public.space_invites i where i.id = p_invite_id for update;
  v_found := found;
  if not coalesce(
    v_found
    and p_token is not null
    and p_token <> ''
    and v_invite.token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex')
    and v_invite.used_at is null
    and v_invite.revoked_at is null
    and v_invite.expires_at > now(),
    false
  ) then
    raise exception 'MINIMA:%', 'invite_invalid';
  end if;

  select * into v_space from public.spaces s where s.id = v_invite.space_id for update;
  if not public.has_feature_for(v_space.owner_id, 'shared_spaces') then
    raise exception 'MINIMA:%', 'space_paused';
  end if;
  if not public.is_valid_public_jwk(p_public_key) then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if exists (select 1 from public.space_members m where m.user_id = v_uid) then
    raise exception 'MINIMA:%', 'already_in_space';
  end if;

  select coalesce((p.features ->> 'max_members')::int, 0) into v_max
    from public.plans p
   where p.id = public.effective_plan_for(v_space.owner_id);
  select count(*) into v_count
    from public.space_members m
   where m.space_id = v_space.id;
  if v_count >= coalesce(v_max, 0) then
    raise exception 'MINIMA:%', 'member_limit';
  end if;

  insert into public.space_members (space_id, user_id, role, status, public_key, invite_id)
  values (v_space.id, v_uid, 'member', 'pending', p_public_key, p_invite_id);
  update public.space_invites i
     set used_by = v_uid,
         used_at = now()
   where i.id = p_invite_id;
  insert into public.space_events (space_id, kind, actor_id)
  values (v_space.id, 'join_requested', v_uid);

  return jsonb_build_object('space_id', v_space.id, 'status', 'pending');
end;
$$;

-- ── Owner actions ───────────────────────────────────────────────────────────
-- CONTRACT_GAP (D6): a target user without a row of the needed kind in this
-- space raises not_space_member.

-- Approves a pending member with the current space key wrapped for their
-- public key. Owner only, paused-gated. The member limit (active members) is
-- checked again here.
create or replace function public.approve_member(
  p_space_id uuid,
  p_user_id uuid,
  p_key_version int,
  p_wrapped_key jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_space public.spaces%rowtype;
  v_me public.space_members%rowtype;
  v_max int;
  v_count int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_space from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;
  if not public.has_feature_for(v_space.owner_id, 'shared_spaces') then
    raise exception 'MINIMA:%', 'space_paused';
  end if;
  perform 1
     from public.space_members m
    where m.space_id = p_space_id and m.user_id = p_user_id and m.status = 'pending'
      for update;
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if p_key_version is null or not public.is_valid_wrapped_key(p_wrapped_key) then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if p_key_version <> v_space.key_version then
    raise exception 'MINIMA:%', 'wrong_key_version';
  end if;

  select coalesce((p.features ->> 'max_members')::int, 0) into v_max
    from public.plans p
   where p.id = public.effective_plan_for(v_space.owner_id);
  select count(*) into v_count
    from public.space_members m
   where m.space_id = p_space_id and m.status = 'active';
  if v_count >= coalesce(v_max, 0) then
    raise exception 'MINIMA:%', 'member_limit';
  end if;

  update public.space_members m
     set status = 'active',
         joined_at = now()
   where m.space_id = p_space_id and m.user_id = p_user_id;
  insert into public.space_keys (space_id, user_id, key_version, wrapped_key)
  values (p_space_id, p_user_id, p_key_version, p_wrapped_key)
  on conflict (space_id, user_id, key_version) do update
    set wrapped_key = excluded.wrapped_key,
        created_at = now();
  insert into public.space_events (space_id, kind, actor_id, subject_id)
  values (p_space_id, 'approved', v_uid, p_user_id);

  return jsonb_build_object('user_id', p_user_id, 'status', 'active', 'key_version', p_key_version);
end;
$$;

-- Rejects a pending request. The invite stays used. Owner only. Works while
-- paused.
create or replace function public.reject_member(p_space_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.space_members%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  perform 1 from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;

  delete from public.space_members m
   where m.space_id = p_space_id and m.user_id = p_user_id and m.status = 'pending';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  insert into public.space_events (space_id, kind, actor_id, subject_id)
  values (p_space_id, 'rejected', v_uid, p_user_id);

  return jsonb_build_object('user_id', p_user_id);
end;
$$;

-- Removes a member (active or pending) and all of their wrapped keys in this
-- space, so they lose server access at once. The owner then rotates the key.
-- Owner only. Works while paused.
create or replace function public.remove_member(p_space_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.space_members%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  perform 1 from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;
  if p_user_id = v_uid then
    raise exception 'MINIMA:%', 'cannot_remove_owner';
  end if;

  delete from public.space_members m
   where m.space_id = p_space_id and m.user_id = p_user_id;
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  delete from public.space_keys k
   where k.space_id = p_space_id and k.user_id = p_user_id;
  insert into public.space_events (space_id, kind, actor_id, subject_id)
  values (p_space_id, 'removed', v_uid, p_user_id);

  return jsonb_build_object('user_id', p_user_id);
end;
$$;

-- Uploads a new space key version wrapped for every active member (owner
-- included) in one transaction. p_new_version must be key_version + 1, and the
-- set of wrap user ids must equal the set of active members exactly. Old
-- space_keys rows are kept (older records stay readable). Owner only. Works
-- while paused.
create or replace function public.rotate_space_key(
  p_space_id uuid,
  p_new_version int,
  p_wraps jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_space public.spaces%rowtype;
  v_me public.space_members%rowtype;
  v_elem jsonb;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_space from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;

  if p_new_version is null or p_wraps is null or jsonb_typeof(p_wraps) <> 'array' then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  -- One check per statement, so the uuid cast never runs on a bad value.
  for v_elem in select e.value from jsonb_array_elements(p_wraps) as e(value) loop
    if jsonb_typeof(v_elem) <> 'object' then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if jsonb_typeof(v_elem -> 'user_id') is distinct from 'string'
       or (v_elem ->> 'user_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
    if not public.is_valid_wrapped_key(v_elem -> 'wrapped_key') then
      raise exception 'MINIMA:%', 'invalid_input';
    end if;
  end loop;
  if (select count(distinct (e.value ->> 'user_id')::uuid) <> count(*)
        from jsonb_array_elements(p_wraps) as e(value)) then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  if p_new_version <> v_space.key_version + 1 then
    raise exception 'MINIMA:%', 'wrong_key_version';
  end if;

  if exists (
       select m.user_id
         from public.space_members m
        where m.space_id = p_space_id and m.status = 'active'
       except
       select (e.value ->> 'user_id')::uuid
         from jsonb_array_elements(p_wraps) as e(value)
     )
     or exists (
       select (e.value ->> 'user_id')::uuid
         from jsonb_array_elements(p_wraps) as e(value)
       except
       select m.user_id
         from public.space_members m
        where m.space_id = p_space_id and m.status = 'active'
     ) then
    raise exception 'MINIMA:%', 'members_mismatch';
  end if;

  insert into public.space_keys (space_id, user_id, key_version, wrapped_key)
  select p_space_id, (e.value ->> 'user_id')::uuid, p_new_version, e.value -> 'wrapped_key'
    from jsonb_array_elements(p_wraps) as e(value);
  update public.spaces s
     set key_version = p_new_version,
         updated_at = now()
   where s.id = p_space_id;
  insert into public.space_events (space_id, kind, actor_id)
  values (p_space_id, 'key_rotated', v_uid);

  return jsonb_build_object('space_id', p_space_id, 'key_version', p_new_version);
end;
$$;

-- Leaves the caller's space (also withdraws a pending request) and drops their
-- wrapped keys. The owner must transfer ownership or delete the space first.
-- Works while paused.
create or replace function public.leave_space()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.space_members%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_me from public.space_members m where m.user_id = v_uid;
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role = 'owner' then
    raise exception 'MINIMA:%', 'owner_must_transfer_or_delete';
  end if;

  perform 1 from public.spaces s where s.id = v_me.space_id for update;
  delete from public.space_members m
   where m.space_id = v_me.space_id and m.user_id = v_uid;
  delete from public.space_keys k
   where k.space_id = v_me.space_id and k.user_id = v_uid;
  insert into public.space_events (space_id, kind, actor_id)
  values (v_me.space_id, 'left', v_uid);

  return jsonb_build_object('space_id', v_me.space_id);
end;
$$;

-- Makes another active member the owner; the caller becomes a member. Two
-- statements, so the one-owner index never sees two owners. CONTRACT_GAP (D6):
-- a transfer to oneself is invalid_input. Owner only. Works while paused.
create or replace function public.transfer_ownership(p_space_id uuid, p_user_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.space_members%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  perform 1 from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;
  if p_user_id = v_uid then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  perform 1
     from public.space_members m
    where m.space_id = p_space_id and m.user_id = p_user_id and m.status = 'active'
      for update;
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;

  update public.space_members m
     set role = 'member'
   where m.space_id = p_space_id and m.user_id = v_uid;
  update public.space_members m
     set role = 'owner'
   where m.space_id = p_space_id and m.user_id = p_user_id;
  update public.spaces s
     set owner_id = p_user_id,
         updated_at = now()
   where s.id = p_space_id;
  insert into public.space_events (space_id, kind, actor_id, subject_id)
  values (p_space_id, 'ownership_transferred', v_uid, p_user_id);

  return jsonb_build_object('space_id', p_space_id, 'owner_id', p_user_id);
end;
$$;

-- Deletes the space; the cascade removes its members, invites, keys, records
-- and events. Owner only. Works while paused.
create or replace function public.delete_space(p_space_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_me public.space_members%rowtype;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  perform 1 from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  select * into v_me
    from public.space_members m
   where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active';
  if not found then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if v_me.role <> 'owner' then
    raise exception 'MINIMA:%', 'not_space_owner';
  end if;

  delete from public.spaces s where s.id = p_space_id;

  return jsonb_build_object('space_id', p_space_id);
end;
$$;

-- ── Records ─────────────────────────────────────────────────────────────────

-- Writes a batch of encrypted Family records. The space row is locked first,
-- so seq order equals commit order per space. A record is written when it is
-- new, when its updated_at_ms is strictly newer, or when it is equal and
-- p_key_version is newer than the stored key_version (re-encryption after a
-- rotation); otherwise it is 'stale' and the stored row comes back. A push
-- with any version other than the current one raises
-- MINIMA:key_outdated:<current> before the records are looked at. Quotas are
-- the owner's. Any error rolls back the batch. Paused-gated.
create or replace function public.push_space_records(
  p_space_id uuid,
  p_device_id uuid,
  p_key_version int,
  p_records jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_space public.spaces%rowtype;
  v_removed timestamptz;
  v_features jsonb;
  v_elem jsonb;
  v_num numeric;
  v_chars bigint;
  v_key text;
  v_ct text;
  v_iv text;
  v_ms bigint;
  v_size int;
  v_old public.space_records%rowtype;
  v_seq bigint;
  v_record_count bigint;
  v_total_bytes bigint;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_space from public.spaces s where s.id = p_space_id for update;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  if not exists (
    select 1
      from public.space_members m
     where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active'
  ) then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if not public.has_feature_for(v_space.owner_id, 'shared_spaces') then
    raise exception 'MINIMA:%', 'space_paused';
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

  if p_key_version is null then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;
  if p_key_version <> v_space.key_version then
    raise exception 'MINIMA:key_outdated:%', v_space.key_version;
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

  -- Validate every element before writing anything (exactly as run 2). One
  -- check per statement, so a cast never runs on a value that failed its type
  -- check.
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

  v_seq := v_space.last_seq;
  v_record_count := v_space.record_count;
  v_total_bytes := v_space.total_bytes;

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
      from public.space_records r
     where r.space_id = p_space_id and r.record_key = v_key
       for update;

    if not found then
      v_seq := v_seq + 1;
      insert into public.space_records (
        space_id, record_key, key_version, ciphertext, iv, enc_v,
        updated_at_ms, author_id, device_id, seq, size
      )
      values (
        p_space_id, v_key, p_key_version, v_ct, v_iv, 1,
        v_ms, v_uid, p_device_id, v_seq, v_size
      );
      v_record_count := v_record_count + 1;
      v_total_bytes := v_total_bytes + v_size;
      v_results := v_results || jsonb_build_array(
        jsonb_build_object('record_key', v_key, 'status', 'accepted', 'seq', v_seq)
      );
    elsif v_ms > v_old.updated_at_ms
          or (v_ms = v_old.updated_at_ms and p_key_version > v_old.key_version) then
      v_seq := v_seq + 1;
      update public.space_records r
         set ciphertext = v_ct,
             iv = v_iv,
             enc_v = 1,
             updated_at_ms = v_ms,
             key_version = p_key_version,
             author_id = v_uid,
             device_id = p_device_id,
             size = v_size,
             seq = v_seq,
             server_updated_at = now()
       where r.space_id = p_space_id and r.record_key = v_key;
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
            'key_version', v_old.key_version,
            'author_id', v_old.author_id,
            'device_id', v_old.device_id,
            'seq', v_old.seq
          )
        )
      );
    end if;
  end loop;

  select p.features into v_features
    from public.plans p
   where p.id = public.effective_plan_for(v_space.owner_id);
  if v_record_count > coalesce((v_features ->> 'max_space_records')::bigint, 0)
     or v_total_bytes > coalesce((v_features ->> 'max_space_bytes')::bigint, 0) then
    raise exception 'MINIMA:%', 'quota_exceeded';
  end if;

  update public.spaces s
     set last_seq = v_seq,
         record_count = v_record_count,
         total_bytes = v_total_bytes,
         updated_at = now()
   where s.id = p_space_id;
  update public.devices d
     set last_seen_at = now()
   where d.user_id = v_uid and d.device_id = p_device_id;

  return jsonb_build_object('results', v_results, 'last_seq', v_seq);
end;
$$;

-- The space's records with seq > p_since, in seq order, at most p_limit.
-- Paused-gated.
create or replace function public.pull_space_records(
  p_space_id uuid,
  p_device_id uuid,
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
  v_space public.spaces%rowtype;
  v_removed timestamptz;
  v_records jsonb;
  v_found int;
begin
  if v_uid is null then
    raise exception 'MINIMA:%', 'not_signed_in';
  end if;
  select * into v_space from public.spaces s where s.id = p_space_id;
  if not found then
    raise exception 'MINIMA:%', 'space_gone';
  end if;
  if not exists (
    select 1
      from public.space_members m
     where m.space_id = p_space_id and m.user_id = v_uid and m.status = 'active'
  ) then
    raise exception 'MINIMA:%', 'not_space_member';
  end if;
  if not public.has_feature_for(v_space.owner_id, 'shared_spaces') then
    raise exception 'MINIMA:%', 'space_paused';
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
  if p_since is null or p_since < 0
     or p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'MINIMA:%', 'invalid_input';
  end if;

  select count(*) into v_found
    from (
      select 1
        from public.space_records r
       where r.space_id = p_space_id and r.seq > p_since
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
               'key_version', s.key_version,
               'author_id', s.author_id,
               'device_id', s.device_id,
               'seq', s.seq
             )
             order by s.seq
           ),
           '[]'::jsonb
         )
    into v_records
    from (
      select r.record_key, r.ciphertext, r.iv, r.enc_v, r.updated_at_ms,
             r.key_version, r.author_id, r.device_id, r.seq
        from public.space_records r
       where r.space_id = p_space_id and r.seq > p_since
       order by r.seq
       limit p_limit
    ) as s;

  update public.devices d
     set last_seen_at = now()
   where d.user_id = v_uid and d.device_id = p_device_id;

  return jsonb_build_object(
    'records', v_records,
    'has_more', v_found > p_limit,
    'last_seq', v_space.last_seq,
    'key_version', v_space.key_version
  );
end;
$$;

-- ── Function privileges ─────────────────────────────────────────────────────

-- Run 2's functions redefined above keep their grants.
revoke all on function public.effective_plan() from public, anon, authenticated;
grant execute on function public.effective_plan() to authenticated;

revoke all on function public.has_feature(text) from public, anon, authenticated;
grant execute on function public.has_feature(text) to authenticated;

revoke all on function public.get_sync_status() from public, anon, authenticated;
grant execute on function public.get_sync_status() to authenticated;

-- Internal: nobody may call these directly.
revoke all on function public.effective_plan_for(uuid) from public, anon, authenticated;
revoke all on function public.has_feature_for(uuid, text) from public, anon, authenticated;
revoke all on function public.is_valid_public_jwk(jsonb) from public, anon, authenticated;
revoke all on function public.is_valid_wrapped_key(jsonb) from public, anon, authenticated;
revoke all on function public.space_member_left_on_user_delete() from public, anon, authenticated;

-- Callable: authenticated only.
revoke all on function public.is_active_space_member(uuid) from public, anon, authenticated;
grant execute on function public.is_active_space_member(uuid) to authenticated;

revoke all on function public.get_my_space() from public, anon, authenticated;
grant execute on function public.get_my_space() to authenticated;

revoke all on function public.create_space(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.create_space(uuid, jsonb, jsonb) to authenticated;

revoke all on function public.create_invite(uuid, text, int) from public, anon, authenticated;
grant execute on function public.create_invite(uuid, text, int) to authenticated;

revoke all on function public.revoke_invite(uuid) from public, anon, authenticated;
grant execute on function public.revoke_invite(uuid) to authenticated;

revoke all on function public.get_invite(uuid, text) from public, anon, authenticated;
grant execute on function public.get_invite(uuid, text) to authenticated;

revoke all on function public.request_join(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.request_join(uuid, text, jsonb) to authenticated;

revoke all on function public.approve_member(uuid, uuid, int, jsonb) from public, anon, authenticated;
grant execute on function public.approve_member(uuid, uuid, int, jsonb) to authenticated;

revoke all on function public.reject_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reject_member(uuid, uuid) to authenticated;

revoke all on function public.remove_member(uuid, uuid) from public, anon, authenticated;
grant execute on function public.remove_member(uuid, uuid) to authenticated;

revoke all on function public.rotate_space_key(uuid, int, jsonb) from public, anon, authenticated;
grant execute on function public.rotate_space_key(uuid, int, jsonb) to authenticated;

revoke all on function public.leave_space() from public, anon, authenticated;
grant execute on function public.leave_space() to authenticated;

revoke all on function public.transfer_ownership(uuid, uuid) from public, anon, authenticated;
grant execute on function public.transfer_ownership(uuid, uuid) to authenticated;

revoke all on function public.delete_space(uuid) from public, anon, authenticated;
grant execute on function public.delete_space(uuid) to authenticated;

revoke all on function public.push_space_records(uuid, uuid, int, jsonb) from public, anon, authenticated;
grant execute on function public.push_space_records(uuid, uuid, int, jsonb) to authenticated;

revoke all on function public.pull_space_records(uuid, uuid, bigint, int) from public, anon, authenticated;
grant execute on function public.pull_space_records(uuid, uuid, bigint, int) to authenticated;

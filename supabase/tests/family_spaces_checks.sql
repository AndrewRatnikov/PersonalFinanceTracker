-- Manual checks for supabase/migrations/20261029000000_family_spaces.sql.
--
-- Run it in the Supabase SQL editor after the migration (and after
-- supabase/tests/sync_server_checks.sql). Everything happens in one
-- transaction that is rolled back at the end, so nothing is left behind. Any
-- failed expectation raises "CHECK FAILED: <name>" and stops the script; a
-- clean run ends with the notice "family_spaces_checks: all checks passed".
--
-- Four throwaway auth users are created with fixed ids:
--   owner     = 00000000-0000-4000-8000-0000000000f1
--   member B  = 00000000-0000-4000-8000-0000000000f2
--   member C  = 00000000-0000-4000-8000-0000000000f3
--   outsider  = 00000000-0000-4000-8000-0000000000f4
-- The owner, B and C get a 'family' entitlement inside the transaction, so
-- the round trip does not depend on the beta switch. Roles are switched with
-- SET LOCAL ROLE plus the request.jwt.claim.sub setting that auth.uid() reads.
-- Invite ids travel between the steps in the transaction-local settings
-- family_check.invite_b / family_check.invite_c.
--
-- Round trip: create -> invite -> join -> approve -> push -> remove ->
-- rotate -> the removed member's pull is refused.

begin;

-- ── As the owner: plan seeds, RLS, privileges, test users ───────────────────

do $$
declare
  v_count int;
  v_callable text[] := array[
    'is_active_space_member', 'get_my_space', 'create_space', 'create_invite',
    'revoke_invite', 'get_invite', 'request_join', 'approve_member',
    'reject_member', 'remove_member', 'rotate_space_key', 'leave_space',
    'transfer_ownership', 'delete_space', 'push_space_records', 'pull_space_records'
  ];
  v_internal text[] := array[
    'effective_plan_for', 'has_feature_for', 'is_valid_public_jwk',
    'is_valid_wrapped_key', 'space_member_left_on_user_delete'
  ];
  v_tables text[] := array[
    'spaces', 'space_members', 'space_invites', 'space_keys', 'space_records', 'space_events'
  ];
begin
  if not (select features @> '{"sync": false, "max_devices": 0, "shared_spaces": false}'::jsonb
            from public.plans where id = 'free') then
    raise exception 'CHECK FAILED: %', 'plan free gained shared_spaces false';
  end if;
  if not (select features @> '{"sync": true, "max_devices": 5, "max_records": 100000, "max_bytes": 104857600,
                               "shared_spaces": true, "max_members": 6, "max_space_records": 100000,
                               "max_space_bytes": 104857600}'::jsonb
            from public.plans where id = 'beta') then
    raise exception 'CHECK FAILED: %', 'plan beta gained the family keys';
  end if;
  if not (select features @> '{"sync": true, "max_devices": 10, "shared_spaces": false}'::jsonb
            from public.plans where id = 'sync') then
    raise exception 'CHECK FAILED: %', 'plan sync gained shared_spaces false';
  end if;
  if not coalesce(
    (select features @> '{"sync": true, "max_devices": 10, "max_records": 200000, "max_bytes": 209715200,
                          "shared_spaces": true, "max_members": 6, "max_space_records": 100000,
                          "max_space_bytes": 104857600}'::jsonb
              and not is_public
       from public.plans where id = 'family'),
    false
  ) then
    raise exception 'CHECK FAILED: %', 'plan family exists and is not public';
  end if;

  select count(*) into v_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname = any(v_tables)
     and c.relrowsecurity;
  if v_count <> 6 then
    raise exception 'CHECK FAILED: %', 'row level security on all six tables';
  end if;

  select count(*) into v_count
    from unnest(v_tables) as t(name)
   where has_table_privilege('anon', 'public.' || t.name, 'SELECT')
      or has_table_privilege('anon', 'public.' || t.name, 'INSERT')
      or has_table_privilege('anon', 'public.' || t.name, 'UPDATE')
      or has_table_privilege('anon', 'public.' || t.name, 'DELETE')
      or has_table_privilege('authenticated', 'public.' || t.name, 'INSERT')
      or has_table_privilege('authenticated', 'public.' || t.name, 'UPDATE')
      or has_table_privilege('authenticated', 'public.' || t.name, 'DELETE');
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'anon has no table privilege, authenticated cannot write';
  end if;
  if has_table_privilege('authenticated', 'public.space_invites', 'SELECT')
     or has_table_privilege('authenticated', 'public.space_records', 'SELECT') then
    raise exception 'CHECK FAILED: %', 'space_invites and space_records are functions only';
  end if;

  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any(v_callable)
     and p.prosecdef
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_count <> 16 then
    raise exception 'CHECK FAILED: %', 'anon executes none of the 16 functions, authenticated all';
  end if;

  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname = any(v_internal)
     and p.prosecdef
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and not has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_count <> 5 then
    raise exception 'CHECK FAILED: %', 'the 5 internal functions are executable by nobody';
  end if;

  if not exists (
    select 1 from pg_trigger t
     where t.tgrelid = 'auth.users'::regclass
       and t.tgname = 'space_member_left_on_user_delete'
  ) then
    raise exception 'CHECK FAILED: %', 'the account deletion trigger exists';
  end if;

  insert into auth.users (id, email)
  values
    ('00000000-0000-4000-8000-0000000000f1', 'family-check-owner@example.com'),
    ('00000000-0000-4000-8000-0000000000f2', 'family-check-b@example.com'),
    ('00000000-0000-4000-8000-0000000000f3', 'family-check-c@example.com'),
    ('00000000-0000-4000-8000-0000000000f4', 'family-check-outsider@example.com');
  insert into public.entitlements (user_id, plan_id, status, source)
  values
    ('00000000-0000-4000-8000-0000000000f1', 'family', 'active', 'manual'),
    ('00000000-0000-4000-8000-0000000000f2', 'family', 'active', 'manual'),
    ('00000000-0000-4000-8000-0000000000f3', 'family', 'active', 'manual');
end
$$;

-- ── As the owner: create the space and two invites ──────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f1', true);

do $$
declare
  v_res jsonb;
begin
  perform public.register_device('00000000-0000-4000-8000-0000000001f1'::uuid, 'Check owner');
  v_res := public.create_space(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    '{"kty": "EC", "crv": "P-256", "x": "b3duZXJ4", "y": "b3duZXJ5"}'::jsonb,
    '{"v": 1, "epk": {"kty": "EC", "crv": "P-256", "x": "ZXB4", "y": "ZXB5"}, "iv": "aXZpdml2", "ct": "b3duZXJrZXk="}'::jsonb
  );
  if (v_res ->> 'key_version')::int <> 1 then
    raise exception 'CHECK FAILED: %', 'create_space returns key version 1';
  end if;

  v_res := public.create_invite(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    encode(sha256(convert_to('family-check-token-b', 'UTF8')), 'hex')
  );
  perform set_config('family_check.invite_b', v_res ->> 'invite_id', true);
  v_res := public.create_invite(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    encode(sha256(convert_to('family-check-token-c', 'UTF8')), 'hex'),
    1
  );
  perform set_config('family_check.invite_c', v_res ->> 'invite_id', true);

  begin
    perform 1 from public.space_invites;
    raise exception 'CHECK FAILED: %', 'space_invites is not readable directly';
  exception
    when insufficient_privilege then null;
  end;
end
$$;

reset role;

-- ── As B and C: look at the invite and ask to join ──────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f2', true);

do $$
declare
  v_info jsonb;
  v_count int;
begin
  perform public.register_device('00000000-0000-4000-8000-0000000001f2'::uuid, 'Check B');
  begin
    perform public.get_invite(current_setting('family_check.invite_b')::uuid, 'wrong-token');
    raise exception 'CHECK FAILED: %', 'a wrong token is invite_invalid';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:invite_invalid' then
        raise;
      end if;
  end;
  v_info := public.get_invite(current_setting('family_check.invite_b')::uuid, 'family-check-token-b');
  if v_info ->> 'owner_email' <> 'family-check-owner@example.com'
     or (v_info ->> 'members_count')::int <> 1 then
    raise exception 'CHECK FAILED: %', 'get_invite shows the owner and the member count';
  end if;

  perform public.request_join(
    current_setting('family_check.invite_b')::uuid,
    'family-check-token-b',
    '{"kty": "EC", "crv": "P-256", "x": "Ymh4", "y": "Ymh5"}'::jsonb
  );
  if public.get_my_space() ->> 'status' <> 'pending'
     or jsonb_array_length(public.get_my_space() -> 'members') <> 0 then
    raise exception 'CHECK FAILED: %', 'a pending member sees only their own status';
  end if;
  select count(*) into v_count from public.space_members;
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'a pending member reads no rows';
  end if;
end
$$;

reset role;

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f3', true);

do $$
begin
  perform public.register_device('00000000-0000-4000-8000-0000000001f3'::uuid, 'Check C');
  perform public.request_join(
    current_setting('family_check.invite_c')::uuid,
    'family-check-token-c',
    '{"kty": "EC", "crv": "P-256", "x": "Y2h4", "y": "Y2h5"}'::jsonb
  );
end
$$;

reset role;

-- ── As the owner: approve both, push a record ───────────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f1', true);

do $$
declare
  v_push jsonb;
begin
  begin
    perform public.approve_member(
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      '00000000-0000-4000-8000-0000000000f2'::uuid,
      2,
      '{"v": 1, "epk": {"kty": "EC"}, "iv": "aXY=", "ct": "Y3Q="}'::jsonb
    );
    raise exception 'CHECK FAILED: %', 'approve with another key version is wrong_key_version';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:wrong_key_version' then
        raise;
      end if;
  end;
  perform public.approve_member(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    '00000000-0000-4000-8000-0000000000f2'::uuid,
    1,
    '{"v": 1, "epk": {"kty": "EC", "crv": "P-256", "x": "ZWJ4", "y": "ZWJ5"}, "iv": "aXZiYg==", "ct": "YmtleQ=="}'::jsonb
  );
  perform public.approve_member(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    '00000000-0000-4000-8000-0000000000f3'::uuid,
    1,
    '{"v": 1, "epk": {"kty": "EC", "crv": "P-256", "x": "ZWN4", "y": "ZWN5"}, "iv": "aXZjYw==", "ct": "Y2tleQ=="}'::jsonb
  );

  v_push := public.push_space_records(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    '00000000-0000-4000-8000-0000000001f1'::uuid,
    1,
    jsonb_build_array(jsonb_build_object(
      'record_key', 'familyCheckRecord0001',
      'ciphertext', 'Y2lwaGVydGV4dEY=',
      'iv', 'aXZpdml2aXZpdml2',
      'enc_v', 1,
      'updated_at_ms', 1000
    ))
  );
  if v_push #>> '{results,0,status}' <> 'accepted' or (v_push ->> 'last_seq')::int <> 1 then
    raise exception 'CHECK FAILED: %', 'the owner pushes a record';
  end if;
end
$$;

reset role;

-- ── As B: pull, see own key only ────────────────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f2', true);

do $$
declare
  v_pull jsonb;
  v_count int;
begin
  v_pull := public.pull_space_records(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    '00000000-0000-4000-8000-0000000001f2'::uuid,
    0
  );
  if jsonb_array_length(v_pull -> 'records') <> 1
     or v_pull #>> '{records,0,author_id}' <> '00000000-0000-4000-8000-0000000000f1' then
    raise exception 'CHECK FAILED: %', 'an active member pulls the record with its author';
  end if;
  select count(*) into v_count from public.space_keys;
  if v_count <> 1 then
    raise exception 'CHECK FAILED: %', 'a member reads only their own wrapped key';
  end if;
  select count(*) into v_count from public.space_members;
  if v_count <> 3 then
    raise exception 'CHECK FAILED: %', 'a member reads every member row of the space';
  end if;
  begin
    perform 1 from public.space_records;
    raise exception 'CHECK FAILED: %', 'space_records is not readable directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform public.delete_space('00000000-0000-4000-8000-0000000000e1'::uuid);
    raise exception 'CHECK FAILED: %', 'a member cannot delete the space';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:not_space_owner' then
        raise;
      end if;
  end;
end
$$;

reset role;

-- ── As the owner: remove C and rotate the key ───────────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f1', true);

do $$
declare
  v_res jsonb;
begin
  perform public.remove_member(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    '00000000-0000-4000-8000-0000000000f3'::uuid
  );

  begin
    perform public.rotate_space_key(
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      2,
      jsonb_build_array(jsonb_build_object(
        'user_id', '00000000-0000-4000-8000-0000000000f1',
        'wrapped_key', '{"v": 1, "epk": {"kty": "EC"}, "iv": "aXY=", "ct": "Y3Q="}'::jsonb
      ))
    );
    raise exception 'CHECK FAILED: %', 'a rotation missing a member is members_mismatch';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:members_mismatch' then
        raise;
      end if;
  end;

  v_res := public.rotate_space_key(
    '00000000-0000-4000-8000-0000000000e1'::uuid,
    2,
    jsonb_build_array(
      jsonb_build_object(
        'user_id', '00000000-0000-4000-8000-0000000000f1',
        'wrapped_key', '{"v": 1, "epk": {"kty": "EC"}, "iv": "aXZvMg==", "ct": "bzI="}'::jsonb
      ),
      jsonb_build_object(
        'user_id', '00000000-0000-4000-8000-0000000000f2',
        'wrapped_key', '{"v": 1, "epk": {"kty": "EC"}, "iv": "aXZiMg==", "ct": "YjI="}'::jsonb
      )
    )
  );
  if (v_res ->> 'key_version')::int <> 2 then
    raise exception 'CHECK FAILED: %', 'rotate_space_key raises the key version';
  end if;

  begin
    perform public.push_space_records(
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      '00000000-0000-4000-8000-0000000001f1'::uuid,
      1,
      '[]'::jsonb
    );
    raise exception 'CHECK FAILED: %', 'a push with the old key version is key_outdated';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:key_outdated:2' then
        raise;
      end if;
  end;
end
$$;

reset role;

-- ── As the removed member C: refused at once ────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f3', true);

do $$
declare
  v_count int;
begin
  begin
    perform public.pull_space_records(
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      '00000000-0000-4000-8000-0000000001f3'::uuid,
      0
    );
    raise exception 'CHECK FAILED: %', 'a removed member cannot pull';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:not_space_member' then
        raise;
      end if;
  end;
  if public.get_my_space() is not null then
    raise exception 'CHECK FAILED: %', 'a removed member has no space';
  end if;
  select count(*) into v_count from public.space_keys;
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'a removed member has no wrapped keys';
  end if;
end
$$;

reset role;

-- ── As the outsider: nothing to see ─────────────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-0000000000f4', true);

do $$
declare
  v_count int;
begin
  select count(*) into v_count from public.spaces;
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'an outsider reads no spaces';
  end if;
  select count(*) into v_count from public.space_events;
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'an outsider reads no events';
  end if;
  begin
    perform public.transfer_ownership(
      '00000000-0000-4000-8000-0000000000e1'::uuid,
      '00000000-0000-4000-8000-0000000000f4'::uuid
    );
    raise exception 'CHECK FAILED: %', 'an outsider is not a member';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:not_space_member' then
        raise;
      end if;
  end;
end
$$;

reset role;

-- ── As the owner of the database: deletion ──────────────────────────────────

do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-0000000000f2';
  if not exists (
    select 1 from public.space_events
     where space_id = '00000000-0000-4000-8000-0000000000e1'
       and kind = 'left'
       and actor_id = '00000000-0000-4000-8000-0000000000f2'
  ) then
    raise exception 'CHECK FAILED: %', 'deleting a member account writes a left event';
  end if;

  delete from auth.users where id = '00000000-0000-4000-8000-0000000000f1';
  if exists (select 1 from public.spaces where id = '00000000-0000-4000-8000-0000000000e1')
     or exists (select 1 from public.space_records where space_id = '00000000-0000-4000-8000-0000000000e1')
     or exists (select 1 from public.space_events where space_id = '00000000-0000-4000-8000-0000000000e1') then
    raise exception 'CHECK FAILED: %', 'deleting the owner account deletes the space';
  end if;

  raise notice 'family_spaces_checks: all checks passed';
end
$$;

rollback;

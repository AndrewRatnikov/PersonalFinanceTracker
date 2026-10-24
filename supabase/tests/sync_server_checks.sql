-- Manual checks for supabase/migrations/20261023000000_sync_server.sql.
--
-- Run it in the Supabase SQL editor after the migration. Everything happens in
-- one transaction that is rolled back at the end, so nothing is left behind.
-- Any failed expectation raises "CHECK FAILED: <name>" and stops the script;
-- a clean run ends with the notice "sync_server_checks: all checks passed".
--
-- Two throwaway auth users are created with fixed ids:
--   A = 00000000-0000-4000-8000-00000000000a
--   B = 00000000-0000-4000-8000-00000000000b
-- Roles are switched with SET LOCAL ROLE plus the request.jwt.claim.sub
-- setting that auth.uid() reads.

begin;

-- ── As the owner: seeds, RLS, privileges, test users ────────────────────────

do $$
declare
  v_count int;
begin
  if (select features from public.plans where id = 'free')
       is distinct from '{"sync": false, "max_devices": 0, "max_records": 0, "max_bytes": 0}'::jsonb then
    raise exception 'CHECK FAILED: %', 'seed plan free';
  end if;
  if (select features from public.plans where id = 'beta')
       is distinct from '{"sync": true, "max_devices": 5, "max_records": 100000, "max_bytes": 104857600}'::jsonb then
    raise exception 'CHECK FAILED: %', 'seed plan beta';
  end if;
  if (select features from public.plans where id = 'sync')
       is distinct from '{"sync": true, "max_devices": 10, "max_records": 200000, "max_bytes": 209715200}'::jsonb then
    raise exception 'CHECK FAILED: %', 'seed plan sync';
  end if;
  if (select is_public from public.plans where id = 'sync') is distinct from false then
    raise exception 'CHECK FAILED: %', 'plan sync is not public yet';
  end if;
  if (select value from public.app_config where key = 'sync_free_for_all') is distinct from 'true'::jsonb then
    raise exception 'CHECK FAILED: %', 'sync_free_for_all is true';
  end if;

  select count(*) into v_count
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public'
     and c.relname in ('plans', 'app_config', 'entitlements', 'vaults', 'devices', 'sync_records')
     and c.relrowsecurity;
  if v_count <> 6 then
    raise exception 'CHECK FAILED: %', 'row level security on all six tables';
  end if;

  select count(*) into v_count
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in (
       'effective_plan', 'has_feature', 'get_sync_status', 'register_device',
       'list_devices', 'rename_device', 'remove_device', 'create_vault',
       'get_vault', 'update_vault_header', 'push_records', 'pull_records',
       'delete_cloud_data'
     )
     and p.prosecdef
     and not has_function_privilege('anon', p.oid, 'EXECUTE')
     and has_function_privilege('authenticated', p.oid, 'EXECUTE');
  if v_count <> 13 then
    raise exception 'CHECK FAILED: %', 'anon executes none of the 13 functions, authenticated all';
  end if;

  select count(*) into v_count
    from unnest(array['plans', 'app_config', 'entitlements', 'vaults', 'devices', 'sync_records']) as t(name)
   where has_table_privilege('anon', 'public.' || t.name, 'SELECT')
      or has_table_privilege('anon', 'public.' || t.name, 'INSERT')
      or has_table_privilege('anon', 'public.' || t.name, 'UPDATE')
      or has_table_privilege('anon', 'public.' || t.name, 'DELETE');
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'anon has no table privilege';
  end if;

  select count(*) into v_count
    from unnest(array['plans', 'app_config', 'entitlements', 'vaults', 'devices', 'sync_records']) as t(name)
   where has_table_privilege('authenticated', 'public.' || t.name, 'INSERT')
      or has_table_privilege('authenticated', 'public.' || t.name, 'UPDATE')
      or has_table_privilege('authenticated', 'public.' || t.name, 'DELETE');
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'authenticated cannot write any table';
  end if;

  insert into auth.users (id, email)
  values
    ('00000000-0000-4000-8000-00000000000a', 'sync-check-a@example.com'),
    ('00000000-0000-4000-8000-00000000000b', 'sync-check-b@example.com');
end
$$;

-- ── As user A: beta by default, devices, vault, records, isolation ──────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000a', true);

do $$
declare
  v_status jsonb;
  v_push jsonb;
  v_i int;
  v_count int;
  v_record jsonb := jsonb_build_object(
    'record_key', 'checkRecordKeyA0000001',
    'ciphertext', 'Y2lwaGVydGV4dEE=',
    'iv', 'aXZpdml2aXZpdml2',
    'enc_v', 1,
    'updated_at_ms', 1000
  );
begin
  if public.effective_plan() <> 'beta' then
    raise exception 'CHECK FAILED: %', 'beta by default';
  end if;
  v_status := public.get_sync_status();
  if (v_status ->> 'has_sync')::boolean is distinct from true
     or v_status ->> 'granted_by' <> 'free_for_all' then
    raise exception 'CHECK FAILED: %', 'get_sync_status reports the beta';
  end if;

  for v_i in 1..5 loop
    perform public.register_device(
      ('00000000-0000-4000-8000-0000000000a' || v_i)::uuid,
      'Check device ' || v_i
    );
  end loop;
  if (select beta_joined_at from public.entitlements) is null then
    raise exception 'CHECK FAILED: %', 'register_device records beta_joined_at';
  end if;

  begin
    perform public.register_device('00000000-0000-4000-8000-0000000000a6'::uuid, 'Sixth');
    raise exception 'CHECK FAILED: %', 'the 6th device raises device_limit';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:device_limit' then
        raise;
      end if;
  end;

  perform public.create_vault(
    '00000000-0000-4000-8000-0000000000a1'::uuid,
    'check-vault-a',
    '{"v": 2, "vaultId": "check-vault-a"}'::jsonb
  );
  v_push := public.push_records(
    '00000000-0000-4000-8000-0000000000a1'::uuid,
    'check-vault-a',
    jsonb_build_array(v_record)
  );
  if v_push #>> '{results,0,status}' <> 'accepted' then
    raise exception 'CHECK FAILED: %', 'push accepts a new record';
  end if;

  v_push := public.push_records(
    '00000000-0000-4000-8000-0000000000a1'::uuid,
    'check-vault-a',
    jsonb_build_array(v_record || '{"ciphertext": "bmV3ZXJjb250ZW50"}'::jsonb)
  );
  if v_push #>> '{results,0,status}' <> 'stale'
     or v_push #>> '{results,0,current,ciphertext}' <> 'Y2lwaGVydGV4dEE='
     or (v_push ->> 'last_seq')::int <> 1 then
    raise exception 'CHECK FAILED: %', 'an equal updated_at_ms is stale';
  end if;

  begin
    perform 1 from public.sync_records;
    raise exception 'CHECK FAILED: %', 'sync_records is not readable directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    perform 1 from public.app_config;
    raise exception 'CHECK FAILED: %', 'app_config is not readable directly';
  exception
    when insufficient_privilege then null;
  end;
  begin
    insert into public.entitlements (user_id, plan_id, status, source)
    values ('00000000-0000-4000-8000-00000000000b', 'sync', 'active', 'manual');
    raise exception 'CHECK FAILED: %', 'entitlements cannot be inserted';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.entitlements set plan_id = 'sync';
    raise exception 'CHECK FAILED: %', 'entitlements cannot be updated';
  exception
    when insufficient_privilege then null;
  end;
  begin
    update public.app_config set value = 'false'::jsonb where key = 'sync_free_for_all';
    raise exception 'CHECK FAILED: %', 'app_config cannot be updated';
  exception
    when insufficient_privilege then null;
  end;

  select count(*) into v_count from public.devices;
  if v_count <> 5 then
    raise exception 'CHECK FAILED: %', 'A sees only its own devices';
  end if;
end
$$;

reset role;

-- ── As user B: own vault, pull isolation ────────────────────────────────────

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', true);

do $$
declare
  v_pull jsonb;
  v_count int;
begin
  perform public.register_device('00000000-0000-4000-8000-0000000000b1'::uuid, 'Check device B');
  perform public.create_vault(
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'check-vault-b',
    '{"v": 2, "vaultId": "check-vault-b"}'::jsonb
  );
  perform public.push_records(
    '00000000-0000-4000-8000-0000000000b1'::uuid,
    'check-vault-b',
    jsonb_build_array(jsonb_build_object(
      'record_key', 'checkRecordKeyB0000001',
      'ciphertext', 'Y2lwaGVydGV4dEI=',
      'iv', 'aXZpdml2aXZpdml2',
      'enc_v', 1,
      'updated_at_ms', 2000
    ))
  );

  v_pull := public.pull_records('00000000-0000-4000-8000-0000000000b1'::uuid, 'check-vault-b', 0);
  if jsonb_array_length(v_pull -> 'records') <> 1
     or v_pull #>> '{records,0,record_key}' <> 'checkRecordKeyB0000001' then
    raise exception 'CHECK FAILED: %', 'pull returns only the caller records';
  end if;

  select count(*) into v_count
    from public.entitlements
   where user_id = '00000000-0000-4000-8000-00000000000a';
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'B cannot read the entitlement of A';
  end if;
  select count(*) into v_count
    from public.vaults
   where user_id = '00000000-0000-4000-8000-00000000000a';
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'B cannot read the vault of A';
  end if;
  select count(*) into v_count
    from public.devices
   where user_id = '00000000-0000-4000-8000-00000000000a';
  if v_count <> 0 then
    raise exception 'CHECK FAILED: %', 'B cannot read the devices of A';
  end if;
  if public.get_vault() ->> 'vault_id' <> 'check-vault-b' then
    raise exception 'CHECK FAILED: %', 'get_vault returns the caller vault';
  end if;
end
$$;

reset role;

-- ── Beta switch off (inside this transaction only) ─────────────────────────

update public.app_config set value = 'false'::jsonb where key = 'sync_free_for_all';

set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-4000-8000-00000000000b', true);

do $$
declare
  v_deleted jsonb;
begin
  if public.effective_plan() <> 'free' then
    raise exception 'CHECK FAILED: %', 'plan free with the switch off';
  end if;
  begin
    perform public.pull_records('00000000-0000-4000-8000-0000000000b1'::uuid, 'check-vault-b', 0);
    raise exception 'CHECK FAILED: %', 'pull raises sync_not_included with the switch off';
  exception
    when raise_exception then
      if sqlerrm <> 'MINIMA:sync_not_included' then
        raise;
      end if;
  end;
  if public.get_vault() is null then
    raise exception 'CHECK FAILED: %', 'get_vault works without sync';
  end if;

  v_deleted := public.delete_cloud_data();
  if (v_deleted ->> 'deleted_records')::int <> 1 or public.get_vault() is not null then
    raise exception 'CHECK FAILED: %', 'delete_cloud_data works without sync';
  end if;
  if not exists (select 1 from public.entitlements) then
    raise exception 'CHECK FAILED: %', 'delete_cloud_data keeps the entitlement';
  end if;
end
$$;

reset role;

-- ── As the owner: deleting the auth user cascades ───────────────────────────

do $$
begin
  delete from auth.users where id = '00000000-0000-4000-8000-00000000000a';
  if exists (select 1 from public.entitlements where user_id = '00000000-0000-4000-8000-00000000000a')
     or exists (select 1 from public.vaults where user_id = '00000000-0000-4000-8000-00000000000a')
     or exists (select 1 from public.devices where user_id = '00000000-0000-4000-8000-00000000000a')
     or exists (select 1 from public.sync_records where user_id = '00000000-0000-4000-8000-00000000000a') then
    raise exception 'CHECK FAILED: %', 'deleting the auth user cascades';
  end if;

  raise notice 'sync_server_checks: all checks passed';
end
$$;

rollback;

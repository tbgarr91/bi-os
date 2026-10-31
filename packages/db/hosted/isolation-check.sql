-- Hosted isolation check (synthetic data only). Run against a hosted Supabase project after applying migrations.
-- It builds two workspaces inside ONE transaction, asserts 25 isolation and append-only rules as the API roles
-- (authenticated / anon), and then raises "ALL_OK ..." on purpose so every test row is rolled back.
-- Success looks like an error whose message starts with: ALL_OK 25 checks passed
-- Any other error message names the rule that failed. Never run this against a database holding real data.
do $$
declare
  ua uuid := gen_random_uuid(); ub uuid := gen_random_uuid(); uc uuid := gen_random_uuid(); uv uuid := gen_random_uuid(); uo uuid := gen_random_uuid();
  wa uuid; wb uuid; e1 uuid; e2 uuid; r1 uuid; r2 uuid; n int; ok int := 0; ds uuid;
begin
  perform set_config('request.jwt.claim.sub', ua::text, true); perform set_config('request.jwt.claims', json_build_object('sub', ua)::text, true);
  set local role authenticated;
  wa := public.create_workspace('Synthetic A');
  insert into public.legal_entities (workspace_id, name) values (wa, 'Entity One') returning id into e1;
  insert into public.legal_entities (workspace_id, name) values (wa, 'Entity Two') returning id into e2;
  insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values (wa, e1, 5099, 'USD', '2026-01-15', ua) returning id into r1;
  insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values (wa, e2, 2266, 'USD', '2026-01-15', ua) returning id into r2;
  perform public.grant_access(wa, uc, 'finance_accountant', e1);
  perform public.grant_access(wa, uv, 'viewer', null);
  select count(*) into n from public.financial_records where workspace_id = wa; if n <> 2 then raise exception 'FAIL owner sees % records', n; end if; ok := ok + 1;

  reset role; perform set_config('request.jwt.claim.sub', ub::text, true); perform set_config('request.jwt.claims', json_build_object('sub', ub)::text, true); set local role authenticated;
  wb := public.create_workspace('Synthetic B');
  select count(*) into n from public.financial_records where id in (r1, r2); if n <> 0 then raise exception 'FAIL B sees A records'; end if; ok := ok + 1;
  select count(*) into n from public.legal_entities where id in (e1, e2); if n <> 0 then raise exception 'FAIL B sees A entities'; end if; ok := ok + 1;
  select count(*) into n from public.workspaces where id = wa; if n <> 0 then raise exception 'FAIL B sees workspace A'; end if; ok := ok + 1;
  begin
    insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values (wa, e1, 1, 'USD', '2026-01-01', ub);
    raise exception 'FAIL B wrote into A';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;

  reset role; perform set_config('request.jwt.claim.sub', uc::text, true); perform set_config('request.jwt.claims', json_build_object('sub', uc)::text, true); set local role authenticated;
  select count(*) into n from public.financial_records where id = r1; if n <> 1 then raise exception 'FAIL accountant cannot see E1 record'; end if; ok := ok + 1;
  select count(*) into n from public.financial_records where id = r2; if n <> 0 then raise exception 'FAIL accountant sees E2 record'; end if; ok := ok + 1;
  begin
    insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values (wa, e2, 1, 'USD', '2026-01-01', uc);
    raise exception 'FAIL accountant wrote into E2';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  insert into public.source_datasets (workspace_id, entity_id, name, source_kind, created_by) values (wa, e1, 'Synthetic CSV', 'csv', uc) returning id into ds; ok := ok + 1;
  begin
    insert into public.source_datasets (workspace_id, entity_id, name, source_kind, created_by) values (wa, e2, 'x', 'csv', uc);
    raise exception 'FAIL accountant imported into E2';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  begin
    perform public.grant_access(wa, gen_random_uuid(), 'viewer', null);
    raise exception 'FAIL accountant granted a role';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  select count(*) into n from public.audit_events; if n <> 0 then raise exception 'FAIL accountant reads audit'; end if; ok := ok + 1;

  reset role; perform set_config('request.jwt.claim.sub', uv::text, true); perform set_config('request.jwt.claims', json_build_object('sub', uv)::text, true); set local role authenticated;
  select count(*) into n from public.financial_records where workspace_id = wa; if n <> 2 then raise exception 'FAIL viewer sees % records', n; end if; ok := ok + 1;
  select count(*) into n from public.source_datasets; if n <> 0 then raise exception 'FAIL viewer sees datasets'; end if; ok := ok + 1;
  begin
    insert into public.financial_records (workspace_id, entity_id, amount_cents, currency, occurred_on, created_by) values (wa, e1, 1, 'USD', '2026-01-01', uv);
    raise exception 'FAIL viewer wrote';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;

  reset role; perform set_config('request.jwt.claim.sub', uo::text, true); perform set_config('request.jwt.claims', json_build_object('sub', uo)::text, true); set local role authenticated;
  select count(*) into n from public.financial_records; if n <> 0 then raise exception 'FAIL outsider sees records'; end if; ok := ok + 1;
  reset role; perform set_config('request.jwt.claim.sub', '', true); perform set_config('request.jwt.claims', '', true); set local role anon;
  begin
    perform count(*) from public.financial_records; raise exception 'FAIL anon read records';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  begin
    perform public.create_workspace('x'); raise exception 'FAIL anon created workspace';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  begin
    perform public.rls_auto_enable(); raise exception 'FAIL anon called rls_auto_enable';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;

  reset role; perform set_config('request.jwt.claim.sub', ua::text, true); perform set_config('request.jwt.claims', json_build_object('sub', ua)::text, true); set local role authenticated;
  begin
    perform public.revoke_member(wa, ua); raise exception 'FAIL last owner removed';
  exception when others then if sqlstate not in ('23514') then raise; end if; ok := ok + 1; end;
  select count(*) into n from public.audit_events where workspace_id = wa; if n < 3 then raise exception 'FAIL audit rows %', n; end if; ok := ok + 1;

  reset role;
  begin update public.audit_events set action = 'x'; raise exception 'FAIL audit updated';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  begin delete from public.source_datasets; raise exception 'FAIL dataset deleted';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  begin truncate public.commerce_facts; raise exception 'FAIL facts truncated';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;
  begin update public.financial_records set workspace_id = wb where id = r1; raise exception 'FAIL workspace_id changed';
  exception when others then if sqlstate not in ('42501') then raise; end if; ok := ok + 1; end;

  raise exception 'ALL_OK % checks passed (transaction aborted on purpose: no data kept)', ok;
end $$;

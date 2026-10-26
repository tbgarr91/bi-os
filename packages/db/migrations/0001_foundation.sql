-- BI OS migration 0001: security foundation (Milestone M1).
-- Status: PROPOSED design, tested against local Postgres only. Not applied to any hosted database.
-- Contract: Project file 17 (Security & Authorization Contract) and decisions P-8 (three presets first), P-9 (own database).
-- Portable to Supabase: relies only on the standard roles (anon, authenticated, service_role) and auth.uid().

create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

-- ---------------------------------------------------------------- tenancy core
create table public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  archived_at timestamptz
);

create table public.legal_entities (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  name text not null check (length(btrim(name)) between 1 and 200),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  unique (workspace_id, id)            -- target for composite foreign keys
);

create table public.workspace_memberships (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references public.workspaces (id),
  user_id uuid not null,               -- auth user (login identity, never legal ownership)
  status text not null default 'active' check (status in ('active', 'revoked')),
  joined_at timestamptz not null default now(),
  revoked_at timestamptz,
  unique (workspace_id, id),
  check ((status = 'revoked') = (revoked_at is not null))
);
create unique index workspace_memberships_one_active
  on public.workspace_memberships (workspace_id, user_id) where status = 'active';

-- ---------------------------------------------------------------- roles and permissions
create table public.role_definitions (
  code text primary key check (code ~ '^[a-z][a-z0-9_]*$'),
  name text not null,
  is_system boolean not null default true,
  exposed_in_ui boolean not null default false,  -- P-8: only three presets are exposed in the first release
  version integer not null default 1
);

create table public.permission_definitions (
  code text primary key check (code ~ '^[a-z_]+\.[a-z_]+$'),   -- resource_type.action
  resource_type text not null,
  action text not null,
  sensitivity text not null default 'normal' check (sensitivity in ('normal', 'sensitive', 'restricted'))
);

create table public.role_permissions (
  role_code text not null references public.role_definitions (code),
  permission_code text not null references public.permission_definitions (code),
  primary key (role_code, permission_code)
);

create table public.access_grants (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  membership_id uuid not null,
  role_code text not null references public.role_definitions (code),
  scope_type text not null check (scope_type in ('workspace', 'legal_entity')),  -- typed scopes, no polymorphic ids
  legal_entity_id uuid,
  granted_by_membership_id uuid not null,
  starts_at timestamptz not null default now(),
  expires_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (workspace_id, membership_id) references public.workspace_memberships (workspace_id, id),
  foreign key (workspace_id, granted_by_membership_id) references public.workspace_memberships (workspace_id, id),
  foreign key (workspace_id, legal_entity_id) references public.legal_entities (workspace_id, id),
  check ((scope_type = 'workspace' and legal_entity_id is null) or (scope_type = 'legal_entity' and legal_entity_id is not null)),
  check (expires_at is null or expires_at > starts_at)
);
create index access_grants_lookup on public.access_grants (workspace_id, membership_id) where revoked_at is null;

-- ---------------------------------------------------------------- protected scaffold resource
-- SCAFFOLD ONLY: stands in for canonical financial objects so the isolation rules can be tested.
-- Milestone M2 replaces it with the real evidence/event model (file 16).
create table public.financial_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  amount_cents bigint not null,
  currency text not null check (currency ~ '^[A-Z]{3}$'),
  occurred_on date not null,
  description text,
  status text not null default 'unclassified' check (status in ('unclassified', 'classified')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  foreign key (workspace_id, entity_id) references public.legal_entities (workspace_id, id)
);

-- ---------------------------------------------------------------- audit (append-only)
create table public.audit_events (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references public.workspaces (id),
  actor_user_id uuid,
  action text not null,
  resource_type text,
  resource_id uuid,
  at timestamptz not null default now(),
  details jsonb not null default '{}' check (jsonb_typeof(details) = 'object')  -- ids and codes only; never amounts, documents or personal data
);

-- ---------------------------------------------------------------- guards (triggers)
create function private.forbid_workspace_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.workspace_id is distinct from old.workspace_id then
    raise exception 'workspace_id is immutable' using errcode = '42501';
  end if;
  return new;
end $$;

create function private.forbid_audit_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception 'audit_events is append-only' using errcode = '42501';
end $$;

create trigger legal_entities_ws_immutable before update on public.legal_entities
  for each row execute function private.forbid_workspace_change();
create trigger memberships_ws_immutable before update on public.workspace_memberships
  for each row execute function private.forbid_workspace_change();
create trigger grants_ws_immutable before update on public.access_grants
  for each row execute function private.forbid_workspace_change();
create trigger records_ws_immutable before update on public.financial_records
  for each row execute function private.forbid_workspace_change();
create trigger audit_no_update before update or delete on public.audit_events
  for each row execute function private.forbid_audit_change();
create trigger audit_no_truncate before truncate on public.audit_events
  for each statement execute function private.forbid_audit_change();

-- ---------------------------------------------------------------- authorization functions
-- Narrow SECURITY DEFINER helpers: empty search_path, fully qualified names, identity from auth.uid() only
-- (never from a parameter or from client-editable token metadata), evaluated against live tables at call time.
create function private.is_active_member(p_workspace uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.workspace_memberships m
    where m.workspace_id = p_workspace and m.user_id = auth.uid()
      and m.status = 'active' and m.revoked_at is null
  )
$$;

create function private.has_permission(p_workspace uuid, p_permission text, p_entity uuid default null) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.workspace_memberships m
    join public.access_grants g on g.workspace_id = m.workspace_id and g.membership_id = m.id
    join public.role_permissions rp on rp.role_code = g.role_code
    where m.workspace_id = p_workspace
      and m.user_id = auth.uid()
      and m.status = 'active' and m.revoked_at is null
      and g.revoked_at is null
      and g.starts_at <= now()
      and (g.expires_at is null or g.expires_at > now())
      and rp.permission_code = p_permission
      and (g.scope_type = 'workspace'
           or (g.scope_type = 'legal_entity' and p_entity is not null and g.legal_entity_id = p_entity))
  )
$$;

revoke all on function private.is_active_member(uuid) from public, anon;
revoke all on function private.has_permission(uuid, text, uuid) from public, anon;
grant execute on function private.is_active_member(uuid) to authenticated;
grant execute on function private.has_permission(uuid, text, uuid) to authenticated;

-- ---------------------------------------------------------------- RPCs (the only write path for tenancy tables)
create function public.create_workspace(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_ws uuid; v_m uuid;
begin
  if auth.uid() is null then raise exception 'not authenticated' using errcode = '42501'; end if;
  insert into public.workspaces (name) values (p_name) returning id into v_ws;
  insert into public.workspace_memberships (workspace_id, user_id) values (v_ws, auth.uid()) returning id into v_m;
  insert into public.access_grants (workspace_id, membership_id, role_code, scope_type, granted_by_membership_id)
    values (v_ws, v_m, 'owner', 'workspace', v_m);
  insert into public.audit_events (workspace_id, actor_user_id, action, resource_type, resource_id)
    values (v_ws, auth.uid(), 'workspace.created', 'workspace', v_ws);
  return v_ws;
end $$;

-- Grant a role to a user. Anti-escalation: the caller must already hold every permission of the role,
-- at the same scope. A workspace-scope grant therefore needs workspace-scope holdings.
create function public.grant_access(p_workspace uuid, p_user uuid, p_role text, p_entity uuid default null) returns uuid
language plpgsql security definer set search_path = '' as $$
declare v_caller uuid; v_target uuid; v_grant uuid; v_perm text; v_scope text;
begin
  if auth.uid() is null or not private.has_permission(p_workspace, 'membership.assign_roles') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if not exists (select 1 from public.role_definitions where code = p_role) then
    raise exception 'unknown role' using errcode = '22023';
  end if;
  for v_perm in select permission_code from public.role_permissions where role_code = p_role loop
    if not private.has_permission(p_workspace, v_perm, p_entity) then
      raise exception 'cannot grant permissions you do not hold' using errcode = '42501';
    end if;
  end loop;
  select id into v_caller from public.workspace_memberships
    where workspace_id = p_workspace and user_id = auth.uid() and status = 'active';
  select id into v_target from public.workspace_memberships
    where workspace_id = p_workspace and user_id = p_user and status = 'active';
  if v_target is null then
    insert into public.workspace_memberships (workspace_id, user_id) values (p_workspace, p_user) returning id into v_target;
  end if;
  v_scope := case when p_entity is null then 'workspace' else 'legal_entity' end;
  insert into public.access_grants (workspace_id, membership_id, role_code, scope_type, legal_entity_id, granted_by_membership_id)
    values (p_workspace, v_target, p_role, v_scope, p_entity, v_caller) returning id into v_grant;
  insert into public.audit_events (workspace_id, actor_user_id, action, resource_type, resource_id, details)
    values (p_workspace, auth.uid(), 'access.granted', 'access_grant', v_grant,
            jsonb_build_object('role', p_role, 'scope', v_scope, 'target_user', p_user));
  return v_grant;
end $$;

create function private.other_active_owners(p_workspace uuid, p_excluding_membership uuid) returns integer
language sql stable security definer set search_path = '' as $$
  select count(distinct g.membership_id)::integer
  from public.access_grants g
  join public.workspace_memberships m on m.id = g.membership_id and m.workspace_id = g.workspace_id
  where g.workspace_id = p_workspace and g.role_code = 'owner' and g.scope_type = 'workspace'
    and g.revoked_at is null and (g.expires_at is null or g.expires_at > now())
    and m.status = 'active' and m.id <> p_excluding_membership
$$;
revoke all on function private.other_active_owners(uuid, uuid) from public, anon;

create function public.revoke_access(p_grant uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare g public.access_grants;
begin
  select * into g from public.access_grants where id = p_grant;
  if g.id is null or auth.uid() is null or not private.has_permission(g.workspace_id, 'membership.assign_roles') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  if g.revoked_at is not null then return; end if;
  if g.role_code = 'owner' and g.scope_type = 'workspace'
     and private.other_active_owners(g.workspace_id, g.membership_id) = 0 then
    raise exception 'cannot remove the last owner' using errcode = '23514';
  end if;
  update public.access_grants set revoked_at = now() where id = p_grant;
  insert into public.audit_events (workspace_id, actor_user_id, action, resource_type, resource_id, details)
    values (g.workspace_id, auth.uid(), 'access.revoked', 'access_grant', p_grant, jsonb_build_object('role', g.role_code));
end $$;

create function public.revoke_member(p_workspace uuid, p_user uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare v_m uuid;
begin
  if auth.uid() is null or not private.has_permission(p_workspace, 'membership.revoke') then
    raise exception 'not authorized' using errcode = '42501';
  end if;
  select id into v_m from public.workspace_memberships
    where workspace_id = p_workspace and user_id = p_user and status = 'active';
  if v_m is null then return; end if;
  if exists (select 1 from public.access_grants where membership_id = v_m and role_code = 'owner'
             and scope_type = 'workspace' and revoked_at is null)
     and private.other_active_owners(p_workspace, v_m) = 0 then
    raise exception 'cannot remove the last owner' using errcode = '23514';
  end if;
  update public.access_grants set revoked_at = now() where membership_id = v_m and revoked_at is null;
  update public.workspace_memberships set status = 'revoked', revoked_at = now() where id = v_m;
  insert into public.audit_events (workspace_id, actor_user_id, action, resource_type, resource_id, details)
    values (p_workspace, auth.uid(), 'member.revoked', 'membership', v_m, jsonb_build_object('target_user', p_user));
end $$;

revoke all on function public.create_workspace(text) from public, anon;
revoke all on function public.grant_access(uuid, uuid, text, uuid) from public, anon;
revoke all on function public.revoke_access(uuid) from public, anon;
revoke all on function public.revoke_member(uuid, uuid) from public, anon;
grant execute on function public.create_workspace(text) to authenticated;
grant execute on function public.grant_access(uuid, uuid, text, uuid) to authenticated;
grant execute on function public.revoke_access(uuid) to authenticated;
grant execute on function public.revoke_member(uuid, uuid) to authenticated;

-- ---------------------------------------------------------------- row level security
alter table public.workspaces enable row level security;
alter table public.legal_entities enable row level security;
alter table public.workspace_memberships enable row level security;
alter table public.role_definitions enable row level security;
alter table public.permission_definitions enable row level security;
alter table public.role_permissions enable row level security;
alter table public.access_grants enable row level security;
alter table public.financial_records enable row level security;
alter table public.audit_events enable row level security;

create policy workspaces_select on public.workspaces for select to authenticated
  using (private.is_active_member(id));
create policy workspaces_update on public.workspaces for update to authenticated
  using (private.has_permission(id, 'workspace.manage_settings'))
  with check (private.has_permission(id, 'workspace.manage_settings'));

create policy memberships_select on public.workspace_memberships for select to authenticated
  using (user_id = auth.uid() or private.has_permission(workspace_id, 'membership.read'));

create policy grants_select on public.access_grants for select to authenticated
  using (private.has_permission(workspace_id, 'membership.read')
         or membership_id in (select id from public.workspace_memberships where user_id = auth.uid()));

create policy roles_select on public.role_definitions for select to authenticated using (true);
create policy perms_select on public.permission_definitions for select to authenticated using (true);
create policy role_perms_select on public.role_permissions for select to authenticated using (true);

create policy entities_select on public.legal_entities for select to authenticated
  using (private.has_permission(workspace_id, 'legal_entity.read', id));
create policy entities_insert on public.legal_entities for insert to authenticated
  with check (private.has_permission(workspace_id, 'legal_entity.create'));
create policy entities_update on public.legal_entities for update to authenticated
  using (private.has_permission(workspace_id, 'legal_entity.update', id))
  with check (private.has_permission(workspace_id, 'legal_entity.update', id));

create policy records_select on public.financial_records for select to authenticated
  using (private.has_permission(workspace_id, 'financial_record.read', entity_id));
create policy records_insert on public.financial_records for insert to authenticated
  with check (private.has_permission(workspace_id, 'financial_record.create', entity_id) and created_by = auth.uid());
create policy records_update on public.financial_records for update to authenticated
  using (private.has_permission(workspace_id, 'financial_record.classify', entity_id))
  with check (private.has_permission(workspace_id, 'financial_record.classify', entity_id));

create policy audit_select on public.audit_events for select to authenticated
  using (private.has_permission(workspace_id, 'audit.read'));

-- ---------------------------------------------------------------- table privileges (deny by default)
-- Hosted Postgres platforms often pre-grant broad privileges to API roles on new tables; revoke first, then allow explicitly.
revoke all on all tables in schema public from public, anon, authenticated;
grant select on public.workspaces, public.workspace_memberships, public.access_grants,
  public.role_definitions, public.permission_definitions, public.role_permissions,
  public.legal_entities, public.financial_records, public.audit_events to authenticated;
grant update (name) on public.workspaces to authenticated;
grant insert (workspace_id, name) on public.legal_entities to authenticated;
grant update (name, archived_at) on public.legal_entities to authenticated;
grant insert (workspace_id, entity_id, amount_cents, currency, occurred_on, description, created_by) on public.financial_records to authenticated;
grant update (status, description) on public.financial_records to authenticated;
-- No DELETE anywhere: originals are archived or corrected, never erased. No INSERT/UPDATE on memberships, grants or audit: RPCs only.

-- ---------------------------------------------------------------- seed: permissions and the three first-release presets (P-8)
insert into public.permission_definitions (code, resource_type, action, sensitivity) values
  ('workspace.manage_settings', 'workspace', 'manage_settings', 'sensitive'),
  ('membership.read', 'membership', 'read', 'normal'),
  ('membership.assign_roles', 'membership', 'assign_roles', 'restricted'),
  ('membership.revoke', 'membership', 'revoke', 'restricted'),
  ('legal_entity.read', 'legal_entity', 'read', 'normal'),
  ('legal_entity.create', 'legal_entity', 'create', 'normal'),
  ('legal_entity.update', 'legal_entity', 'update', 'normal'),
  ('financial_record.read', 'financial_record', 'read', 'sensitive'),
  ('financial_record.create', 'financial_record', 'create', 'sensitive'),
  ('financial_record.classify', 'financial_record', 'classify', 'sensitive'),
  ('financial_record.approve', 'financial_record', 'approve', 'restricted'),
  ('financial_record.export', 'financial_record', 'export', 'restricted'),
  ('metric_result.read', 'metric_result', 'read', 'sensitive'),
  ('data_connection.read', 'data_connection', 'read', 'normal'),
  ('data_connection.connect', 'data_connection', 'connect', 'restricted'),
  ('data_connection.disconnect', 'data_connection', 'disconnect', 'restricted'),
  ('audit.read', 'audit', 'read', 'restricted');

insert into public.role_definitions (code, name, exposed_in_ui) values
  ('owner', 'Owner', true),
  ('finance_accountant', 'Finance / Accountant', true),
  ('viewer', 'Viewer', true);

-- Owner: every permission.
insert into public.role_permissions (role_code, permission_code) select 'owner', code from public.permission_definitions;
-- Finance / Accountant (PROPOSED contents, pending founder review): reads, records, classifies and exports; no approvals, connections, or role management.
insert into public.role_permissions (role_code, permission_code) values
  ('finance_accountant', 'legal_entity.read'), ('finance_accountant', 'financial_record.read'),
  ('finance_accountant', 'financial_record.create'), ('finance_accountant', 'financial_record.classify'),
  ('finance_accountant', 'financial_record.export'), ('finance_accountant', 'metric_result.read'),
  ('finance_accountant', 'data_connection.read');
-- Viewer: read-only.
insert into public.role_permissions (role_code, permission_code) values
  ('viewer', 'legal_entity.read'), ('viewer', 'financial_record.read'), ('viewer', 'metric_result.read');

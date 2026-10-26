-- 0002: source evidence and staged commerce facts (Project file 16, sections 1, 3, 4, 9).
-- Evidence is append-only: rows are never updated or deleted by anyone, including the service role. Corrections arrive as
-- new versions that supersede old ones. Amounts are integer cents with a currency; an unknown amount is NULL, never 0.
-- Privacy: `payload` holds ONLY the columns named in the approved mapping (the application layer minimizes rows before insert).

insert into public.permission_definitions (code, resource_type, action, sensitivity) values
  ('source_data.read', 'source_data', 'read', 'sensitive'),
  ('source_data.import', 'source_data', 'import', 'sensitive');
insert into public.role_permissions (role_code, permission_code) values
  ('owner', 'source_data.read'), ('owner', 'source_data.import'),
  -- PROPOSED, pending founder review (same status as the rest of this preset):
  ('finance_accountant', 'source_data.read'), ('finance_accountant', 'source_data.import');
-- Viewer deliberately has no source_data.read: staged evidence is closer to raw than results (PROPOSED; founder may change).

create table public.source_datasets (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  name text not null check (length(name) between 1 and 200),
  source_kind text not null check (source_kind in ('csv', 'xlsx', 'manual')),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, id, entity_id),
  foreign key (workspace_id, entity_id) references public.legal_entities (workspace_id, id)
);

create table public.ingestion_batches (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  dataset_id uuid not null,
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  rows_read integer not null check (rows_read >= 0),
  rows_added integer not null check (rows_added >= 0),
  rows_unchanged integer not null check (rows_unchanged >= 0),
  rows_revised integer not null check (rows_revised >= 0),
  rows_flagged integer not null check (rows_flagged >= 0),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, id, entity_id),
  foreign key (workspace_id, dataset_id, entity_id) references public.source_datasets (workspace_id, id, entity_id)
);

create table public.source_records (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  dataset_id uuid not null,
  batch_id uuid not null,
  identity text not null check (length(identity) between 1 and 500),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  source_row integer not null check (source_row >= 1),
  supersedes_id uuid,
  created_at timestamptz not null default now(),
  unique (workspace_id, id),
  unique (workspace_id, id, entity_id),
  -- the same content for the same identity can be stored once: re-importing a file adds nothing
  unique (workspace_id, dataset_id, identity, content_sha256),
  -- a record can be superseded by at most one newer version (no forks)
  unique (supersedes_id),
  foreign key (workspace_id, dataset_id, entity_id) references public.source_datasets (workspace_id, id, entity_id),
  foreign key (workspace_id, batch_id, entity_id) references public.ingestion_batches (workspace_id, id, entity_id),
  foreign key (workspace_id, supersedes_id) references public.source_records (workspace_id, id)
);

create table public.commerce_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  source_record_id uuid not null,
  kind text not null check (kind in ('order', 'payment', 'refund', 'fee', 'payout')),
  external_id text not null check (length(external_id) between 1 and 200),
  amount_cents bigint,                 -- NULL = unknown. Never defaulted to zero.
  currency text check (currency ~ '^[A-Z]{3}$'),
  occurred_on date,
  related_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  check (amount_cents is null or currency is not null),
  unique (workspace_id, source_record_id),
  foreign key (workspace_id, source_record_id, entity_id) references public.source_records (workspace_id, id, entity_id)
);

create table public.data_quality_issues (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  batch_id uuid not null,
  source_row integer not null check (source_row >= 1),
  code text not null check (code in ('missing_amount', 'invalid_amount', 'missing_id', 'unknown_kind', 'missing_currency', 'invalid_currency', 'invalid_date', 'duplicate_in_file', 'conflict_in_file')),
  message text not null check (length(message) <= 300),  -- explanatory text only; never source values
  created_at timestamptz not null default now(),
  foreign key (workspace_id, batch_id, entity_id) references public.ingestion_batches (workspace_id, id, entity_id)
);

-- ---------------------------------------------------------------- append-only for everyone
-- Statement-level, so it also refuses an UPDATE or DELETE that happens to match zero rows.
create function private.forbid_evidence_change() returns trigger
language plpgsql set search_path = '' as $$
begin
  raise exception '% is append-only; corrections are new versions', tg_table_name using errcode = '42501';
end $$;

create trigger datasets_append_only before update or delete or truncate on public.source_datasets for each statement execute function private.forbid_evidence_change();
create trigger batches_append_only before update or delete or truncate on public.ingestion_batches for each statement execute function private.forbid_evidence_change();
create trigger records_append_only before update or delete or truncate on public.source_records for each statement execute function private.forbid_evidence_change();
create trigger facts_append_only before update or delete or truncate on public.commerce_facts for each statement execute function private.forbid_evidence_change();
create trigger issues_append_only before update or delete or truncate on public.data_quality_issues for each statement execute function private.forbid_evidence_change();

-- ---------------------------------------------------------------- row level security
alter table public.source_datasets enable row level security;
alter table public.ingestion_batches enable row level security;
alter table public.source_records enable row level security;
alter table public.commerce_facts enable row level security;
alter table public.data_quality_issues enable row level security;

create policy datasets_select on public.source_datasets for select to authenticated
  using (private.has_permission(workspace_id, 'source_data.read', entity_id));
create policy datasets_insert on public.source_datasets for insert to authenticated
  with check (private.has_permission(workspace_id, 'source_data.import', entity_id) and created_by = auth.uid());
create policy batches_select on public.ingestion_batches for select to authenticated
  using (private.has_permission(workspace_id, 'source_data.read', entity_id));
create policy batches_insert on public.ingestion_batches for insert to authenticated
  with check (private.has_permission(workspace_id, 'source_data.import', entity_id) and created_by = auth.uid());
create policy source_records_select on public.source_records for select to authenticated
  using (private.has_permission(workspace_id, 'source_data.read', entity_id));
create policy source_records_insert on public.source_records for insert to authenticated
  with check (private.has_permission(workspace_id, 'source_data.import', entity_id));
create policy facts_select on public.commerce_facts for select to authenticated
  using (private.has_permission(workspace_id, 'source_data.read', entity_id));
create policy facts_insert on public.commerce_facts for insert to authenticated
  with check (private.has_permission(workspace_id, 'source_data.import', entity_id));
create policy issues_select on public.data_quality_issues for select to authenticated
  using (private.has_permission(workspace_id, 'source_data.read', entity_id));
create policy issues_insert on public.data_quality_issues for insert to authenticated
  with check (private.has_permission(workspace_id, 'source_data.import', entity_id));

-- ---------------------------------------------------------------- table privileges (deny by default, insert and select only)
revoke all on public.source_datasets, public.ingestion_batches, public.source_records, public.commerce_facts, public.data_quality_issues
  from public, anon, authenticated;
grant select on public.source_datasets, public.ingestion_batches, public.source_records, public.commerce_facts, public.data_quality_issues to authenticated;
grant insert (workspace_id, entity_id, name, source_kind, created_by) on public.source_datasets to authenticated;
grant insert (workspace_id, entity_id, dataset_id, file_sha256, rows_read, rows_added, rows_unchanged, rows_revised, rows_flagged, created_by) on public.ingestion_batches to authenticated;
grant insert (workspace_id, entity_id, dataset_id, batch_id, identity, content_sha256, payload, source_row, supersedes_id) on public.source_records to authenticated;
grant insert (workspace_id, entity_id, source_record_id, kind, external_id, amount_cents, currency, occurred_on, related_ids) on public.commerce_facts to authenticated;
grant insert (workspace_id, entity_id, batch_id, source_row, code, message) on public.data_quality_issues to authenticated;

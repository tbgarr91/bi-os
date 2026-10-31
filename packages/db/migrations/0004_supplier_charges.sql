-- 0004: supplier charges (decision P-2). What a print-on-demand supplier billed for an order, stored as its own fact kind.
-- Same rules as commerce_facts: append-only, amount in integer cents with a currency, an unknown amount is NULL (never 0),
-- every row traces to the source record it came from, and access follows source_data.read / source_data.import.
create table public.supplier_charges (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  entity_id uuid not null,
  source_record_id uuid not null,
  kind text not null check (kind in ('production', 'print_surcharge', 'supplier_shipping', 'supplier_tax', 'reprint')),
  external_id text not null check (length(external_id) between 1 and 200),
  order_ref text not null check (length(order_ref) between 1 and 200),
  amount_cents bigint,                 -- NULL = unknown. Never defaulted to zero.
  currency text check (currency ~ '^[A-Z]{3}$'),
  occurred_on date,
  created_at timestamptz not null default now(),
  check (amount_cents is null or currency is not null),
  unique (workspace_id, source_record_id),
  foreign key (workspace_id, source_record_id, entity_id) references public.source_records (workspace_id, id, entity_id)
);

create trigger supplier_charges_append_only before update or delete or truncate on public.supplier_charges
  for each statement execute function private.forbid_evidence_change();

alter table public.supplier_charges enable row level security;
create policy supplier_charges_select on public.supplier_charges for select to authenticated
  using (private.has_permission(workspace_id, 'source_data.read', entity_id));
create policy supplier_charges_insert on public.supplier_charges for insert to authenticated
  with check (private.has_permission(workspace_id, 'source_data.import', entity_id));

revoke all on public.supplier_charges from public, anon, authenticated;
grant select on public.supplier_charges to authenticated;
grant insert (workspace_id, entity_id, source_record_id, kind, external_id, order_ref, amount_cents, currency, occurred_on) on public.supplier_charges to authenticated;

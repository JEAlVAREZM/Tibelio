-- Migración Incremental Fase 3: Operaciones, Compras, Bodega, Despacho y Finanzas
-- Referencias Maestras: COM-005, COM-006, COT-011, COT-012, DEC-008, DEC-012, DEC-029, DEC-044, DEC-051, DEC-052, DEC-060
-- Criterios de Aceptación: AT-08, AT-09, AT-10, AT-11, AT-12, AT-13, AT-17, AT-18

create schema if not exists app;

-- 1. PROVEEDORES EMPRESARIALES (3.1)
create table if not exists app.suppliers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  name text not null check (length(btrim(name)) between 2 and 200),
  tax_id text null check (tax_id is null or length(btrim(tax_id)) between 3 and 50),
  contact_name text null check (contact_name is null or length(btrim(contact_name)) between 2 and 150),
  email text null check (email is null or email ~* '^.+@.+\..+$'),
  phone text null check (phone is null or length(btrim(phone)) between 5 and 30),
  notes text null check (notes is null or length(notes) <= 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists suppliers_tenant_lookup on app.suppliers(tenant_id, active, name);

-- 2. REVISIÓN DE COMPRAS POR COTIZACIÓN APROBADA (3.1)
create table if not exists app.procurement_reviews (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  quotation_id uuid not null,
  quotation_version integer not null,
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  notes text null check (notes is null or length(notes) <= 1000),
  reviewed_by uuid null,
  reviewed_at timestamptz null,
  created_at timestamptz not null default now(),
  created_by uuid not null,

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists procurement_reviews_lookup on app.procurement_reviews(tenant_id, request_id, status);

-- 3. CONSECUTIVOS DE ÓRDENES DE COMPRA (OC-YYYYMM-XXXX) (3.1)
create table if not exists app.purchase_order_counters (
  tenant_id uuid not null references app.tenants(id),
  year_month text not null check (year_month ~ '^[0-9]{6}$'),
  last_value integer not null default 0 check (last_value >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, year_month)
);

create or replace function app_private.next_purchase_order_code()
returns text
language plpgsql
security definer
set search_path = app_private, app, public
as $$
declare
  v_tenant uuid;
  v_month text;
  v_seq integer;
begin
  select tenant_id into v_tenant from app_private.actor();
  if v_tenant is null then
    raise exception 'Sesion no autorizada para generar consecutivo de orden de compra' using errcode = '42501';
  end if;

  v_month := to_char(timezone('UTC', now()), 'YYYYMM');

  insert into app.purchase_order_counters(tenant_id, year_month, last_value, updated_at)
  values (v_tenant, v_month, 1, now())
  on conflict (tenant_id, year_month)
  do update set
    last_value = app.purchase_order_counters.last_value + 1,
    updated_at = now()
  returning last_value into v_seq;

  return 'OC-' || v_month || '-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');
end;
$$;

-- 4. ÓRDENES DE COMPRA (3.1)
create table if not exists app.purchase_orders (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  code text not null check (code ~ '^OC-[0-9]{6}-[0-9]{4,}$'),
  supplier_id uuid not null,
  status text not null check (status in ('DRAFT', 'ORDERED', 'PARTIAL_RECEIVED', 'RECEIVED', 'CANCELLED')),
  notes text null check (notes is null or length(notes) <= 1000),
  ordered_at timestamptz null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, supplier_id) references app.suppliers(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, code)
);

create index if not exists purchase_orders_lookup on app.purchase_orders(tenant_id, status, supplier_id);

-- 5. LÍNEAS DE ÓRDENES DE COMPRA (3.1)
create table if not exists app.purchase_order_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  order_id uuid not null,
  product_id uuid not null,
  request_id uuid null,
  quantity numeric(12,2) not null check (quantity > 0),
  unit_cost numeric(18,2) not null check (unit_cost >= 0),
  received_quantity numeric(12,2) not null default 0 check (received_quantity >= 0 and received_quantity <= quantity),
  expected_date date null,
  notes text null check (notes is null or length(notes) <= 500),

  foreign key (tenant_id, order_id) references app.purchase_orders(tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references app.catalog_products(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists po_lines_order on app.purchase_order_lines(tenant_id, order_id);

-- 6. RECEPCIONES DE COMPRA (3.1)
create table if not exists app.procurement_receipts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  order_id uuid not null,
  notes text null check (notes is null or length(notes) <= 1000),
  received_at timestamptz not null default now(),
  received_by uuid not null,

  foreign key (tenant_id, order_id) references app.purchase_orders(tenant_id, id),
  foreign key (tenant_id, received_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create table if not exists app.procurement_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  receipt_id uuid not null,
  order_line_id uuid not null,
  quantity_received numeric(12,2) not null check (quantity_received > 0),

  foreign key (tenant_id, receipt_id) references app.procurement_receipts(tenant_id, id) on delete cascade,
  foreign key (tenant_id, order_line_id) references app.purchase_order_lines(tenant_id, id),
  unique (tenant_id, id)
);

-- 7. BODEGA, EXISTENCIAS Y STOCK INDIVIDUAL DE CABINAS (3.2)
create table if not exists app.warehouse_stock (
  tenant_id uuid not null references app.tenants(id),
  product_id uuid not null,
  quantity numeric(12,2) not null default 0 check (quantity >= 0),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, product_id),
  foreign key (tenant_id, product_id) references app.catalog_products(tenant_id, id)
);

create table if not exists app.cabin_stock (
  tenant_id uuid not null references app.tenants(id),
  cabin_id uuid not null,
  request_id uuid not null,
  product_id uuid not null,
  status text not null check (status in ('IN_STOCK', 'DISPATCHED', 'RETURNED', 'DAMAGED')),
  location text null check (location is null or length(location) <= 100),
  updated_at timestamptz not null default now(),
  primary key (tenant_id, cabin_id),
  foreign key (tenant_id, cabin_id) references app.request_cabins(tenant_id, id),
  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, product_id) references app.catalog_products(tenant_id, id)
);

-- 8. MOVIMIENTOS INMUTABLES DE INVENTARIO (3.2)
create table if not exists app.inventory_movements (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  product_id uuid not null,
  cabin_id uuid null,
  movement_type text not null check (movement_type in ('RECEPTION', 'RETURN', 'DAMAGE', 'ADJUSTMENT', 'DISPATCH', 'CONSUMPTION')),
  quantity numeric(12,2) not null check (quantity <> 0),
  previous_balance numeric(12,2) not null check (previous_balance >= 0),
  new_balance numeric(12,2) not null check (new_balance >= 0),
  reference_type text not null check (reference_type in ('PURCHASE_RECEIPT', 'DISPATCH', 'DAMAGE_REPORT', 'RETURN_REPORT', 'ADJUSTMENT')),
  reference_id uuid not null,
  notes text null check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),
  created_by uuid not null,

  foreign key (tenant_id, product_id) references app.catalog_products(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists inventory_movements_lookup on app.inventory_movements(tenant_id, product_id, created_at desc);

-- 9. PRIORIDAD EN SOLICITUDES Y REGISTROS DE DESPACHO (3.3)
alter table app.commercial_requests
  add column if not exists priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT'));

create table if not exists app.dispatch_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  quotation_id uuid not null,
  status text not null check (status in ('PREPARED', 'DISPATCHED', 'CANCELLED')),
  notes text null check (notes is null or length(notes) <= 1000),
  dispatched_at timestamptz null,
  dispatched_by uuid null,
  created_at timestamptz not null default now(),
  created_by uuid not null,

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create table if not exists app.dispatch_lines (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  dispatch_id uuid not null,
  product_id uuid not null,
  cabin_id uuid null,
  quantity numeric(12,2) not null check (quantity > 0),

  foreign key (tenant_id, dispatch_id) references app.dispatch_records(tenant_id, id) on delete cascade,
  foreign key (tenant_id, product_id) references app.catalog_products(tenant_id, id),
  unique (tenant_id, id)
);

-- 10. CONDICIONES DE PAGO Y RECAUDOS (3.4)
create table if not exists app.payment_terms (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  quotation_id uuid not null,
  milestone text not null check (milestone in ('DOWN_PAYMENT', 'MANUFACTURE', 'PRE_DISPATCH', 'DELIVERY', 'FINAL')),
  percentage numeric(5,2) not null check (percentage > 0 and percentage <= 100),
  amount numeric(18,2) not null check (amount > 0),
  due_date date null,
  notes text null check (notes is null or length(notes) <= 500),
  created_at timestamptz not null default now(),

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id),
  unique (tenant_id, id)
);

create table if not exists app.client_payments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  amount numeric(18,2) not null check (amount > 0),
  payment_date date not null,
  payment_method text not null check (payment_method in ('TRANSFER', 'DEPOSIT', 'CARD', 'CASH', 'OTHER')),
  reference_code text null check (reference_code is null or length(btrim(reference_code)) between 1 and 100),
  receipt_file_id uuid not null,
  receipt_byte_size integer not null default 0,
  receipt_sha256 text not null default '',
  receipt_mime_type text not null default 'application/pdf',
  status text not null default 'PENDING' check (status in ('PENDING', 'VALIDATED', 'REJECTED')),
  rejection_reason text null check (rejection_reason is null or length(btrim(rejection_reason)) >= 3),
  validated_by uuid null,
  validated_at timestamptz null,
  registered_by uuid not null,
  registered_at timestamptz not null default now(),
  notes text null check (notes is null or length(notes) <= 1000),

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, registered_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists client_payments_lookup on app.client_payments(tenant_id, request_id, status);

-- 11. REGISTROS DE REEMBOLSO Y CANCELACIÓN (3.5)
create table if not exists app.refund_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  amount numeric(18,2) not null check (amount > 0),
  reason text not null check (length(btrim(reason)) >= 5),
  receipt_file_id uuid null,
  disbursed_at timestamptz null,
  authorized_by uuid not null,
  authorized_at timestamptz not null default now(),

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, authorized_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create table if not exists app.cancellation_records (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  reason text not null check (length(btrim(reason)) >= 5),
  refund_amount numeric(18,2) not null default 0 check (refund_amount >= 0),
  internal_costs numeric(18,2) not null default 0 check (internal_costs >= 0),
  cancelled_by uuid not null,
  cancelled_at timestamptz not null default now(),

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, cancelled_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

-- 12. HABILITAR ROW LEVEL SECURITY (RLS) EN TODAS LAS TABLAS NUEVAS
alter table app.suppliers enable row level security;
alter table app.procurement_reviews enable row level security;
alter table app.purchase_order_counters enable row level security;
alter table app.purchase_orders enable row level security;
alter table app.purchase_order_lines enable row level security;
alter table app.procurement_receipts enable row level security;
alter table app.procurement_receipt_lines enable row level security;
alter table app.warehouse_stock enable row level security;
alter table app.cabin_stock enable row level security;
alter table app.inventory_movements enable row level security;
alter table app.dispatch_records enable row level security;
alter table app.dispatch_lines enable row level security;
alter table app.payment_terms enable row level security;
alter table app.client_payments enable row level security;
alter table app.refund_records enable row level security;
alter table app.cancellation_records enable row level security;

-- 13. POLÍTICAS RLS AISLADAS POR TENANT_ID
create policy suppliers_tenant_isolation on app.suppliers
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy procurement_reviews_isolation on app.procurement_reviews
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy po_counters_isolation on app.purchase_order_counters
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy purchase_orders_isolation on app.purchase_orders
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy po_lines_isolation on app.purchase_order_lines
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy procurement_receipts_isolation on app.procurement_receipts
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy procurement_receipt_lines_isolation on app.procurement_receipt_lines
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy warehouse_stock_isolation on app.warehouse_stock
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy cabin_stock_isolation on app.cabin_stock
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy inventory_movements_isolation on app.inventory_movements
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy dispatch_records_isolation on app.dispatch_records
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy dispatch_lines_isolation on app.dispatch_lines
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy payment_terms_isolation on app.payment_terms
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy client_payments_isolation on app.client_payments
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy refund_records_isolation on app.refund_records
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

create policy cancellation_records_isolation on app.cancellation_records
  for all using (app_private.tenant_member_access(tenant_id, true))
  with check (app_private.tenant_member_access(tenant_id, false));

-- 14. PRIVILEGIOS DE EJECUCIÓN Y TABLAS PARA EL ROL RUNTIME
grant select, insert, update on
  app.suppliers,
  app.procurement_reviews,
  app.purchase_orders,
  app.purchase_order_lines,
  app.procurement_receipts,
  app.procurement_receipt_lines,
  app.warehouse_stock,
  app.cabin_stock,
  app.dispatch_records,
  app.dispatch_lines,
  app.payment_terms,
  app.client_payments,
  app.refund_records,
  app.cancellation_records
to tibelio_dev_app;

grant select, insert on app.inventory_movements to tibelio_dev_app;
grant select on app.purchase_order_counters to tibelio_dev_app;
grant execute on function app_private.next_purchase_order_code() to tibelio_dev_app;

-- REVOCAR DELETE AL ROL RUNTIME EN TODAS LAS TABLAS DE OPERACIONES Y FINANZAS (DEC-029)
revoke delete on
  app.suppliers,
  app.procurement_reviews,
  app.purchase_order_counters,
  app.purchase_orders,
  app.purchase_order_lines,
  app.procurement_receipts,
  app.procurement_receipt_lines,
  app.warehouse_stock,
  app.cabin_stock,
  app.inventory_movements,
  app.dispatch_records,
  app.dispatch_lines,
  app.payment_terms,
  app.client_payments,
  app.refund_records,
  app.cancellation_records
from tibelio_dev_app;

revoke update on app.inventory_movements from tibelio_dev_app;
revoke insert, update, delete on app.purchase_order_counters from tibelio_dev_app;

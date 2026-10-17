begin;

-- ====================================================================================
-- Historia 2.2: Solicitudes Comerciales Multicabina y Cabinas Físicas (Subetapa DDL)
-- ====================================================================================

-- 1. Ajustes de unicidad compuesta en tablas vigentes para habilitar integridad referencial
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_addresses_tenant_client_id_uniq') then
    alter table app.client_addresses
      add constraint client_addresses_tenant_client_id_uniq unique (tenant_id, client_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'catalog_products_tenant_id_kind_uniq') then
    alter table app.catalog_products
      add constraint catalog_products_tenant_id_kind_uniq unique (tenant_id, id, kind);
  end if;
end $$;

-- 2. Contador transaccional de solicitudes por empresa y mes UTC
create table if not exists app.commercial_request_counters (
  tenant_id uuid not null references app.tenants(id),
  year_month text not null check (year_month ~ '^[0-9]{6}$'),
  current_val integer not null default 0 check (current_val >= 0),
  primary key (tenant_id, year_month)
);

alter table app.commercial_request_counters enable row level security;
create policy request_counters_read on app.commercial_request_counters
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy request_counters_insert on app.commercial_request_counters
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy request_counters_update on app.commercial_request_counters
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 3. Función de asignación concurrente segura de códigos sin truncamiento
create or replace function app_private.next_commercial_request_code(p_tenant_id uuid default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb := app_private.actor();
  v_tenant_id uuid;
  v_ym text := to_char(now() at time zone 'UTC', 'YYYYMM');
  v_seq integer;
  v_formatted text;
begin
  if v_actor is null or v_actor->>'platformRole' <> 'TENANT' then
    raise exception 'No autenticado o rol no autorizado para generar códigos de solicitud'
      using errcode = '42501';
  end if;

  v_tenant_id := (v_actor->>'tenantId')::uuid;
  if p_tenant_id is not null and p_tenant_id <> v_tenant_id then
    raise exception 'Discrepancia de tenant en generación de código'
      using errcode = '42501';
  end if;

  if not app_private.tenant_member_access(v_tenant_id, true) then
    raise exception 'Suscripción en solo lectura o sin permisos de escritura'
      using errcode = '42501';
  end if;

  insert into app.commercial_request_counters(tenant_id, year_month, current_val)
  values (v_tenant_id, v_ym, 1)
  on conflict (tenant_id, year_month)
  do update set current_val = app.commercial_request_counters.current_val + 1
  returning current_val into v_seq;

  -- Padding de longitud mínima 4 sin truncar secuencias >= 10000
  v_formatted := lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');

  return 'SOL-' || v_ym || '-' || v_formatted;
end;
$$;

-- 4. Cabecera de solicitudes comerciales de obra (acotada a DRAFT en esta subetapa)
create table if not exists app.commercial_requests (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  code text not null,
  client_id uuid not null,
  client_address_id uuid not null,
  zone_id uuid null,
  status text not null default 'DRAFT' check (status = 'DRAFT'),
  notes text null check (notes is null or length(notes) <= 2000),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, client_id, client_address_id)
    references app.client_addresses(tenant_id, client_id, id),
  foreign key (tenant_id, zone_id)
    references app.pricing_zones(tenant_id, id),
  foreign key (tenant_id, created_by)
    references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by)
    references app.users(tenant_id, id),

  unique (tenant_id, code),
  unique (tenant_id, id)
);

create index if not exists commercial_requests_tenant_status on app.commercial_requests(tenant_id, status, created_at desc);
create index if not exists commercial_requests_client on app.commercial_requests(tenant_id, client_id);
create index if not exists commercial_requests_client_address on app.commercial_requests(tenant_id, client_id, client_address_id);
create index if not exists commercial_requests_zone on app.commercial_requests(tenant_id, zone_id);
create index if not exists commercial_requests_created_by on app.commercial_requests(tenant_id, created_by);
create index if not exists commercial_requests_updated_by on app.commercial_requests(tenant_id, updated_by);

alter table app.commercial_requests enable row level security;
create policy requests_read on app.commercial_requests
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy requests_insert on app.commercial_requests
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy requests_update on app.commercial_requests
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 5. Cabinas físicas individuales (DEC-012, DEC-051)
create table if not exists app.request_cabins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  product_id uuid not null,
  product_kind text not null default 'CABIN' check (product_kind = 'CABIN'),
  location_tag text null check (location_tag is null or length(btrim(location_tag)) between 1 and 100),
  custom_width numeric(6,2) null check (custom_width is null or custom_width > 0),
  custom_height numeric(6,2) null check (custom_height is null or custom_height > 0),
  notes text null check (notes is null or length(notes) <= 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, request_id)
    references app.commercial_requests(tenant_id, id) on delete restrict,
  foreign key (tenant_id, product_id, product_kind)
    references app.catalog_products(tenant_id, id, kind),
  foreign key (tenant_id, created_by)
    references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by)
    references app.users(tenant_id, id),

  unique (tenant_id, id)
);

create index if not exists request_cabins_lookup on app.request_cabins(tenant_id, request_id, active);
create index if not exists request_cabins_product on app.request_cabins(tenant_id, product_id, product_kind);
create index if not exists request_cabins_created_by on app.request_cabins(tenant_id, created_by);
create index if not exists request_cabins_updated_by on app.request_cabins(tenant_id, updated_by);

alter table app.request_cabins enable row level security;
create policy request_cabins_read on app.request_cabins
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy request_cabins_insert on app.request_cabins
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy request_cabins_update on app.request_cabins
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 6. Ítems complementarios (accesorios e insumos, exclusivamente no cabinas)
create table if not exists app.request_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  product_id uuid not null,
  product_kind text not null check (product_kind in ('ACCESSORY', 'MATERIAL')),
  quantity integer not null default 1 check (quantity > 0),
  notes text null check (notes is null or length(notes) <= 500),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, request_id)
    references app.commercial_requests(tenant_id, id) on delete restrict,
  foreign key (tenant_id, product_id, product_kind)
    references app.catalog_products(tenant_id, id, kind),
  foreign key (tenant_id, created_by)
    references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by)
    references app.users(tenant_id, id),

  unique (tenant_id, id)
);

create index if not exists request_items_lookup on app.request_items(tenant_id, request_id, active);
create index if not exists request_items_product on app.request_items(tenant_id, product_id, product_kind);
create index if not exists request_items_created_by on app.request_items(tenant_id, created_by);
create index if not exists request_items_updated_by on app.request_items(tenant_id, updated_by);

alter table app.request_items enable row level security;
create policy request_items_read on app.request_items
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy request_items_insert on app.request_items
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy request_items_update on app.request_items
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 7. Privilegios y revocaciones de seguridad
revoke all on function app_private.next_commercial_request_code(uuid) from public;
revoke all on app.commercial_requests, app.request_cabins, app.request_items, app.commercial_request_counters from public;

do $$ declare api_role text; begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function app_private.next_commercial_request_code(uuid) from %I', api_role);
      execute format('revoke all on app.commercial_requests, app.request_cabins, app.request_items, app.commercial_request_counters from %I', api_role);
    end if;
  end loop;
end $$;

-- Concesiones restringidas al rol runtime: SELECT, INSERT, UPDATE (sin DELETE)
grant execute on function app_private.next_commercial_request_code(uuid) to tibelio_dev_app;
grant select, insert, update on app.commercial_requests, app.request_cabins, app.request_items, app.commercial_request_counters to tibelio_dev_app;

commit;

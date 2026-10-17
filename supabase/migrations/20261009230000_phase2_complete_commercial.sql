-- Migración incremental: Fase 2 Completa — Solicitudes, Cotizaciones, Versiones, Ajustes y Documentos
-- Referencias: COM-001..006, COT-001..012, DEC-008, DEC-012, DEC-029, DEC-044, DEC-051, DEC-052, DEC-059

-- 1. Ampliación de Solicitudes y Unidades Físicas (F2-A)
alter table app.commercial_requests
  add column if not exists revision integer not null default 1;

alter table app.commercial_requests
  drop constraint if exists commercial_requests_status_check;

alter table app.commercial_requests
  add constraint commercial_requests_status_check
  check (status in ('DRAFT', 'QUOTED', 'COMPLETED', 'CANCELLED'));

alter table app.request_cabins
  add column if not exists finish varchar(100) null;

alter table app.request_items
  add column if not exists cabin_id uuid null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'request_items_cabin_fk'
  ) then
    alter table app.request_items
      add constraint request_items_cabin_fk
      foreign key (tenant_id, cabin_id)
      references app.request_cabins(tenant_id, id)
      on delete restrict;
  end if;
end $$;

-- 2. Configuración Comercial por Empresa (F2-B)
create table if not exists app.commercial_settings (
  tenant_id uuid primary key references app.tenants(id),
  currency varchar(3) not null default 'COP',
  tax_rate numeric(6,4) not null default 0.1900 check (tax_rate >= 0),
  tax_included boolean not null default false,
  default_validity_days integer not null default 15 check (default_validity_days > 0),
  target_margin numeric(6,4) not null default 0.3500 check (target_margin >= 0 and target_margin < 1),
  min_margin numeric(6,4) not null default 0.2000 check (min_margin >= 0 and min_margin < 1),
  default_payment_terms varchar(255) null,
  notes text null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, updated_by) references app.users(tenant_id, id)
);

alter table app.commercial_settings enable row level security;
create policy commercial_settings_read on app.commercial_settings
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy commercial_settings_insert on app.commercial_settings
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy commercial_settings_update on app.commercial_settings
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 3. Consecutivo Seguro de Cotizaciones (COT-YYYYMM-XXXX) (F2-C)
create table if not exists app.commercial_quotation_counters (
  tenant_id uuid not null references app.tenants(id),
  year_month varchar(6) not null,
  current_val integer not null default 0 check (current_val >= 0),
  primary key (tenant_id, year_month)
);

alter table app.commercial_quotation_counters enable row level security;
create policy quotation_counters_read on app.commercial_quotation_counters
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));

create or replace function app_private.next_commercial_quotation_code(p_tenant_id uuid default null)
returns text language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb := app_private.actor();
  v_tenant_id uuid;
  v_ym text := to_char(now() at time zone 'UTC', 'YYYYMM');
  v_seq integer;
  v_formatted text;
begin
  if v_actor is null or v_actor->>'platformRole' <> 'TENANT' then
    raise exception 'No autenticado o rol no autorizado para generar códigos de cotización'
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

  insert into app.commercial_quotation_counters(tenant_id, year_month, current_val)
  values (v_tenant_id, v_ym, 1)
  on conflict (tenant_id, year_month)
  do update set current_val = app.commercial_quotation_counters.current_val + 1
  returning current_val into v_seq;

  v_formatted := lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');

  return 'COT-' || v_ym || '-' || v_formatted;
end;
$$;

-- 4. Cabecera de Cotizaciones (F2-C)
create table if not exists app.quotations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  code varchar(30) not null,
  version integer not null default 1 check (version >= 1),
  status varchar(20) not null check (status in ('DRAFT', 'SENT', 'APPROVED', 'REJECTED', 'EXPIRED')),
  pricing_method varchar(20) not null check (pricing_method in ('CATALOG_PRICE', 'COST_MARGIN')),
  currency varchar(3) not null default 'COP',
  subtotal numeric(18,2) not null check (subtotal >= 0),
  tax_rate numeric(6,4) not null check (tax_rate >= 0),
  tax_amount numeric(18,2) not null check (tax_amount >= 0),
  total_amount numeric(18,2) not null check (total_amount >= 0),
  target_margin numeric(6,4) null,
  min_margin numeric(6,4) null,
  snapshot jsonb not null,
  validity_days integer not null check (validity_days > 0),
  expires_at timestamptz not null,
  sent_at timestamptz null,
  approved_at timestamptz null,
  approved_by uuid null,
  rejection_reason text null,
  revision integer not null default 1 check (revision >= 1),
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id) on delete restrict,
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  foreign key (tenant_id, approved_by) references app.users(tenant_id, id),

  unique (tenant_id, code, version),
  unique (tenant_id, id)
);

create index if not exists quotations_tenant_status on app.quotations(tenant_id, status, created_at desc);
create index if not exists quotations_request on app.quotations(tenant_id, request_id);
create index if not exists quotations_code on app.quotations(tenant_id, code);

alter table app.quotations enable row level security;
create policy quotations_read on app.quotations
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy quotations_insert on app.quotations
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy quotations_update on app.quotations
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 5. Líneas de Cabina de Cotización (F2-C)
create table if not exists app.quotation_cabins (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  quotation_id uuid not null,
  cabin_id uuid not null,
  product_id uuid not null,
  product_name varchar(160) not null,
  product_sku varchar(64) not null,
  location_tag varchar(100) null,
  finish varchar(100) null,
  custom_width numeric(6,2) null check (custom_width is null or custom_width > 0),
  custom_height numeric(6,2) null check (custom_height is null or custom_height > 0),
  warranty_terms text null,
  base_cost numeric(18,2) null check (base_cost is null or base_cost >= 0),
  list_price numeric(18,2) null check (list_price is null or list_price >= 0),
  sale_price numeric(18,2) not null check (sale_price >= 0),
  notes text null,
  created_at timestamptz not null default now(),

  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id) on delete cascade,
  foreign key (tenant_id, cabin_id) references app.request_cabins(tenant_id, id) on delete restrict,
  unique (tenant_id, id)
);

create index if not exists quotation_cabins_quotation on app.quotation_cabins(tenant_id, quotation_id);
create index if not exists quotation_cabins_cabin on app.quotation_cabins(tenant_id, cabin_id);

alter table app.quotation_cabins enable row level security;
create policy quotation_cabins_read on app.quotation_cabins
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy quotation_cabins_insert on app.quotation_cabins
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy quotation_cabins_update on app.quotation_cabins
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 6. Líneas de Ítems / Servicios de Cotización (F2-C)
create table if not exists app.quotation_items (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  quotation_id uuid not null,
  request_item_id uuid null,
  cabin_id uuid null,
  concept varchar(160) not null,
  item_type varchar(20) not null check (item_type in ('ACCESSORY', 'MATERIAL', 'TRANSPORT', 'INSTALLATION', 'SERVICE')),
  quantity integer not null check (quantity > 0),
  unit_cost numeric(18,2) null check (unit_cost is null or unit_cost >= 0),
  unit_price numeric(18,2) not null check (unit_price >= 0),
  total_price numeric(18,2) not null check (total_price >= 0),
  notes text null,
  created_at timestamptz not null default now(),

  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id) on delete cascade,
  unique (tenant_id, id)
);

create index if not exists quotation_items_quotation on app.quotation_items(tenant_id, quotation_id);

alter table app.quotation_items enable row level security;
create policy quotation_items_read on app.quotation_items
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy quotation_items_insert on app.quotation_items
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy quotation_items_update on app.quotation_items
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 7. Documentos y Evidencias Privadas de Cotización (F2-C, F2-D)
create table if not exists app.quotation_documents (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  quotation_id uuid not null,
  document_type varchar(30) not null check (document_type in ('PDF', 'APPROVAL_EVIDENCE', 'ADJUSTMENT_EVIDENCE')),
  filename varchar(255) not null,
  storage_path varchar(500) not null,
  file_size integer not null check (file_size > 0),
  mime_type varchar(100) not null,
  sha256 varchar(64) not null,
  created_by uuid not null,
  created_at timestamptz not null default now(),

  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id) on delete restrict,
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists quotation_docs_quotation on app.quotation_documents(tenant_id, quotation_id, document_type);

alter table app.quotation_documents enable row level security;
create policy quotation_docs_read on app.quotation_documents
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy quotation_docs_insert on app.quotation_documents
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));

-- 8. Notas de Ajuste (F2-D, DEC-044, DEC-052)
create table if not exists app.quotation_adjustments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  quotation_id uuid not null,
  code varchar(30) not null,
  adjustment_type varchar(20) not null check (adjustment_type in ('INCREASE', 'DECREASE')),
  amount numeric(18,2) not null check (amount > 0),
  reason text not null,
  requires_client_approval boolean not null,
  client_approved_at timestamptz null,
  client_evidence_id uuid null,
  status varchar(20) not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  authorized_by uuid null,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id) on delete restrict,
  foreign key (tenant_id, client_evidence_id) references app.quotation_documents(tenant_id, id),
  foreign key (tenant_id, authorized_by) references app.users(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, code),
  unique (tenant_id, id)
);

create index if not exists quotation_adjustments_quotation on app.quotation_adjustments(tenant_id, quotation_id);

alter table app.quotation_adjustments enable row level security;
create policy quotation_adjustments_read on app.quotation_adjustments
  for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy quotation_adjustments_insert on app.quotation_adjustments
  for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy quotation_adjustments_update on app.quotation_adjustments
  for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- 9. Trigger de Integridad y Auditoría para Cotizaciones y Ajustes
create or replace function app_private.commercial_quotation_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb := app_private.actor();
  v_actor_user_id uuid;
  v_actor_tenant_id uuid;
begin
  if session_user not in ('tibelio_dev_app') then
    if v_actor is null then
      return coalesce(NEW, OLD);
    end if;
  end if;

  if v_actor is null or v_actor->>'platformRole' <> 'TENANT' then
    raise exception 'Sesión requerida para mutar cotizaciones comerciales'
      using errcode = '42501';
  end if;

  v_actor_user_id := (v_actor->>'userId')::uuid;
  v_actor_tenant_id := (v_actor->>'tenantId')::uuid;

  if NEW.tenant_id <> v_actor_tenant_id then
    raise exception 'Discrepancia de empresa con el actor de sesión'
      using errcode = '42501';
  end if;

  if tg_op = 'INSERT' then
    if NEW.created_by is not null and NEW.created_by <> v_actor_user_id then
      raise exception 'created_by no coincide con el actor autenticado'
        using errcode = '42501';
    end if;
    if NEW.updated_by is not null and NEW.updated_by <> v_actor_user_id then
      raise exception 'updated_by no coincide con el actor autenticado'
        using errcode = '42501';
    end if;

    NEW.created_by := v_actor_user_id;
    NEW.updated_by := v_actor_user_id;
    NEW.created_at := now();
    NEW.updated_at := now();

    return NEW;

  elsif tg_op = 'UPDATE' then
    if NEW.id <> OLD.id then
      raise exception 'El identificador es inmutable' using errcode = '42501';
    end if;
    if NEW.tenant_id <> OLD.tenant_id then
      raise exception 'La empresa es inmutable' using errcode = '42501';
    end if;
    if NEW.created_by <> OLD.created_by then
      raise exception 'El autor de creación es inmutable' using errcode = '42501';
    end if;
    if NEW.created_at <> OLD.created_at then
      raise exception 'La fecha de creación es inmutable' using errcode = '42501';
    end if;

    if tg_table_name = 'quotations' then
      if NEW.code <> OLD.code then
        raise exception 'El código de cotización es inmutable' using errcode = '42501';
      end if;
      if NEW.request_id <> OLD.request_id then
        raise exception 'La solicitud vinculada es inmutable' using errcode = '42501';
      end if;
      if NEW.version <> OLD.version then
        raise exception 'El número de versión es inmutable' using errcode = '42501';
      end if;
      -- Si ya está aprobada, no permite modificar montos ni método
      if OLD.status = 'APPROVED' and (
        NEW.subtotal <> OLD.subtotal or
        NEW.tax_amount <> OLD.tax_amount or
        NEW.total_amount <> OLD.total_amount or
        NEW.pricing_method <> OLD.pricing_method
      ) then
        raise exception 'Una versión aprobada es inmutable en sus valores comerciales'
          using errcode = '42501';
      end if;
    elsif tg_table_name = 'quotation_adjustments' then
      if NEW.code <> OLD.code then
        raise exception 'El código del ajuste es inmutable' using errcode = '42501';
      end if;
      if NEW.quotation_id <> OLD.quotation_id then
        raise exception 'La cotización vinculada al ajuste es inmutable' using errcode = '42501';
      end if;
    end if;

    NEW.created_by := OLD.created_by;
    NEW.created_at := OLD.created_at;
    NEW.updated_by := v_actor_user_id;
    NEW.updated_at := now();

    return NEW;
  end if;

  return NEW;
end;
$$;

drop trigger if exists quotation_integrity_trigger on app.quotations;
create trigger quotation_integrity_trigger
  before insert or update on app.quotations
  for each row execute function app_private.commercial_quotation_integrity();

drop trigger if exists adjustment_integrity_trigger on app.quotation_adjustments;
create trigger adjustment_integrity_trigger
  before insert or update on app.quotation_adjustments
  for each row execute function app_private.commercial_quotation_integrity();

-- 10. Concesiones y Revocaciones de Privilegios para tibelio_dev_app
grant select, insert, update on app.commercial_settings to tibelio_dev_app;
grant select, insert, update on app.quotations to tibelio_dev_app;
grant select, insert, update on app.quotation_cabins to tibelio_dev_app;
grant select, insert, update on app.quotation_items to tibelio_dev_app;
grant select, insert on app.quotation_documents to tibelio_dev_app;
grant select, insert, update on app.quotation_adjustments to tibelio_dev_app;
grant select on app.commercial_quotation_counters to tibelio_dev_app;
grant execute on function app_private.next_commercial_quotation_code(uuid) to tibelio_dev_app;

-- Revocar mutación directa del contador de cotizaciones a tibelio_dev_app (H22-03)
revoke insert, update, delete on app.commercial_quotation_counters from tibelio_dev_app;
revoke delete on app.commercial_settings from tibelio_dev_app;
revoke delete on app.quotations from tibelio_dev_app;
revoke delete on app.quotation_cabins from tibelio_dev_app;
revoke delete on app.quotation_items from tibelio_dev_app;
revoke delete on app.quotation_documents from tibelio_dev_app;
revoke delete on app.quotation_adjustments from tibelio_dev_app;

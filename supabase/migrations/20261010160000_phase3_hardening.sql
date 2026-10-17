-- Migración Incremental Fase 3: Endurecimiento, Consecutivos Seguros, Versionado de Condiciones y Liquidación
-- Referencias Maestras: COM-005, COM-006, COT-011, COT-012, DEC-008, DEC-012, DEC-025, DEC-029, DEC-044, DEC-051, DEC-052, DEC-060
-- Criterios de Aceptación: AT-08, AT-09, AT-10, AT-10b, AT-11, AT-12, AT-13, AT-17, AT-18

begin;

-- 1. CONSECUTIVOS DE ÓRDENES DE COMPRA (OC-YYYYMM-XXXX) CON ACTOR JSONB Y PERMISOS SEGUROS
drop function if exists app_private.next_purchase_order_code();
drop function if exists app_private.next_purchase_order_code(uuid);

create or replace function app_private.next_purchase_order_code(p_tenant_id uuid default null)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor jsonb := app_private.actor();
  v_tenant_id uuid;
  v_month text;
  v_seq integer;
  v_formatted text;
begin
  if v_actor is null or v_actor->>'platformRole' <> 'TENANT' then
    raise exception 'No autenticado o rol no autorizado para generar orden de compra'
      using errcode = '42501';
  end if;

  v_tenant_id := (v_actor->>'tenantId')::uuid;
  if p_tenant_id is not null and p_tenant_id <> v_tenant_id then
    raise exception 'Discrepancia de tenant en generacion de orden de compra'
      using errcode = '42501';
  end if;

  if not app_private.tenant_member_access(v_tenant_id, true) then
    raise exception 'Suscripcion en solo lectura o sin permisos de escritura'
      using errcode = '42501';
  end if;

  v_month := to_char(now() at time zone 'UTC', 'YYYYMM');

  insert into app.purchase_order_counters(tenant_id, year_month, last_value, updated_at)
  values (v_tenant_id, v_month, 1, now())
  on conflict (tenant_id, year_month)
  do update set
    last_value = app.purchase_order_counters.last_value + 1,
    updated_at = now()
  returning last_value into v_seq;

  v_formatted := lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');

  return 'OC-' || v_month || '-' || v_formatted;
end;
$$;

revoke all on function app_private.next_purchase_order_code(uuid) from public;

do $$ declare api_role text; begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function app_private.next_purchase_order_code(uuid) from %I', api_role);
    end if;
  end loop;
end $$;

grant execute on function app_private.next_purchase_order_code(uuid) to tibelio_dev_app;

-- 2. CONDICIONES DE PAGO VERSIONADAS Y NO DESTRUCTIVAS (DEC-029)
alter table app.payment_terms
  add column if not exists version integer not null default 1 check (version >= 1),
  add column if not exists active boolean not null default true;

create index if not exists payment_terms_lookup on app.payment_terms(tenant_id, quotation_id, active);

-- 3. CABINAS FÍSICAS EN STOCK: ESTADOS AMPLIADOS Y REASIGNACIÓN TRAZABLE (DEC-051)
alter table app.cabin_stock
  drop constraint if exists cabin_stock_status_check;

alter table app.cabin_stock
  add constraint cabin_stock_status_check
  check (status in ('IN_STOCK', 'ASSIGNED', 'DISPATCHED', 'RETURNED', 'DAMAGED', 'MAINTENANCE'));

alter table app.cabin_stock
  add column if not exists notes text null check (notes is null or length(notes) <= 1000),
  add column if not exists released_from_request_id uuid null,
  add column if not exists reassigned_at timestamptz null,
  add column if not exists reassigned_by uuid null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'cabin_stock_released_from_fk') then
    alter table app.cabin_stock
      add constraint cabin_stock_released_from_fk
      foreign key (tenant_id, released_from_request_id) references app.commercial_requests(tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cabin_stock_reassigned_by_fk') then
    alter table app.cabin_stock
      add constraint cabin_stock_reassigned_by_fk
      foreign key (tenant_id, reassigned_by) references app.users(tenant_id, id);
  end if;
end $$;

-- 4. PAGOS DE CLIENTES: ANULACIÓN AUDITADA (DEC-029, DEC-060)
alter table app.client_payments
  drop constraint if exists client_payments_status_check;

alter table app.client_payments
  add constraint client_payments_status_check
  check (status in ('PENDING', 'VALIDATED', 'REJECTED', 'ANNULLED'));

alter table app.client_payments
  add column if not exists annulment_reason text null check (annulment_reason is null or length(btrim(annulment_reason)) >= 3),
  add column if not exists validated_by uuid null,
  add column if not exists validated_at timestamptz null,
  add column if not exists annulled_by uuid null,
  add column if not exists annulled_at timestamptz null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'client_payments_validated_by_fk') then
    alter table app.client_payments
      add constraint client_payments_validated_by_fk
      foreign key (tenant_id, validated_by) references app.users(tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'client_payments_annulled_by_fk') then
    alter table app.client_payments
      add constraint client_payments_annulled_by_fk
      foreign key (tenant_id, annulled_by) references app.users(tenant_id, id);
  end if;
end $$;

-- 5. REEMBOLSOS: DISTINCIÓN ENTRE AUTORIZACIÓN Y DESEMBOLSO EFECTIVO (DEC-052)
alter table app.refund_records
  add column if not exists status text not null default 'AUTHORIZED' check (status in ('AUTHORIZED', 'DISBURSED')),
  add column if not exists receipt_file_id uuid null,
  add column if not exists receipt_byte_size integer not null default 0,
  add column if not exists receipt_sha256 text not null default '',
  add column if not exists receipt_mime_type text not null default 'application/pdf',
  add column if not exists disbursed_at timestamptz null,
  add column if not exists disbursed_by uuid null;

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'refund_records_disbursed_by_fk') then
    alter table app.refund_records
      add constraint refund_records_disbursed_by_fk
      foreign key (tenant_id, disbursed_by) references app.users(tenant_id, id);
  end if;
end $$;

-- 6. SOLICITUDES COMERCIALES: AUDITORÍA DE CANCELACIÓN Y PRIORIDAD
alter table app.commercial_requests
  add column if not exists priority text not null default 'NORMAL' check (priority in ('LOW', 'NORMAL', 'HIGH', 'URGENT')),
  add column if not exists cancelled_at timestamptz null,
  add column if not exists cancelled_by uuid null,
  add column if not exists cancellation_reason text null check (cancellation_reason is null or length(btrim(cancellation_reason)) >= 5);

do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'commercial_requests_cancelled_by_fk') then
    alter table app.commercial_requests
      add constraint commercial_requests_cancelled_by_fk
      foreign key (tenant_id, cancelled_by) references app.users(tenant_id, id);
  end if;
end $$;

commit;

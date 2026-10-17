-- ============================================================================
-- MIGRACIÓN FASE 5: GARANTÍAS, NOVEDADES, COSTOS REALES, REPORTES Y ALERTAS
-- Fecha: 2026-10-12
-- ============================================================================

-- 1. Contadores seguros de códigos de garantía
create table if not exists app.warranty_counters (
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    year_month text not null check (year_month ~ '^\d{6}$'),
    last_number integer not null check (last_number >= 0),
    primary key (tenant_id, year_month)
);

create or replace function app_private.next_warranty_code()
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
    v_actor jsonb;
    v_tenant_id uuid;
    v_ym text;
    v_seq integer;
begin
    v_actor := app_private.actor();
    if v_actor is null or (v_actor->>'platformRole') is distinct from 'TENANT' then
        raise exception 'Actor no autorizado' using errcode = '42501';
    end if;

    v_tenant_id := (v_actor->>'tenantId')::uuid;
    perform app_private.lock_tenant(v_tenant_id);

    v_ym := to_char(timezone('UTC', now()), 'YYYYMM');

    insert into app.warranty_counters(tenant_id, year_month, last_number)
    values (v_tenant_id, v_ym, 1)
    on conflict (tenant_id, year_month)
    do update set last_number = app.warranty_counters.last_number + 1
    returning last_number into v_seq;

    return 'GAR-' || v_ym || '-' || lpad(v_seq::text, greatest(4, length(v_seq::text)), '0');
end;
$$;

-- 2. Garantías por cabina física individual (GAR-002..007, DEC-030, DEC-032, DEC-051)
create table if not exists app.warranties (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    code text not null,
    request_id uuid not null,
    cabin_id uuid not null,
    product_id uuid not null references app.catalog_products(id) on delete restrict,
    status text not null default 'REGISTERED' check (status in ('REGISTERED', 'IN_REVIEW', 'ACCEPTED', 'REJECTED', 'IN_PROGRESS', 'RESOLVED', 'CLOSED')),
    claim_type text not null check (claim_type in ('ACOUSTIC_DEFECT', 'STRUCTURAL_DEFECT', 'HARDWARE_DEFECT', 'FINISH_DEFECT', 'INSTALLATION_DEFECT', 'OTHER')),
    description text not null check (length(trim(description)) >= 5),
    warranty_terms_snapshot jsonb null,
    rejection_reason text null,
    is_replacement boolean not null default false,
    replacement_cabin_id uuid null,
    assigned_to uuid null references app.users(id) on delete set null,
    resolved_at timestamptz null,
    resolved_by uuid null references app.users(id) on delete set null,
    resolution_notes text null,
    created_at timestamptz not null default now(),
    created_by uuid not null references app.users(id) on delete restrict,
    updated_at timestamptz not null default now(),
    updated_by uuid not null references app.users(id) on delete restrict,
    constraint warranties_unique_code unique (tenant_id, code),
    constraint warranties_request_fk foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id) on delete restrict,
    constraint warranties_cabin_fk foreign key (tenant_id, cabin_id) references app.cabin_stock(tenant_id, cabin_id) on delete restrict,
    constraint warranties_rejection_check check (
        status <> 'REJECTED' or (rejection_reason is not null and length(trim(rejection_reason)) > 0)
    ),
    constraint warranties_resolution_check check (
        status <> 'RESOLVED' or (resolved_at is not null and resolution_notes is not null and length(trim(resolution_notes)) > 0)
    )
);

create index if not exists idx_warranties_tenant_request on app.warranties(tenant_id, request_id);
create index if not exists idx_warranties_tenant_cabin on app.warranties(tenant_id, cabin_id);
create index if not exists idx_warranties_tenant_product on app.warranties(tenant_id, product_id);
create index if not exists idx_warranties_tenant_assigned on app.warranties(tenant_id, assigned_to);
create index if not exists idx_warranties_tenant_status on app.warranties(tenant_id, status);

-- 3. Fotografías de evidencia y resolución de garantía
create table if not exists app.warranty_photos (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    warranty_id uuid not null references app.warranties(id) on delete cascade,
    file_id uuid not null,
    byte_size integer not null default 0,
    sha256 text not null default '',
    mime_type text not null default 'image/jpeg',
    caption text null,
    photo_phase text not null default 'REPORT' check (photo_phase in ('REPORT', 'INSPECTION', 'RESOLUTION')),
    created_at timestamptz not null default now(),
    created_by uuid not null references app.users(id) on delete restrict
);

create index if not exists idx_warranty_photos_tenant_warranty on app.warranty_photos(tenant_id, warranty_id);

-- 4. Novedades operativas de visita, compras, transporte e instalación (GAR-001, GAR-005)
create table if not exists app.operational_issues (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    request_id uuid not null,
    stage text not null check (stage in ('VISIT', 'PROCUREMENT', 'TRANSPORT', 'INSTALLATION', 'WARRANTY')),
    reference_id uuid null,
    title text not null check (length(trim(title)) >= 3),
    description text not null check (length(trim(description)) >= 5),
    severity text not null default 'MEDIUM' check (severity in ('LOW', 'MEDIUM', 'HIGH', 'BLOCKING')),
    status text not null default 'OPEN' check (status in ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CANCELLED')),
    evidence_file_id uuid null,
    evidence_byte_size integer null,
    evidence_sha256 text null,
    evidence_mime_type text null,
    assigned_to uuid null references app.users(id) on delete set null,
    resolved_at timestamptz null,
    resolved_by uuid null references app.users(id) on delete set null,
    resolution_notes text null,
    created_at timestamptz not null default now(),
    created_by uuid not null references app.users(id) on delete restrict,
    updated_at timestamptz not null default now(),
    updated_by uuid not null references app.users(id) on delete restrict,
    constraint operational_issues_request_fk foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id) on delete restrict
);

create index if not exists idx_operational_issues_tenant_request on app.operational_issues(tenant_id, request_id);
create index if not exists idx_operational_issues_tenant_assigned on app.operational_issues(tenant_id, assigned_to);
create index if not exists idx_operational_issues_tenant_status on app.operational_issues(tenant_id, status);

-- 5. Costos operativos reales imputados contra la solicitud original (FIN-007, DEC-008)
create table if not exists app.operational_costs (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    request_id uuid not null,
    category text not null check (category in ('PURCHASE', 'INSTALLATION', 'TRANSPORT', 'PER_DIEM', 'MATERIAL', 'REWORK', 'WARRANTY', 'OTHER')),
    concept text not null check (length(trim(concept)) >= 3),
    amount numeric(18,2) not null check (amount > 0),
    reference_id uuid null,
    voucher_file_id uuid null,
    voucher_byte_size integer null,
    voucher_sha256 text null,
    voucher_mime_type text null,
    active boolean not null default true,
    annulled_at timestamptz null,
    annulled_by uuid null references app.users(id) on delete set null,
    annulment_reason text null,
    created_at timestamptz not null default now(),
    created_by uuid not null references app.users(id) on delete restrict,
    updated_at timestamptz not null default now(),
    updated_by uuid not null references app.users(id) on delete restrict,
    constraint operational_costs_request_fk foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id) on delete restrict
);

create index if not exists idx_operational_costs_tenant_request on app.operational_costs(tenant_id, request_id);
create index if not exists idx_operational_costs_tenant_active on app.operational_costs(tenant_id, active);

-- 6. Centro interno persistente de alertas y notificaciones (REP-004, REP-005)
create table if not exists app.internal_notifications (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    user_id uuid null references app.users(id) on delete cascade,
    event_type text not null check (event_type in ('PENDING_TASK', 'OVERDUE_PAYMENT', 'DELAYED_OPERATION', 'BLOCKING_ISSUE', 'WARRANTY_CLAIM', 'STOCK_ALERT')),
    title text not null check (length(trim(title)) >= 3),
    message text not null check (length(trim(message)) >= 5),
    reference_type text null check (reference_type in ('REQUEST', 'TASK', 'PAYMENT', 'ISSUE', 'WARRANTY', 'STOCK')),
    reference_id uuid null,
    dedup_key text null,
    read_at timestamptz null,
    read_by uuid null references app.users(id) on delete set null,
    created_at timestamptz not null default now(),
    constraint internal_notifications_dedup_unique unique nulls not distinct (tenant_id, dedup_key)
);

create index if not exists idx_internal_notifications_tenant_user on app.internal_notifications(tenant_id, user_id);
create index if not exists idx_internal_notifications_tenant_read on app.internal_notifications(tenant_id, read_at);
create index if not exists idx_internal_notifications_tenant_created on app.internal_notifications(tenant_id, created_at desc);

-- 7. Revocar mutación destructiva física (DELETE)
revoke delete on app.warranty_counters from public, tibelio_dev_app;
revoke delete on app.warranties from public, tibelio_dev_app;
revoke delete on app.warranty_photos from public, tibelio_dev_app;
revoke delete on app.operational_issues from public, tibelio_dev_app;
revoke delete on app.operational_costs from public, tibelio_dev_app;

-- Otorgar privilegios de aplicación
grant select, insert, update on app.warranty_counters to tibelio_dev_app;
grant execute on function app_private.next_warranty_code to tibelio_dev_app;

grant select, insert, update on app.warranties to tibelio_dev_app;
grant select, insert, update on app.warranty_photos to tibelio_dev_app;
grant select, insert, update on app.operational_issues to tibelio_dev_app;
grant select, insert, update on app.operational_costs to tibelio_dev_app;
grant select, insert, update, delete on app.internal_notifications to tibelio_dev_app;

-- 8. Seguridad a nivel de fila (RLS Deny-Default)
alter table app.warranty_counters enable row level security;
create policy warranty_counters_tenant_access on app.warranty_counters
    using (app_private.tenant_member_access(tenant_id, false))
    with check (app_private.tenant_member_access(tenant_id, true));

alter table app.warranties enable row level security;
create policy warranties_tenant_access on app.warranties
    using (app_private.tenant_member_access(tenant_id, false))
    with check (app_private.tenant_member_access(tenant_id, true));

alter table app.warranty_photos enable row level security;
create policy warranty_photos_tenant_access on app.warranty_photos
    using (app_private.tenant_member_access(tenant_id, false))
    with check (app_private.tenant_member_access(tenant_id, true));

alter table app.operational_issues enable row level security;
create policy operational_issues_tenant_access on app.operational_issues
    using (app_private.tenant_member_access(tenant_id, false))
    with check (app_private.tenant_member_access(tenant_id, true));

alter table app.operational_costs enable row level security;
create policy operational_costs_tenant_access on app.operational_costs
    using (app_private.tenant_member_access(tenant_id, false))
    with check (app_private.tenant_member_access(tenant_id, true));

alter table app.internal_notifications enable row level security;
create policy internal_notifications_tenant_access on app.internal_notifications
    using (app_private.tenant_member_access(tenant_id, false))
    with check (app_private.tenant_member_access(tenant_id, true));

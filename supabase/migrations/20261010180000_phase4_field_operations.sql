-- Migración Incremental Fase 4: Operaciones de Campo, Visitas, Tareas, Transporte, Instalación Conjunta y Cierre Operativo
-- Referencias Maestras: DEC-008, DEC-012, DEC-029, DEC-051, DEC-056, DEC-060, OPE-001..008, GAR-001
-- Criterios de Aceptación: AT-14, AT-15, AT-16, AT-19

begin;

-- 1. VISITAS TÉCNICAS Y AGENDA (4.1)
create table if not exists app.field_visits (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  assigned_technician_id uuid not null,
  scheduled_date date not null,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  observations text null check (observations is null or length(observations) <= 1000),
  started_at timestamptz null,
  completed_at timestamptz null,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, assigned_technician_id) references app.users(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists field_visits_request on app.field_visits(tenant_id, request_id, status);
create index if not exists field_visits_agenda on app.field_visits(tenant_id, assigned_technician_id, scheduled_date);

-- 2. MEDIDAS DETALLADAS POR CABINA EN VISITA (4.1)
create table if not exists app.field_visit_cabin_measures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  visit_id uuid not null,
  cabin_id uuid not null,
  width_mm numeric(10,2) not null check (width_mm > 0),
  height_mm numeric(10,2) not null check (height_mm > 0),
  depth_mm numeric(10,2) not null check (depth_mm > 0),
  observations text null check (observations is null or length(observations) <= 1000),
  created_at timestamptz not null default now(),

  foreign key (tenant_id, visit_id) references app.field_visits(tenant_id, id) on delete cascade,
  foreign key (tenant_id, cabin_id) references app.request_cabins(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, visit_id, cabin_id)
);

create index if not exists visit_measures_cabin on app.field_visit_cabin_measures(tenant_id, cabin_id);

-- 3. TAREAS DE CAMPO Y TRANSPORTE (4.2)
create table if not exists app.field_tasks (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  task_type text not null check (task_type in ('VISIT', 'TRANSPORT', 'INSTALLATION', 'MAINTENANCE')),
  assigned_to uuid not null,
  scheduled_date date not null,
  status text not null default 'SCHEDULED' check (status in ('SCHEDULED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  title text not null check (length(btrim(title)) between 3 and 200),
  description text null check (description is null or length(description) <= 1000),
  stop_order integer null default 1 check (stop_order is null or stop_order >= 1),
  notes text null check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, assigned_to) references app.users(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists field_tasks_schedule on app.field_tasks(tenant_id, assigned_to, scheduled_date);
create index if not exists field_tasks_request on app.field_tasks(tenant_id, request_id, status);

-- 4. RUTAS Y PARADAS MULTI-DESTINO (4.2)
create table if not exists app.field_routes (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  driver_id uuid not null,
  route_date date not null,
  title text not null check (length(btrim(title)) between 3 and 200),
  status text not null default 'PLANNED' check (status in ('PLANNED', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED')),
  vehicle_plate text null check (vehicle_plate is null or length(btrim(vehicle_plate)) between 3 and 20),
  notes text null check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, driver_id) references app.users(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists field_routes_lookup on app.field_routes(tenant_id, driver_id, route_date);

create table if not exists app.field_route_stops (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  route_id uuid not null,
  request_id uuid not null,
  task_id uuid null,
  stop_order integer not null check (stop_order >= 1),
  address text not null check (length(btrim(address)) >= 3),
  contact_name text null check (contact_name is null or length(btrim(contact_name)) <= 150),
  contact_phone text null check (contact_phone is null or length(btrim(contact_phone)) <= 30),
  status text not null default 'PENDING' check (status in ('PENDING', 'ARRIVED', 'COMPLETED', 'SKIPPED')),
  notes text null check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),

  foreign key (tenant_id, route_id) references app.field_routes(tenant_id, id) on delete cascade,
  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, task_id) references app.field_tasks(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, route_id, stop_order)
);

-- 5. EVENTOS DE UBICACIÓN Y SALIDA/LLEGADA CON GPS OPCIONAL (4.2)
create table if not exists app.field_location_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  task_id uuid not null,
  event_type text not null check (event_type in ('DEPARTURE', 'ARRIVAL', 'CHECKPOINT')),
  latitude numeric(10,7) null,
  longitude numeric(10,7) null,
  accuracy_meters numeric(8,2) null check (accuracy_meters is null or accuracy_meters >= 0),
  gps_status text not null default 'ACQUIRED' check (gps_status in ('ACQUIRED', 'DENIED', 'UNAVAILABLE', 'TIMEOUT')),
  warning_notes text null check (warning_notes is null or length(warning_notes) <= 500),
  server_recorded_at timestamptz not null default now(),
  recorded_by uuid not null,

  foreign key (tenant_id, task_id) references app.field_tasks(tenant_id, id),
  foreign key (tenant_id, recorded_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists field_location_events_task on app.field_location_events(tenant_id, task_id, server_recorded_at desc);

-- 6. SESIONES DE INSTALACIÓN CONJUNTA (4.3)
create table if not exists app.installation_sessions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  task_id uuid not null,
  session_date date not null,
  technician_id uuid not null,
  status text not null default 'IN_PROGRESS' check (status in ('IN_PROGRESS', 'PAUSED', 'COMPLETED')),
  started_at timestamptz not null default now(),
  ended_at timestamptz null,
  materials_deducted boolean not null default false,
  notes text null check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, task_id) references app.field_tasks(tenant_id, id),
  foreign key (tenant_id, technician_id) references app.users(tenant_id, id),
  foreign key (tenant_id, created_by) references app.users(tenant_id, id),
  foreign key (tenant_id, updated_by) references app.users(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists installation_sessions_request on app.installation_sessions(tenant_id, request_id, status);

-- 7. CONSUMO Y CONCILIACIÓN DE MATERIALES EN INSTALACIÓN (4.3)
create table if not exists app.installation_material_consumptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  session_id uuid not null,
  request_id uuid not null,
  material_id uuid not null,
  planned_quantity numeric(12,2) not null check (planned_quantity >= 0),
  actual_quantity numeric(12,2) not null default 0 check (actual_quantity >= 0),
  difference numeric(12,2) not null default 0,
  reconciled boolean not null default false,
  notes text null check (notes is null or length(notes) <= 1000),
  created_at timestamptz not null default now(),

  foreign key (tenant_id, session_id) references app.installation_sessions(tenant_id, id) on delete cascade,
  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, material_id) references app.catalog_products(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, session_id, material_id)
);

create index if not exists material_consumptions_session on app.installation_material_consumptions(tenant_id, session_id);

-- 8. CIERRE OPERATIVO Y FIRMA DE ENTREGA (4.4)
create table if not exists app.operational_closures (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  request_id uuid not null,
  task_id uuid not null,
  quotation_id uuid not null,
  quotation_version integer not null,
  customer_signatory_name text not null check (length(btrim(customer_signatory_name)) between 2 and 150),
  customer_signatory_document text null check (customer_signatory_document is null or length(btrim(customer_signatory_document)) between 3 and 50),
  signed_at timestamptz not null,
  signature_file_id uuid not null,
  signature_byte_size integer not null default 0,
  signature_sha256 text not null default '',
  signature_mime_type text not null default 'image/png',
  warranty_terms_snapshot jsonb not null default '{}'::jsonb,
  observations text null check (observations is null or length(observations) <= 1000),
  closed_by uuid not null,
  created_at timestamptz not null default now(),

  foreign key (tenant_id, request_id) references app.commercial_requests(tenant_id, id),
  foreign key (tenant_id, task_id) references app.field_tasks(tenant_id, id),
  foreign key (tenant_id, quotation_id) references app.quotations(tenant_id, id),
  foreign key (tenant_id, closed_by) references app.users(tenant_id, id),
  unique (tenant_id, id),
  unique (tenant_id, request_id)
);

create index if not exists operational_closures_lookup on app.operational_closures(tenant_id, request_id);

-- 9. FOTOGRAFÍAS DE CIERRE OPERATIVO Y EVIDENCIA DE INSTALACIÓN (4.4)
create table if not exists app.operational_closure_photos (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  closure_id uuid not null,
  cabin_id uuid null,
  file_id uuid not null,
  byte_size integer not null default 0,
  sha256 text not null default '',
  mime_type text not null default 'image/jpeg',
  caption text null check (caption is null or length(caption) <= 250),
  created_at timestamptz not null default now(),

  foreign key (tenant_id, closure_id) references app.operational_closures(tenant_id, id) on delete cascade,
  foreign key (tenant_id, cabin_id) references app.request_cabins(tenant_id, id),
  unique (tenant_id, id)
);

create index if not exists closure_photos_closure on app.operational_closure_photos(tenant_id, closure_id);

-- 10. SEGURIDAD, POLÍTICAS RLS Y PERMISOS
alter table app.field_visits enable row level security;
alter table app.field_visit_cabin_measures enable row level security;
alter table app.field_tasks enable row level security;
alter table app.field_routes enable row level security;
alter table app.field_route_stops enable row level security;
alter table app.field_location_events enable row level security;
alter table app.installation_sessions enable row level security;
alter table app.installation_material_consumptions enable row level security;
alter table app.operational_closures enable row level security;
alter table app.operational_closure_photos enable row level security;

do $$
declare
  t text;
begin
  for t in select unnest(array[
    'field_visits',
    'field_visit_cabin_measures',
    'field_tasks',
    'field_routes',
    'field_route_stops',
    'field_location_events',
    'installation_sessions',
    'installation_material_consumptions',
    'operational_closures',
    'operational_closure_photos'
  ]) loop
    execute format('
      create policy tenant_member_access on app.%I
      for all
      using (app_private.tenant_member_access(tenant_id, false))
      with check (app_private.tenant_member_access(tenant_id, true));
    ', t);
  end loop;
end $$;

grant select, insert, update on
  app.field_visits,
  app.field_visit_cabin_measures,
  app.field_tasks,
  app.field_routes,
  app.field_route_stops,
  app.field_location_events,
  app.installation_sessions,
  app.installation_material_consumptions,
  app.operational_closures,
  app.operational_closure_photos
to tibelio_dev_app;

grant delete on
  app.field_visit_cabin_measures,
  app.field_route_stops,
  app.installation_material_consumptions,
  app.operational_closure_photos
to tibelio_dev_app;

-- DEC-029 / DEC-056: Revocar borrado en entidades operativas críticas
revoke delete on app.field_visits from tibelio_dev_app;
revoke delete on app.field_tasks from tibelio_dev_app;
revoke delete on app.installation_sessions from tibelio_dev_app;
revoke delete on app.operational_closures from tibelio_dev_app;

do $$ declare api_role text; begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname = api_role) then
      execute format('
        revoke all on app.field_visits from %I;
        revoke all on app.field_visit_cabin_measures from %I;
        revoke all on app.field_tasks from %I;
        revoke all on app.field_routes from %I;
        revoke all on app.field_route_stops from %I;
        revoke all on app.field_location_events from %I;
        revoke all on app.installation_sessions from %I;
        revoke all on app.installation_material_consumptions from %I;
        revoke all on app.operational_closures from %I;
        revoke all on app.operational_closure_photos from %I;
      ', api_role, api_role, api_role, api_role, api_role, api_role, api_role, api_role, api_role, api_role);
    end if;
  end loop;
end $$;

commit;

begin;

-- Catálogo base de municipios (exclusivamente Antioquia, departamento 05)
create table app.municipalities (
  id text primary key, -- Código DANE (ej. '05001')
  department_code text not null default '05',
  department_name text not null default 'Antioquia',
  name text not null
);

insert into app.municipalities(id, name) values
  ('05001', 'Medellín'),
  ('05002', 'Abejorral'),
  ('05004', 'Abriaquí'),
  ('05021', 'Alejandría'),
  ('05030', 'Amagá'),
  ('05031', 'Amalfi'),
  ('05034', 'Andes'),
  ('05036', 'Angelópolis'),
  ('05038', 'Angostura'),
  ('05040', 'Anorí'),
  ('05042', 'Santa Fe de Antioquia'),
  ('05044', 'Anzá'),
  ('05045', 'Apartadó'),
  ('05051', 'Arboletes'),
  ('05055', 'Argelia'),
  ('05059', 'Armenia Mantequilla'),
  ('05079', 'Barbosa'),
  ('05086', 'Belmira'),
  ('05088', 'Bello'),
  ('05091', 'Betania'),
  ('05093', 'Betulia'),
  ('05101', 'Ciudad Bolívar'),
  ('05107', 'Briceño'),
  ('05113', 'Buriticá'),
  ('05120', 'Cáceres'),
  ('05125', 'Caicedo'),
  ('05129', 'Caldas'),
  ('05134', 'Campamento'),
  ('05138', 'Cañasgordas'),
  ('05142', 'Caracolí'),
  ('05145', 'Caramanta'),
  ('05147', 'Carepa'),
  ('05148', 'El Carmen de Viboral'),
  ('05150', 'Carolina del Príncipe'),
  ('05154', 'Caucasia'),
  ('05172', 'Chigorodó'),
  ('05190', 'Cisneros'),
  ('05197', 'Cocorná'),
  ('05206', 'Concepción'),
  ('05209', 'Concordia'),
  ('05212', 'Copacabana'),
  ('05234', 'Dabeiba'),
  ('05237', 'Donmatías'),
  ('05240', 'Ebéjico'),
  ('05250', 'El Bagre'),
  ('05264', 'Entrerríos'),
  ('05266', 'Envigado'),
  ('05282', 'Fredonia'),
  ('05284', 'Frontino'),
  ('05306', 'Giraldo'),
  ('05308', 'Girardota'),
  ('05310', 'Gómez Plata'),
  ('05313', 'Granada'),
  ('05315', 'Guadalupe'),
  ('05318', 'Guarne'),
  ('05321', 'Guatapé'),
  ('05347', 'Heliconia'),
  ('05353', 'Hispania'),
  ('05360', 'Itagüí'),
  ('05361', 'Ituango'),
  ('05364', 'Jardín'),
  ('05368', 'Jericó'),
  ('05376', 'La Ceja'),
  ('05380', 'La Estrella'),
  ('05390', 'La Pintada'),
  ('05400', 'La Unión'),
  ('05411', 'Liborina'),
  ('05425', 'Maceo'),
  ('05440', 'Marinilla'),
  ('05467', 'Montebello'),
  ('05475', 'Murindó'),
  ('05480', 'Mutatá'),
  ('05483', 'Nariño'),
  ('05490', 'Necoclí'),
  ('05495', 'Nechí'),
  ('05501', 'Olaya'),
  ('05541', 'Peñol'),
  ('05543', 'Peque'),
  ('05576', 'Pueblorrico'),
  ('05579', 'Puerto Berrío'),
  ('05585', 'Puerto Nare'),
  ('05591', 'Puerto Triunfo'),
  ('05604', 'Remedios'),
  ('05607', 'Retiro'),
  ('05615', 'Rionegro'),
  ('05628', 'Sabanalarga'),
  ('05631', 'Sabaneta'),
  ('05642', 'Salgar'),
  ('05647', 'San Andrés de Cuerquia'),
  ('05649', 'San Carlos'),
  ('05652', 'San Francisco'),
  ('05656', 'San Jerónimo'),
  ('05658', 'San José de la Montaña'),
  ('05659', 'San Juan de Urabá'),
  ('05660', 'San Luis'),
  ('05664', 'San Pedro de los Milagros'),
  ('05665', 'San Pedro de Urabá'),
  ('05667', 'San Rafael'),
  ('05670', 'San Roque'),
  ('05674', 'San Vicente Ferrer'),
  ('05679', 'Santa Bárbara'),
  ('05686', 'Santa Rosa de Osos'),
  ('05690', 'Santo Domingo'),
  ('05697', 'El Santuario'),
  ('05736', 'Segovia'),
  ('05756', 'Sonsón'),
  ('05761', 'Sopetrán'),
  ('05789', 'Támesis'),
  ('05790', 'Tarazá'),
  ('05792', 'Tarso'),
  ('05809', 'Titiribí'),
  ('05819', 'Toledo'),
  ('05837', 'Turbo'),
  ('05842', 'Uramita'),
  ('05847', 'Urrao'),
  ('05854', 'Valdivia'),
  ('05856', 'Valparaíso'),
  ('05858', 'Vegachí'),
  ('05861', 'Venecia'),
  ('05873', 'Vigía del Fuerte'),
  ('05885', 'Yalí'),
  ('05887', 'Yarumal'),
  ('05890', 'Yolombó'),
  ('05893', 'Yondó'),
  ('05895', 'Zaragoza');

alter table app.municipalities enable row level security;
create policy municipalities_read on app.municipalities for select to tibelio_dev_app using (true);

-- Función RLS para acceso multiempresa de miembros operativos (ADMIN y MEMBER)
create or replace function app_private.tenant_member_access(target uuid, writing boolean default false) returns boolean
  language sql stable security definer set search_path='' as $$
  select coalesce(
    a->>'platformRole'='TENANT'
    and (a->>'tenantId')::uuid=target
    and (
      not writing or (a->>'subscriptionExpiresAt')::numeric+604800000>extract(epoch from now())*1000
    )
    and (
      (a->>'subscriptionExpiresAt')::numeric+604800000>extract(epoch from now())*1000
      or a->>'authority'='ADMIN'
    ),
    false
  )
  from (select app_private.actor() a) s
$$;

-- Zonas tarifarias por empresa
create table app.pricing_zones (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  name text not null check(length(btrim(name)) between 1 and 120),
  transport_fee numeric(18,2) not null default 0.00 check(transport_fee >= 0),
  installation_fee numeric(18,2) not null default 0.00 check(installation_fee >= 0),
  target_margin numeric(9,6) not null default 0.250000 check(target_margin >= 0 and target_margin < 1),
  minimum_margin numeric(9,6) not null default 0.150000 check(minimum_margin >= 0 and minimum_margin <= target_margin),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  unique(tenant_id, name),
  unique(tenant_id, id)
);
create index pricing_zones_tenant on app.pricing_zones(tenant_id, active);
alter table app.pricing_zones enable row level security;
create policy zones_read on app.pricing_zones for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy zones_insert on app.pricing_zones for insert to tibelio_dev_app with check (app_private.tenant_access(tenant_id, true));
create policy zones_update on app.pricing_zones for update to tibelio_dev_app using (app_private.tenant_access(tenant_id, true)) with check (app_private.tenant_access(tenant_id, true));
create policy zones_delete on app.pricing_zones for delete to tibelio_dev_app using (app_private.tenant_access(tenant_id, true));

-- Asociación zona - municipio por empresa
create table app.zone_municipalities (
  tenant_id uuid not null,
  zone_id uuid not null,
  municipality_id text not null references app.municipalities(id),
  created_at timestamptz not null default now(),
  created_by uuid not null,
  primary key (tenant_id, zone_id, municipality_id),
  foreign key (tenant_id, zone_id) references app.pricing_zones(tenant_id, id) on delete cascade,
  unique (tenant_id, municipality_id)
);
create index zone_municipalities_lookup on app.zone_municipalities(tenant_id, municipality_id);
alter table app.zone_municipalities enable row level security;
create policy zm_read on app.zone_municipalities for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy zm_insert on app.zone_municipalities for insert to tibelio_dev_app with check (app_private.tenant_access(tenant_id, true));
create policy zm_delete on app.zone_municipalities for delete to tibelio_dev_app using (app_private.tenant_access(tenant_id, true));

-- Catálogo de productos y acabados por empresa
create table app.catalog_products (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  kind text not null check(kind in ('CABIN','ACCESSORY','MATERIAL')),
  sku text not null check(length(btrim(sku)) between 1 and 60),
  name text not null check(length(btrim(name)) between 1 and 160),
  description text check(description is null or length(description) <= 1000),
  pricing_method text not null check(pricing_method in ('CATALOG_PRICE','COST_MARGIN')),
  base_cost numeric(18,2) not null default 0.00 check(base_cost >= 0),
  list_price numeric(18,2) not null default 0.00 check(list_price >= 0),
  tax_rate numeric(9,6) not null default 0.000000 check(tax_rate >= 0 and tax_rate <= 1),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  unique(tenant_id, sku),
  unique(tenant_id, id)
);
create index catalog_products_tenant on app.catalog_products(tenant_id, kind, active);
alter table app.catalog_products enable row level security;
create policy products_read on app.catalog_products for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy products_insert on app.catalog_products for insert to tibelio_dev_app with check (app_private.tenant_access(tenant_id, true));
create policy products_update on app.catalog_products for update to tibelio_dev_app using (app_private.tenant_access(tenant_id, true)) with check (app_private.tenant_access(tenant_id, true));

-- Clientes
create table app.clients (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references app.tenants(id),
  legal_name text not null check(length(btrim(legal_name)) between 1 and 160),
  tax_id text not null check(length(btrim(tax_id)) between 1 and 60),
  email text check(email is null or email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'),
  phone text not null check(length(btrim(phone)) between 7 and 30),
  notes text check(notes is null or length(notes) <= 1000),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  unique(tenant_id, tax_id),
  unique(tenant_id, id)
);
create index clients_tenant on app.clients(tenant_id, active);
alter table app.clients enable row level security;
create policy clients_read on app.clients for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy clients_insert on app.clients for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy clients_update on app.clients for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));

-- Direcciones de clientes
create table app.client_addresses (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null,
  client_id uuid not null,
  municipality_id text not null references app.municipalities(id),
  address text not null check(length(btrim(address)) between 3 and 250),
  notes text check(notes is null or length(notes) <= 500),
  latitude numeric(10,7) check(latitude is null or (latitude between -90 and 90)),
  longitude numeric(10,7) check(longitude is null or (longitude between -180 and 180)),
  is_primary boolean not null default false,
  created_at timestamptz not null default now(),
  created_by uuid not null,
  updated_at timestamptz not null default now(),
  updated_by uuid not null,
  foreign key (tenant_id, client_id) references app.clients(tenant_id, id) on delete cascade,
  unique (tenant_id, id)
);
create index client_addresses_client on app.client_addresses(tenant_id, client_id);
alter table app.client_addresses enable row level security;
create policy addr_read on app.client_addresses for select to tibelio_dev_app using (app_private.tenant_member_access(tenant_id));
create policy addr_insert on app.client_addresses for insert to tibelio_dev_app with check (app_private.tenant_member_access(tenant_id, true));
create policy addr_update on app.client_addresses for update to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true)) with check (app_private.tenant_member_access(tenant_id, true));
create policy addr_delete on app.client_addresses for delete to tibelio_dev_app using (app_private.tenant_member_access(tenant_id, true));

-- Revocar permisos a roles Data API y public
revoke all on function app_private.tenant_member_access(uuid, boolean) from public;
revoke all on app.municipalities, app.pricing_zones, app.zone_municipalities, app.catalog_products, app.clients, app.client_addresses from public;
do $$ declare api_role text; begin
 foreach api_role in array array['anon','authenticated','service_role'] loop
  if exists(select 1 from pg_roles where rolname=api_role) then
   execute format('revoke all on function app_private.tenant_member_access(uuid, boolean) from %I', api_role);
   execute format('revoke all on app.municipalities, app.pricing_zones, app.zone_municipalities, app.catalog_products, app.clients, app.client_addresses from %I', api_role);
  end if;
 end loop;
end $$;

-- Grants mínimos para tibelio_dev_app
grant execute on function app_private.tenant_member_access(uuid, boolean) to tibelio_dev_app;
grant select on app.municipalities to tibelio_dev_app;
grant select, insert, update, delete on app.pricing_zones, app.zone_municipalities, app.catalog_products, app.clients, app.client_addresses to tibelio_dev_app;

commit;

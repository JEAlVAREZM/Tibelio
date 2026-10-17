begin;
-- DEC-057: financial correction only; no subscription changes.
create table app.subscription_annulments (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null,
 payment_id uuid not null unique, reason text not null check(length(btrim(reason)) between 1 and 1000),
 amount numeric(18,2) not null check(amount<=0), currency text not null,
 created_at timestamptz not null default now(), created_by uuid not null,
 foreign key(tenant_id,payment_id) references app.subscription_payments(tenant_id,id)
);
create index subscription_annulments_tenant on app.subscription_annulments(tenant_id,payment_id);
alter table app.subscription_annulments enable row level security;
create policy annulments_read on app.subscription_annulments for select to tibelio_dev_app using(app_private.is_platform());
create policy annulments_insert on app.subscription_annulments for insert to tibelio_dev_app with check(app_private.is_platform());
create function app_private.annulment_guard() returns trigger language plpgsql security invoker set search_path='' as $$
declare payment app.subscription_payments; actor_id uuid;
begin
 if not app_private.is_platform() then raise exception 'forbidden' using errcode='42501'; end if;
 select * into payment from app.subscription_payments where id=new.payment_id;
 if payment.id is null or payment.tenant_id<>new.tenant_id then raise exception 'invalid payment' using errcode='23503'; end if;
 actor_id=(app_private.actor()->>'userId')::uuid;
 new.amount=-payment.amount; new.currency=payment.currency; new.created_by=actor_id; new.created_at=now();
 return new;
end $$;
create trigger annulment_guard before insert on app.subscription_annulments for each row execute function app_private.annulment_guard();
create index seat_changes_tenant on app.seat_changes(tenant_id,created_at desc);

-- Only aggregate license usage crosses user RLS, never identity or business data.
create function app_private.platform_usage() returns table(tenant_id uuid,active_users bigint)
language plpgsql stable security definer set search_path='' as $$
begin
 if not app_private.is_platform() then raise exception 'forbidden' using errcode='42501'; end if;
 return query select u.tenant_id,count(*) from app.users u where u.tenant_id is not null and u.active group by u.tenant_id;
end $$;

create table app.tenant_logos (
 id uuid primary key, tenant_id uuid not null references app.tenants(id),
 mime text not null check(mime in ('image/png','image/jpeg')),
 byte_size integer not null check(byte_size>0 and byte_size<=20971520),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(),created_by uuid not null,
 unique(tenant_id,id)
);
alter table app.tenants add column logo_id uuid;
alter table app.tenants add constraint tenant_logo_same_tenant foreign key(id,logo_id) references app.tenant_logos(tenant_id,id);
create index tenants_logo on app.tenants(id,logo_id);
alter table app.tenant_logos enable row level security;
create policy logos_read on app.tenant_logos for select to tibelio_dev_app using(app_private.is_platform() or app_private.tenant_access(tenant_id));
create policy logos_insert on app.tenant_logos for insert to tibelio_dev_app with check(app_private.is_platform());
drop policy tenant_platform on app.tenants;
create policy tenants_read on app.tenants for select to tibelio_dev_app using(app_private.is_platform() or app_private.tenant_access(id));
create policy tenants_insert on app.tenants for insert to tibelio_dev_app with check(app_private.is_platform());
create policy tenants_update on app.tenants for update to tibelio_dev_app using(app_private.is_platform()) with check(app_private.is_platform());

revoke all on app.subscription_annulments,app.tenant_logos from public;
revoke all on function app_private.annulment_guard(),app_private.platform_usage() from public;
do $$ declare api_role text; begin
 foreach api_role in array array['anon','authenticated','service_role'] loop
  if exists(select 1 from pg_roles where rolname=api_role) then
   execute format('revoke all on app.subscription_annulments,app.tenant_logos from %I',api_role);
   execute format('revoke all on function app_private.annulment_guard(),app_private.platform_usage() from %I',api_role);
  end if;
 end loop;
end $$;
grant select,insert on app.subscription_annulments,app.tenant_logos to tibelio_dev_app;
grant execute on function app_private.platform_usage() to tibelio_dev_app;
commit;

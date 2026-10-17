begin;
alter table app.subscription_payments add constraint subscription_payments_tenant_id_id_key unique(tenant_id,id);
create table app.subscription_receipts (
 id uuid primary key, tenant_id uuid not null, payment_id uuid not null,
 mime text not null check(mime in ('application/pdf','image/png','image/jpeg')),
 byte_size integer not null check(byte_size>0 and byte_size<=20971520),
 sha256 text not null check(sha256 ~ '^[a-f0-9]{64}$'),
 created_at timestamptz not null default now(), created_by uuid not null,
 foreign key(tenant_id,payment_id) references app.subscription_payments(tenant_id,id)
);
create index subscription_receipts_payment on app.subscription_receipts(tenant_id,payment_id);
create index subscription_receipts_listing on app.subscription_receipts(payment_id,created_at desc,id desc);
alter table app.subscription_receipts enable row level security;
create policy subscription_receipts_read on app.subscription_receipts for select to tibelio_dev_app using(app_private.is_platform());
create policy subscription_receipts_insert on app.subscription_receipts for insert to tibelio_dev_app with check(app_private.is_platform());
revoke all on app.subscription_receipts from public;
do $$ declare api_role text; begin
 foreach api_role in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=api_role) then execute format('revoke all on app.subscription_receipts from %I',api_role); end if;
 end loop;
end $$;
grant select,insert on app.subscription_receipts to tibelio_dev_app;
commit;

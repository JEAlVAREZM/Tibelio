-- Fase 1. Private application schemas; never add these schemas to the Data API.
begin;
create schema app;
create schema app_private;
revoke all on schema app, app_private from public;

create table app.tenants (
 id uuid primary key default gen_random_uuid(), legal_name text not null, tax_id text not null,
 active boolean not null default true, created_at timestamptz not null default now(),
 created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create table app.tiers (
 id uuid primary key default gen_random_uuid(), min_users integer not null check(min_users>0),
 max_users integer not null check(max_users>=min_users), monthly_price numeric(18,2) not null check(monthly_price>=0),
 currency text not null check(currency ~ '^[A-Z]{3}$'), active boolean not null default true,
 created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid
);
create table app.subscriptions (
 tenant_id uuid primary key references app.tenants(id), seats integer not null check(seats>0),
 expires_at timestamptz not null, current_amount numeric(18,2) not null check(current_amount>=0),
 next_amount numeric(18,2) not null check(next_amount>=0), currency text not null check(currency ~ '^[A-Z]{3}$'),
 updated_at timestamptz not null default now(), updated_by uuid
);
create table app.users (
 id uuid primary key default gen_random_uuid(), tenant_id uuid references app.tenants(id),
 username text not null unique check(username ~ '^[a-z0-9][a-z0-9._-]{2,63}$'),
 display_name text not null, email text, password_hash text not null check(password_hash like '$argon2id$%'),
 platform_role text not null check(platform_role in ('SUPERADMIN','TENANT')),
 authority text not null check(authority in ('ADMIN','MEMBER')), active boolean not null default true,
 auth_version integer not null default 1, grants text[] not null default '{}', denials text[] not null default '{}',
 created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
 unique(tenant_id,id), check((platform_role='SUPERADMIN' and tenant_id is null and authority='ADMIN') or (platform_role='TENANT' and tenant_id is not null))
);
create index users_tenant_active on app.users(tenant_id,active);
create table app.roles (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references app.tenants(id),
 name text not null, permissions text[] not null default '{}',
 created_at timestamptz not null default now(), created_by uuid, updated_at timestamptz not null default now(), updated_by uuid,
 unique(tenant_id,id), unique(tenant_id,name)
);
create table app.user_roles (
 tenant_id uuid not null, user_id uuid not null, role_id uuid not null,
 primary key(tenant_id,user_id,role_id),
 foreign key(tenant_id,user_id) references app.users(tenant_id,id),
 foreign key(tenant_id,role_id) references app.roles(tenant_id,id)
);
create index user_roles_role on app.user_roles(tenant_id,role_id);
create table app.seat_changes (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references app.tenants(id),
 old_seats integer not null, new_seats integer not null, next_amount numeric(18,2) not null,
 bill_from timestamptz not null, created_at timestamptz not null default now(), created_by uuid not null
);
create table app.subscription_payments (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references app.tenants(id),
 amount numeric(18,2) not null check(amount>=0), currency text not null,
 reference text not null, period_start timestamptz not null, period_end timestamptz not null,
 created_at timestamptz not null default now(), created_by uuid not null,
 unique(tenant_id,reference), check(period_end>period_start)
);
create table app_private.sessions (
 token_hash text primary key check(token_hash ~ '^[a-f0-9]{64}$'), user_id uuid not null references app.users(id),
 auth_version integer not null, expires_at timestamptz not null, revoked_at timestamptz,
 created_at timestamptz not null default now()
);
create index sessions_user on app_private.sessions(user_id);
create table app_private.login_limits (key text primary key, attempts integer not null, until_at timestamptz not null);
create index login_limits_expiry on app_private.login_limits(until_at);

-- Auth-only SECURITY DEFINER functions deliberately cross RLS. Fixed search_path,
-- no dynamic SQL, no anon/authenticated/PUBLIC execution, no client-supplied tenant.
create function app_private.actor() returns jsonb language sql stable security definer set search_path='' as $$
 select case when u.platform_role='SUPERADMIN' then jsonb_build_object('userId',u.id,'active',true,'platformRole','SUPERADMIN','tenantId',null)
 else jsonb_build_object('userId',u.id,'active',true,'platformRole','TENANT','tenantId',u.tenant_id,
 'tenantActive',t.active,'authority',u.authority,'subscriptionExpiresAt',floor(extract(epoch from sub.expires_at)*1000),
 'rolePermissions',coalesce((select jsonb_agg(distinct p) from app.user_roles ur join app.roles r on r.tenant_id=ur.tenant_id and r.id=ur.role_id cross join lateral unnest(r.permissions) p where ur.user_id=u.id),'[]'::jsonb),
 'grants',to_jsonb(u.grants),'denials',to_jsonb(u.denials)) end
 from app_private.sessions s join app.users u on u.id=s.user_id
 left join app.tenants t on t.id=u.tenant_id left join app.subscriptions sub on sub.tenant_id=t.id
 where s.token_hash=current_setting('app.session_hash',true) and s.revoked_at is null and s.expires_at>now()
 and s.auth_version=u.auth_version and u.active
 and (u.platform_role='SUPERADMIN' or (t.active and sub.tenant_id is not null and (sub.expires_at+interval '7 days'>now() or u.authority='ADMIN')))
$$;
create function app_private.is_platform() returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(app_private.actor()->>'platformRole'='SUPERADMIN',false)
$$;
create function app_private.tenant_access(target uuid, writing boolean default false) returns boolean language sql stable security definer set search_path='' as $$
 select coalesce(a->>'platformRole'='TENANT' and (a->>'tenantId')::uuid=target and a->>'authority'='ADMIN'
 and (not writing or (a->>'subscriptionExpiresAt')::numeric+604800000>extract(epoch from now())*1000),false)
 from (select app_private.actor() a) s
$$;
create function app_private.throttle(k text) returns boolean language plpgsql security definer set search_path='' as $$
 declare n integer;
 begin
 -- Global bound prevents unlimited username keys and Argon2 work. Committed by
 -- the login service even for denied attempts; expired keys are removed here.
 insert into app_private.login_limits(key,attempts,until_at) values('global',1,now()+interval '10 minutes')
 on conflict(key) do update set attempts=case when app_private.login_limits.until_at<=now() then 1 else least(app_private.login_limits.attempts+1,501) end,
 until_at=case when app_private.login_limits.until_at<=now() then now()+interval '10 minutes' else app_private.login_limits.until_at end returning attempts into n;
 if n>500 then return false; end if;
 delete from app_private.login_limits where until_at<=now();
 delete from app_private.sessions where expires_at<=now();
 insert into app_private.login_limits(key,attempts,until_at) values(k,1,now()+interval '10 minutes')
 on conflict(key) do update set attempts=case when app_private.login_limits.until_at<=now() then 1 else least(app_private.login_limits.attempts+1,11) end,
 until_at=case when app_private.login_limits.until_at<=now() then now()+interval '10 minutes' else app_private.login_limits.until_at end returning attempts into n;
 return n<=10;
 end $$;
create function app_private.lock_tenant(target uuid) returns void language plpgsql security definer set search_path='' as $$
 begin
 if not app_private.tenant_access(target,true) then raise exception 'forbidden' using errcode='42501'; end if;
 perform 1 from app.subscriptions where tenant_id=target for update;
 end $$;
create function app_private.login_candidate(uname text) returns table(id uuid,password_hash text) language sql security definer set search_path='' as $$
 select u.id,u.password_hash from app.users u where u.username=uname and u.active
$$;
create function app_private.open_session(uid uuid, expected_hash text, token text) returns boolean language plpgsql security definer set search_path='' as $$
 declare v integer;
 begin
 select u.auth_version into v from app.users u left join app.tenants t on t.id=u.tenant_id left join app.subscriptions s on s.tenant_id=u.tenant_id
 where u.id=uid and u.active and u.password_hash=expected_hash
 and (u.platform_role='SUPERADMIN' or (t.active and (s.expires_at+interval '7 days'>now() or u.authority='ADMIN'))) for share of u;
 if v is null then return false; end if;
 insert into app_private.sessions(token_hash,user_id,auth_version,expires_at) values(token,uid,v,now()+interval '8 hours');
 return true;
 end $$;
create function app_private.close_session() returns void language sql security definer set search_path='' as $$
 update app_private.sessions set revoked_at=now() where token_hash=current_setting('app.session_hash',true)
$$;

-- Serialize active-user changes and seat reductions on the same subscription row.
create function app_private.user_guard() returns trigger language plpgsql security definer set search_path='' as $$
 declare capacity integer; used integer;
 begin
 if TG_OP='UPDATE' then
   if new.tenant_id is distinct from old.tenant_id or new.platform_role<>old.platform_role then raise exception 'immutable identity' using errcode='23514'; end if;
   new.auth_version=old.auth_version+1; new.updated_at=now();
 end if;
 if new.tenant_id is not null then
   select seats into capacity from app.subscriptions where tenant_id=new.tenant_id for update;
   select count(*) into used from app.users where tenant_id=new.tenant_id and active and id<>new.id;
   if new.active and (capacity is null or used>=capacity) then raise exception 'seat limit' using errcode='P0001'; end if;
   if TG_OP='UPDATE' and old.active and old.authority='ADMIN' and (not new.active or new.authority<>'ADMIN')
      and not exists(select 1 from app.users where tenant_id=new.tenant_id and active and authority='ADMIN' and id<>new.id)
   then raise exception 'last administrator' using errcode='23514'; end if;
 end if;
 return new;
 end $$;
create trigger user_guard before insert or update on app.users for each row execute function app_private.user_guard();
create function app_private.seat_guard() returns trigger language plpgsql security definer set search_path='' as $$
 begin
 if new.seats<(select count(*) from app.users where tenant_id=new.tenant_id and active) then raise exception 'active users exceed seats' using errcode='P0001'; end if;
 new.updated_at=now(); return new;
 end $$;
create trigger seat_guard before update on app.subscriptions for each row execute function app_private.seat_guard();
create function app_private.revoke_role_sessions() returns trigger language plpgsql security definer set search_path='' as $$
 begin
 if TG_TABLE_NAME='roles' then
 update app_private.sessions set revoked_at=now() where user_id in(select user_id from app.user_roles where role_id=new.id and tenant_id=new.tenant_id);
 elsif TG_OP='DELETE' then
 update app_private.sessions set revoked_at=now() where user_id=old.user_id;
 else update app_private.sessions set revoked_at=now() where user_id=new.user_id;
 end if;
 return null;
 end $$;
create constraint trigger revoke_role_sessions after update on app.roles deferrable initially deferred for each row execute function app_private.revoke_role_sessions();
create constraint trigger revoke_membership_sessions after insert or update or delete on app.user_roles deferrable initially deferred for each row execute function app_private.revoke_role_sessions();
create function app_private.suspend_sessions() returns trigger language plpgsql security definer set search_path='' as $$
 begin
 if old.active and not new.active then update app_private.sessions set revoked_at=now() where user_id in(select id from app.users where tenant_id=new.id); end if;
 return new;
 end $$;
create trigger suspend_sessions after update on app.tenants for each row execute function app_private.suspend_sessions();

create function app_private.create_tenant(legal text,tax text,seat_count integer,expiry timestamptz,tier uuid,uname text,dname text,phash text) returns uuid
 language plpgsql security definer set search_path='' as $$
 declare tid uuid; price numeric(18,2); curr text; actor_id uuid;
 begin
 if not app_private.is_platform() then raise exception 'forbidden' using errcode='42501'; end if;
 actor_id=(app_private.actor()->>'userId')::uuid;
 select monthly_price,currency into price,curr from app.tiers where id=tier and active and seat_count between min_users and max_users;
 if price is null then raise exception 'invalid tier' using errcode='23514'; end if;
 insert into app.tenants(legal_name,tax_id,created_by) values(legal,tax,actor_id) returning id into tid;
 insert into app.subscriptions(tenant_id,seats,expires_at,current_amount,next_amount,currency,updated_by) values(tid,seat_count,expiry,price,price,curr,actor_id);
 insert into app.users(tenant_id,username,display_name,password_hash,platform_role,authority,created_by) values(tid,uname,dname,phash,'TENANT','ADMIN',actor_id);
 insert into app.roles(tenant_id,name,created_by) select tid,n,actor_id from unnest(array['COORD','COMPRAS','TECNICO','TRANSPORTADOR','INSTALADOR']) n;
 return tid;
 end $$;

alter table app.tenants enable row level security;
alter table app.tiers enable row level security;
alter table app.subscriptions enable row level security;
alter table app.users enable row level security;
alter table app.roles enable row level security;
alter table app.user_roles enable row level security;
alter table app.seat_changes enable row level security;
alter table app.subscription_payments enable row level security;
alter table app_private.sessions enable row level security;
alter table app_private.login_limits enable row level security;
create policy tenant_platform on app.tenants for all using(app_private.is_platform()) with check(app_private.is_platform());
create policy tiers_platform on app.tiers for all using(app_private.is_platform()) with check(app_private.is_platform());
create policy subscriptions_platform on app.subscriptions for all using(app_private.is_platform()) with check(app_private.is_platform());
create policy seat_changes_platform on app.seat_changes for select using(app_private.is_platform());
create policy seat_changes_insert on app.seat_changes for insert with check(app_private.is_platform());
create policy subscription_payments_platform on app.subscription_payments for select using(app_private.is_platform());
create policy subscription_payments_insert on app.subscription_payments for insert with check(app_private.is_platform());
create policy users_read on app.users for select using(app_private.tenant_access(tenant_id));
create policy users_insert on app.users for insert with check(app_private.tenant_access(tenant_id,true));
create policy users_update on app.users for update using(app_private.tenant_access(tenant_id,true)) with check(app_private.tenant_access(tenant_id,true));
create policy roles_read on app.roles for select using(app_private.tenant_access(tenant_id));
create policy roles_insert on app.roles for insert with check(app_private.tenant_access(tenant_id,true));
create policy roles_update on app.roles for update using(app_private.tenant_access(tenant_id,true)) with check(app_private.tenant_access(tenant_id,true));
create policy user_roles_read on app.user_roles for select using(app_private.tenant_access(tenant_id));
create policy user_roles_insert on app.user_roles for insert to tibelio_dev_app with check(app_private.tenant_access(tenant_id,true));
create policy user_roles_delete on app.user_roles for delete to tibelio_dev_app using(app_private.tenant_access(tenant_id,true));

revoke all on all tables in schema app,app_private from public;
revoke all on all functions in schema app_private from public;
-- Supabase projects may have inherited default grants. Explicitly remove them
-- when these API roles exist (plain PostgreSQL test instances have none).
do $$ declare api_role text; begin
 foreach api_role in array array['anon','authenticated','service_role'] loop
   if exists(select 1 from pg_roles where rolname=api_role) then
     execute format('revoke all on schema app,app_private from %I',api_role);
     execute format('revoke all on all tables in schema app,app_private from %I',api_role);
     execute format('revoke all on all functions in schema app_private from %I',api_role);
   end if;
 end loop;
end $$;
-- Runtime role already provisioned in Phase 0. No ownership, DDL or BYPASSRLS.
grant usage on schema app,app_private to tibelio_dev_app;
grant select,insert,update on app.tenants,app.tiers,app.subscriptions,app.roles to tibelio_dev_app;
grant select,insert,delete on app.user_roles to tibelio_dev_app;
grant select,insert on app.seat_changes,app.subscription_payments to tibelio_dev_app;
grant select(id,tenant_id,username,display_name,email,platform_role,authority,active,grants,denials,created_at,updated_at),insert,update on app.users to tibelio_dev_app;
grant execute on function app_private.actor(),app_private.is_platform(),app_private.tenant_access(uuid,boolean),app_private.throttle(text),app_private.login_candidate(text),app_private.open_session(uuid,text,text),app_private.close_session(),app_private.create_tenant(text,text,integer,timestamptz,uuid,text,text,text) to tibelio_dev_app;
grant execute on function app_private.lock_tenant(uuid) to tibelio_dev_app;
-- Application explicitly starts writable transactions; preflight remains read-only.
commit;

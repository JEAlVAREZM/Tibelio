-- Append-only business history; no fabricated past events or secret values.
create table app.audit_events (
 id uuid primary key default gen_random_uuid(), tenant_id uuid not null references app.tenants(id),
 actor_id uuid, actor_label text not null, entity text not null, record_id text not null,
 record_label text not null, request_id uuid, read_action text not null,
 operation text not null check(operation in ('INSERT','UPDATE','DELETE')),
 changed_fields text[] not null, before_values jsonb not null default '{}', after_values jsonb not null default '{}',
 occurred_at timestamptz not null default clock_timestamp()
);
create index audit_events_tenant_time on app.audit_events(tenant_id,occurred_at desc,id desc);
create index audit_events_record on app.audit_events(tenant_id,entity,record_id,occurred_at desc);
alter table app.audit_events enable row level security;
alter table app.audit_events force row level security;
revoke all on app.audit_events from public,tibelio_dev_app;
grant select on app.audit_events to tibelio_dev_app;
create function app_private.audit_access(target uuid, required_action text) returns boolean
language sql stable security definer set search_path='' as $$
 select coalesce(app_private.tenant_member_access(target,false)
 and a->>'platformRole'='TENANT' and a->>'authority'='ADMIN'
 and not (coalesce(a->'denials','[]'::jsonb) ? 'audit.read')
 and not (coalesce(a->'denials','[]'::jsonb) ? required_action),false)
 from (select app_private.actor() a) s
$$;
revoke all on function app_private.audit_access(uuid,text) from public;
grant execute on function app_private.audit_access(uuid,text) to tibelio_dev_app;
create policy audit_read on app.audit_events for select to tibelio_dev_app using(app_private.audit_access(tenant_id,read_action));
create function app_private.capture_business_audit() returns trigger
language plpgsql security definer set search_path='' as $$
declare
 old_row jsonb := case when TG_OP='INSERT' then '{}'::jsonb else to_jsonb(OLD) end;
 new_row jsonb := case when TG_OP='DELETE' then '{}'::jsonb else to_jsonb(NEW) end;
 row_data jsonb := case when TG_OP='DELETE' then old_row else new_row end;
 actor jsonb := app_private.actor(); fields text[]; before_safe jsonb; after_safe jsonb; record_key text; actor_name text;
 safe_columns text[] := array['name','legal_name','display_name','tax_id','phone','email','sku','kind','active','status','priority','location','authority','grants','denials','permissions','pricing_method'];
begin
 if row_data->>'tenant_id' is null then if TG_WHEN='BEFORE' then if TG_OP='DELETE' then return OLD; else return NEW; end if; end if; return null; end if;
 select array_agg(k order by k) into fields from (select jsonb_object_keys(old_row || new_row) k) keys
 where old_row->k is distinct from new_row->k and k not in ('updated_at','updated_by','created_at','created_by');
 if fields is null then if TG_WHEN='BEFORE' then if TG_OP='DELETE' then return OLD; else return NEW; end if; end if; return null; end if;
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into before_safe from jsonb_each(old_row) where key=any(safe_columns) and key=any(fields);
 select coalesce(jsonb_object_agg(key,value),'{}'::jsonb) into after_safe from jsonb_each(new_row) where key=any(safe_columns) and key=any(fields);
 record_key := coalesce(row_data->>'id',row_data->>'cabin_id',row_data->>'product_id');
 if record_key is null then record_key := jsonb_strip_nulls(jsonb_build_object('user',row_data->'user_id','role',row_data->'role_id','zone',row_data->'zone_id','municipality',row_data->'municipality_id','tenant',row_data->'tenant_id'))::text; end if;
 if actor->>'platformRole'='TENANT' then select display_name into actor_name from app.users where id=(actor->>'userId')::uuid;
 elsif actor->>'platformRole'='SUPERADMIN' then actor_name := 'Administración SaaS'; end if;
 insert into app.audit_events(tenant_id,actor_id,actor_label,entity,record_id,record_label,request_id,read_action,operation,changed_fields,before_values,after_values)
 values((row_data->>'tenant_id')::uuid,(actor->>'userId')::uuid,coalesce(actor_name,'Proceso del sistema'),TG_TABLE_NAME,record_key,
 coalesce(row_data->>'code',row_data->>'legal_name',row_data->>'name',row_data->>'title',record_key),(row_data->>'request_id')::uuid,TG_ARGV[0],TG_OP,fields,before_safe,after_safe);
 if TG_WHEN='BEFORE' then if TG_OP='DELETE' then return OLD; else return NEW; end if; end if;
 return null;
end $$;
revoke all on function app_private.capture_business_audit() from public;
do $$
declare entity text; permission text; api_role text;
begin
 for entity,permission in select * from (values
 ('clients','clients.read'),('client_addresses','clients.read'),('catalog_products','catalog.read'),('pricing_zones','clients.read'),('zone_municipalities','clients.read'),
 ('commercial_settings','settings.manage'),('commercial_requests','requests.read'),('request_cabins','requests.read'),('request_items','requests.read'),
 ('quotations','quotations.read'),('quotation_cabins','quotations.read'),('quotation_items','quotations.read'),('quotation_adjustments','quotations.read'),('quotation_documents','quotations.read'),
 ('suppliers','suppliers.read'),('procurement_reviews','procurement.read'),('purchase_orders','procurement.read'),('purchase_order_lines','procurement.read'),('procurement_receipts','procurement.read'),('procurement_receipt_lines','procurement.read'),
 ('warehouse_stock','inventory.read'),('cabin_stock','inventory.read'),('inventory_movements','inventory.read'),('dispatch_records','inventory.read'),('dispatch_lines','inventory.read'),
 ('payment_terms','payments.read'),('client_payments','payments.read'),('refund_records','payments.read'),('cancellation_records','payments.read'),
 ('field_visits','field.read'),('field_visit_cabin_measures','field.read'),('field_tasks','field.read'),('field_routes','field.read'),('field_route_stops','field.read'),('field_location_events','field.read'),('installation_sessions','field.read'),('installation_material_consumptions','field.read'),('operational_closures','field.read'),('operational_closure_photos','field.read'),
 ('warranties','warranties.read'),('warranty_photos','warranties.read'),('operational_issues','issues.read'),('operational_costs','costs.read'),('users','users.read'),('roles','users.read'),('user_roles','users.read')
 ) as domains(entity,permission) loop
 if to_regclass('app.' || entity) is not null then execute format('create trigger aaa_business_audit %s insert or update or delete on app.%I for each row execute function app_private.capture_business_audit(%L)',case when entity='users' then 'before' else 'after' end,entity,permission); end if;
 end loop;
 foreach api_role in array array['anon','authenticated','service_role'] loop
 if exists(select 1 from pg_roles where rolname=api_role) then
 execute format('revoke all on app.audit_events from %I',api_role);
 execute format('revoke all on function app_private.audit_access(uuid,text),app_private.capture_business_audit() from %I',api_role);
 end if;
 end loop;
end $$;

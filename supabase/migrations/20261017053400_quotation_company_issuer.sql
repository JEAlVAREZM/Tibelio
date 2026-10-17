-- Narrow internal projection: members quoting do not get access to SaaS administration.
create function app_private.quotation_issuer() returns table(legal_name text,tax_id text)
language sql stable security definer set search_path='' as $$
 select t.legal_name,t.tax_id
 from (select app_private.actor() a) s
 join app.tenants t on t.id=(a->>'tenantId')::uuid
 where a->>'platformRole'='TENANT' and app_private.tenant_member_access(t.id,false)
 and exists(select 1 from unnest(array['quotations.read','quotations.create']) action
   where not(coalesce(a->'denials','[]'::jsonb) ? action)
   and (a->>'authority'='ADMIN' or coalesce(a->'grants','[]'::jsonb) ? action or coalesce(a->'rolePermissions','[]'::jsonb) ? action))
$$;
revoke all on function app_private.quotation_issuer() from public;
grant execute on function app_private.quotation_issuer() to tibelio_dev_app;
do $$ declare api_role text; begin
 foreach api_role in array array['anon','authenticated','service_role'] loop
  if exists(select 1 from pg_roles where rolname=api_role) then execute format('revoke all on function app_private.quotation_issuer() from %I',api_role); end if;
 end loop;
end $$;

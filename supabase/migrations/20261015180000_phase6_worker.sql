-- Worker can execute bounded operations; it cannot SELECT business tables.
do $$ begin
  if not exists(select from pg_roles where rolname='tibelio_worker') then
    create role tibelio_worker nologin nosuperuser nobypassrls nocreatedb nocreaterole;
  end if;
end $$;
grant usage on schema app_private to tibelio_worker;

create table app_private.push_attempts (
  notification_id uuid not null references app.internal_notifications(id) on delete cascade,
  subscription_id uuid not null references app.web_push_subscriptions(id) on delete cascade,
  attempts integer not null default 0,
  accepted boolean not null default false,
  retry_at timestamptz not null default now(),
  primary key(notification_id,subscription_id)
);
alter table app_private.push_attempts enable row level security;
revoke all on app_private.push_attempts from public,anon,authenticated,service_role,tibelio_dev_app,tibelio_worker;

create function app_private.run_alert_schedule() returns integer
language plpgsql security definer set search_path='' as $$
declare inserted integer;
begin
  insert into app.internal_notifications(tenant_id,event_type,title,message,reference_type,reference_id,dedup_key)
  select t.id,e.kind,e.title,e.message,e.ref_type,e.ref_id,e.dedup
  from app.tenants t join app.subscriptions s on s.tenant_id=t.id
  cross join lateral (
    select 'BLOCKING_ISSUE' kind,'Novedad bloqueante' title,'Revisa las novedades pendientes.' message,'ISSUE' ref_type,i.id ref_id,'blocking_issue_'||i.id dedup
    from app.operational_issues i where i.tenant_id=t.id and i.severity='BLOCKING' and i.status in ('OPEN','IN_PROGRESS')
    union all
    select 'WARRANTY_CLAIM','Garantía pendiente','Revisa los reclamos pendientes.','WARRANTY',w.id,'warranty_unreviewed_'||w.id
    from app.warranties w where w.tenant_id=t.id and w.status='REGISTERED'
    union all
    select 'DELAYED_OPERATION','Tarea pendiente','Revisa la agenda de operaciones.','TASK',f.id,'delayed_task_'||f.id||'_'||f.scheduled_date
    from app.field_tasks f where f.tenant_id=t.id and f.status='SCHEDULED' and f.scheduled_date < (now() at time zone 'America/Bogota')::date
    union all
    select 'OVERDUE_PAYMENT','Pago vencido','Revisa las cuotas con fecha vencida.','REQUEST',pt.request_id,'overdue_terms_'||pt.quotation_id
    from app.payment_terms pt join app.commercial_requests cr on cr.id=pt.request_id and cr.tenant_id=pt.tenant_id
    join app.quotations q on q.id=pt.quotation_id and q.tenant_id=pt.tenant_id and q.status='APPROVED'
    where pt.tenant_id=t.id and pt.active and cr.status<>'CANCELLED'
      and pt.due_date<(now() at time zone 'America/Bogota')::date
      and q.version=(select max(q2.version) from app.quotations q2 where q2.tenant_id=t.id and q2.request_id=pt.request_id)
    group by pt.request_id,pt.quotation_id
    having sum(pt.amount) > (
      coalesce((select sum(p.amount) from app.client_payments p where p.tenant_id=t.id and p.request_id=pt.request_id and p.status='VALIDATED'),0)
      - coalesce((select sum(r.amount) from app.refund_records r where r.tenant_id=t.id and r.request_id=pt.request_id and r.status='DISBURSED'),0))
  ) e
  where t.active and s.expires_at + interval '7 days' > now()
  on conflict(tenant_id,dedup_key) do nothing;
  get diagnostics inserted=row_count;
  return inserted;
end $$;

create function app_private.claim_push_batch() returns table(notification_id uuid,subscription_id uuid,endpoint text,p256dh text,auth text)
language plpgsql security definer set search_path='' as $$
begin
  insert into app_private.push_attempts(notification_id,subscription_id)
  select n.id,p.id from app.internal_notifications n
  join app.web_push_subscriptions p on p.tenant_id=n.tenant_id
  join app.users u on u.id=p.user_id and u.tenant_id=p.tenant_id
  join app.tenants t on t.id=n.tenant_id
  join app.subscriptions s on s.tenant_id=t.id
  where n.created_at > now()-interval '1 day' and t.active and u.active and (n.user_id is null or n.user_id=u.id)
    and s.expires_at+interval '7 days'>now() and not ('notifications.read'=any(u.denials))
    and (u.authority='ADMIN' or 'notifications.read'=any(u.grants) or exists(
      select from app.user_roles ur join app.roles r on r.id=ur.role_id and r.tenant_id=ur.tenant_id
      where ur.user_id=u.id and ur.tenant_id=u.tenant_id and 'notifications.read'=any(r.permissions)))
  on conflict do nothing;
  return query
  with batch as (
    select a.notification_id,a.subscription_id from app_private.push_attempts a
    join app.web_push_subscriptions p on p.id=a.subscription_id
    join app.users u on u.id=p.user_id and u.tenant_id=p.tenant_id
    join app.tenants t on t.id=p.tenant_id join app.subscriptions s on s.tenant_id=t.id
    where not a.accepted and a.attempts<3 and a.retry_at<=now() and u.active and t.active
      and s.expires_at+interval '7 days'>now() and not ('notifications.read'=any(u.denials))
      and (u.authority='ADMIN' or 'notifications.read'=any(u.grants) or exists(
        select from app.user_roles ur join app.roles r on r.id=ur.role_id and r.tenant_id=ur.tenant_id
        where ur.user_id=u.id and ur.tenant_id=u.tenant_id and 'notifications.read'=any(r.permissions)))
    order by a.retry_at limit 50 for update of a skip locked
  ), claimed as (
    update app_private.push_attempts a set attempts=attempts+1,retry_at=now()+interval '5 minutes'
    from batch b where a.notification_id=b.notification_id and a.subscription_id=b.subscription_id returning a.*
  ) select c.notification_id,c.subscription_id,p.endpoint,p.p256dh,p.auth from claimed c join app.web_push_subscriptions p on p.id=c.subscription_id;
end $$;

create function app_private.finish_push(p_notification uuid,p_subscription uuid,p_accepted boolean,p_expired boolean) returns void
language plpgsql security definer set search_path='' as $$
begin
  update app_private.push_attempts set accepted=p_accepted where notification_id=p_notification and subscription_id=p_subscription;
  if p_expired then delete from app.web_push_subscriptions where id=p_subscription; end if;
end $$;
revoke all on function app_private.run_alert_schedule(),app_private.claim_push_batch(),app_private.finish_push(uuid,uuid,boolean,boolean) from public,anon,authenticated,service_role,tibelio_dev_app;
grant execute on function app_private.run_alert_schedule(),app_private.claim_push_batch(),app_private.finish_push(uuid,uuid,boolean,boolean) to tibelio_worker;

-- Separate command policies close DELETE/UPDATE read-only bypasses.
drop policy web_push_subscriptions_tenant_access on app.web_push_subscriptions;
create policy push_read on app.web_push_subscriptions for select to tibelio_dev_app using(app_private.tenant_member_access(tenant_id,false));
create policy push_insert on app.web_push_subscriptions for insert to tibelio_dev_app with check(app_private.tenant_member_access(tenant_id,true));
create policy push_update on app.web_push_subscriptions for update to tibelio_dev_app using(app_private.tenant_member_access(tenant_id,true)) with check(app_private.tenant_member_access(tenant_id,true));
create policy push_delete on app.web_push_subscriptions for delete to tibelio_dev_app using(app_private.tenant_member_access(tenant_id,true));

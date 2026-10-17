-- Phase 5 Hardening: R-07 Per-user notification read tracking

-- 1. Ensure internal_notifications has unique (tenant_id, id) for FK target
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'internal_notifications_tenant_id_unique'
  ) then
    alter table app.internal_notifications
      add constraint internal_notifications_tenant_id_unique unique (tenant_id, id);
  end if;
end $$;

-- 2. Create internal_notification_reads table
create table if not exists app.internal_notification_reads (
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    notification_id uuid not null,
    user_id uuid not null references app.users(id) on delete cascade,
    read_at timestamptz not null default now(),
    primary key (tenant_id, notification_id, user_id),
    constraint internal_notification_reads_notification_fk foreign key (tenant_id, notification_id)
        references app.internal_notifications(tenant_id, id) on delete cascade
);

create index if not exists idx_internal_notification_reads_lookup
    on app.internal_notification_reads(tenant_id, user_id, notification_id);

-- Backfill from existing internal_notifications
insert into app.internal_notification_reads (tenant_id, notification_id, user_id, read_at)
select tenant_id, id, read_by, coalesce(read_at, now())
from app.internal_notifications
where read_at is not null and read_by is not null
on conflict do nothing;

-- 3. Revoke direct destructive operations
revoke delete on app.internal_notification_reads from public, tibelio_dev_app;

-- 4. Grant application privileges
grant select, insert, update on app.internal_notification_reads to tibelio_dev_app;

-- 5. RLS Deny-Default
alter table app.internal_notification_reads enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where policyname = 'internal_notification_reads_tenant_access'
  ) then
    create policy internal_notification_reads_tenant_access on app.internal_notification_reads
        using (app_private.tenant_member_access(tenant_id, false))
        with check (app_private.tenant_member_access(tenant_id, true));
  end if;
end $$;

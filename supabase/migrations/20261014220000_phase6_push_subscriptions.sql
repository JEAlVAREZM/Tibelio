-- Phase 6: F6-02 Web Push Subscriptions per user/device
create table if not exists app.web_push_subscriptions (
    id uuid primary key default gen_random_uuid(),
    tenant_id uuid not null references app.tenants(id) on delete restrict,
    user_id uuid not null references app.users(id) on delete cascade,
    endpoint text not null,
    p256dh text not null,
    auth text not null,
    user_agent text,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint web_push_subscriptions_unique unique (tenant_id, user_id, endpoint)
);

create index if not exists idx_web_push_subscriptions_user
    on app.web_push_subscriptions(tenant_id, user_id);

grant select, insert, update, delete on app.web_push_subscriptions to tibelio_dev_app;

alter table app.web_push_subscriptions enable row level security;

do $$
begin
  if not exists (
    select 1 from pg_policies where policyname = 'web_push_subscriptions_tenant_access'
  ) then
    create policy web_push_subscriptions_tenant_access on app.web_push_subscriptions
        using (app_private.tenant_member_access(tenant_id, false))
        with check (app_private.tenant_member_access(tenant_id, true));
  end if;
end $$;

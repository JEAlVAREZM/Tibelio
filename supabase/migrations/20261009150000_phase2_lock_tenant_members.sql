begin;

-- Separación de la guarda administrativa del bloqueo transaccional de tenant.
-- Permite que miembros operativos (ADMIN y MEMBER) con permisos comerciales de escritura
-- adquieran el bloqueo transaccional de concurrencia sobre la suscripción sin exigir autoridad ADMIN.
-- Revalida sesión, tenant, actividad y licencia bajo bloqueo; bloquea escrituras en READ_ONLY (> 7 días de gracia).
create or replace function app_private.lock_tenant(target uuid) returns void
  language plpgsql security definer set search_path='' as $$
begin
  if not app_private.tenant_member_access(target, true) then
    raise exception 'forbidden' using errcode='42501';
  end if;
  perform 1 from app.subscriptions where tenant_id = target for update;
end $$;

commit;

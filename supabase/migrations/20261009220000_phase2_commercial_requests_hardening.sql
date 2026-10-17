begin;

-- ====================================================================================
-- Historia 2.2: Blindaje de Inmutabilidad, Auditoría y Consecutivos (H22-01, H22-02, H22-03)
-- ====================================================================================

-- 1. H22-03: Retiro de mutación directa en el contador para rol de runtime
revoke insert, update, delete on app.commercial_request_counters from tibelio_dev_app;
drop policy if exists request_counters_insert on app.commercial_request_counters;
drop policy if exists request_counters_update on app.commercial_request_counters;

-- 2. H22-01 y H22-02: Función de blindaje para inmutabilidad y derivación de auditoría
create or replace function app_private.commercial_request_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_actor jsonb := app_private.actor();
  v_actor_user_id uuid;
  v_actor_tenant_id uuid;
begin
  -- Permitir bypass a mantenimiento exclusivo de superusuario sin sesión activa
  if session_user in ('postgres', 'supabase_admin') and v_actor is null then
    if tg_op = 'UPDATE' then
      NEW.updated_at := now();
    end if;
    return NEW;
  end if;

  if v_actor is null or v_actor->>'platformRole' <> 'TENANT' then
    raise exception 'No autenticado o sin rol de empresa' using errcode = '42501';
  end if;

  v_actor_tenant_id := (v_actor->>'tenantId')::uuid;
  v_actor_user_id := (v_actor->>'userId')::uuid;

  if tg_op = 'INSERT' then
    -- Validar que la empresa sea la del actor autenticado
    if NEW.tenant_id <> v_actor_tenant_id then
      raise exception 'Discrepancia de empresa' using errcode = '42501';
    end if;

    -- Rechazar si se intenta atribuir la autoría o modificación a otro usuario
    if NEW.created_by is not null and NEW.created_by <> v_actor_user_id then
      raise exception 'El creador debe coincidir con el usuario de la sesión autenticada' using errcode = '42501';
    end if;
    if NEW.updated_by is not null and NEW.updated_by <> v_actor_user_id then
      raise exception 'El modificador debe coincidir con el usuario de la sesión autenticada' using errcode = '42501';
    end if;

    -- Derivar auditoría de forma estricta desde la sesión verificada y el reloj del sistema
    NEW.created_by := v_actor_user_id;
    NEW.updated_by := v_actor_user_id;
    NEW.created_at := now();
    NEW.updated_at := now();

    return NEW;

  elsif tg_op = 'UPDATE' then
    -- Inmutabilidad universal de identidad, pertenencia y autor de creación
    if NEW.id <> OLD.id then
      raise exception 'El identificador es inmutable' using errcode = '42501';
    end if;
    if NEW.tenant_id <> OLD.tenant_id then
      raise exception 'La empresa es inmutable' using errcode = '42501';
    end if;
    if NEW.created_by <> OLD.created_by then
      raise exception 'El autor de creación es inmutable' using errcode = '42501';
    end if;
    if NEW.created_at <> OLD.created_at then
      raise exception 'La fecha de creación es inmutable' using errcode = '42501';
    end if;

    -- Inmutabilidad específica según tabla
    if tg_table_name = 'commercial_requests' then
      if NEW.code <> OLD.code then
        raise exception 'El código de la solicitud es inmutable' using errcode = '42501';
      end if;
      if NEW.client_id <> OLD.client_id then
        raise exception 'El cliente de la solicitud es inmutable' using errcode = '42501';
      end if;
    elsif tg_table_name = 'request_cabins' then
      if NEW.request_id <> OLD.request_id then
        raise exception 'La solicitud de la cabina es inmutable' using errcode = '42501';
      end if;
      if NEW.product_id <> OLD.product_id then
        raise exception 'El producto de la cabina es inmutable' using errcode = '42501';
      end if;
      if NEW.product_kind <> OLD.product_kind then
        raise exception 'El tipo de producto de la cabina es inmutable' using errcode = '42501';
      end if;
    elsif tg_table_name = 'request_items' then
      if NEW.request_id <> OLD.request_id then
        raise exception 'La solicitud del ítem es inmutable' using errcode = '42501';
      end if;
      if NEW.product_id <> OLD.product_id then
        raise exception 'El producto del ítem es inmutable' using errcode = '42501';
      end if;
      if NEW.product_kind <> OLD.product_kind then
        raise exception 'El tipo de producto del ítem es inmutable' using errcode = '42501';
      end if;
    end if;

    -- Rechazar si se intenta atribuir el modificador a otro usuario
    if NEW.updated_by <> OLD.updated_by and NEW.updated_by <> v_actor_user_id then
      raise exception 'El modificador debe coincidir con el usuario de la sesión autenticada' using errcode = '42501';
    end if;

    -- Establecer modificador y marca temporal actualizados
    NEW.updated_by := v_actor_user_id;
    NEW.updated_at := now();

    return NEW;
  end if;

  return null;
end;
$$;

-- 3. Asignación de triggers BEFORE INSERT OR UPDATE
drop trigger if exists trg_commercial_requests_integrity on app.commercial_requests;
create trigger trg_commercial_requests_integrity
  before insert or update on app.commercial_requests
  for each row execute function app_private.commercial_request_integrity();

drop trigger if exists trg_request_cabins_integrity on app.request_cabins;
create trigger trg_request_cabins_integrity
  before insert or update on app.request_cabins
  for each row execute function app_private.commercial_request_integrity();

drop trigger if exists trg_request_items_integrity on app.request_items;
create trigger trg_request_items_integrity
  before insert or update on app.request_items
  for each row execute function app_private.commercial_request_integrity();

-- 4. Privilegios sobre la función
revoke all on function app_private.commercial_request_integrity() from public;

do $$ declare api_role text; begin
  foreach api_role in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname = api_role) then
      execute format('revoke all on function app_private.commercial_request_integrity() from %I', api_role);
    end if;
  end loop;
end $$;

grant execute on function app_private.commercial_request_integrity() to tibelio_dev_app;

commit;

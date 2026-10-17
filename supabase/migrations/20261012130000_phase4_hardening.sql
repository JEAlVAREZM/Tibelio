-- Migración Incremental: Endurecimiento de Operaciones de Campo (Fase 4 Hardening)
-- Referencias Maestras: DEC-029, DEC-051, OPE-001..005, AT-14..19, Hallazgos C-01 a C-08
-- Criterios de integridad relacional entre solicitudes, tareas, sesiones, paradas, fotos y mediciones

begin;

-- 1. Unicidad compuesta (tenant_id, id, request_id) en app.field_tasks para forzar pertenencia relacional
alter table app.field_tasks
  add constraint field_tasks_tenant_id_request_uniq unique (tenant_id, id, request_id);

-- 2. Integridad de pertenencia de tarea y solicitud en sesiones de instalación (C-03)
alter table app.installation_sessions
  add constraint installation_sessions_task_request_fk
  foreign key (tenant_id, task_id, request_id)
  references app.field_tasks(tenant_id, id, request_id);

-- 3. Integridad de pertenencia de tarea y solicitud en actas de cierre operativo (C-03)
alter table app.operational_closures
  add constraint operational_closures_task_request_fk
  foreign key (tenant_id, task_id, request_id)
  references app.field_tasks(tenant_id, id, request_id);

-- 4. Integridad de pertenencia de tarea y solicitud en paradas de rutas (C-03)
alter table app.field_route_stops
  add constraint field_route_stops_task_request_fk
  foreign key (tenant_id, task_id, request_id)
  references app.field_tasks(tenant_id, id, request_id);

-- 5. Disparador de integridad para fotografías de cierre operativo:
-- Garantiza que si se asocia una cabina a la foto, pertenezca a la misma solicitud del cierre
create or replace function app_private.operational_closure_photo_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_closure_request uuid;
  v_cabin_request uuid;
begin
  if NEW.cabin_id is not null then
    select request_id into v_closure_request from app.operational_closures where tenant_id = NEW.tenant_id and id = NEW.closure_id;
    select request_id into v_cabin_request from app.request_cabins where tenant_id = NEW.tenant_id and id = NEW.cabin_id;
    if v_closure_request is distinct from v_cabin_request then
      raise exception 'La cabina de la fotografía no pertenece a la solicitud del cierre operativo' using errcode = '23514';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_operational_closure_photo_integrity on app.operational_closure_photos;
create trigger trg_operational_closure_photo_integrity
  before insert or update on app.operational_closure_photos
  for each row execute function app_private.operational_closure_photo_integrity();

-- 6. Disparador de integridad para mediciones de visita técnica:
-- Garantiza que la cabina medida pertenezca a la misma solicitud de la visita
create or replace function app_private.field_visit_measure_integrity()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_visit_request uuid;
  v_cabin_request uuid;
begin
  select request_id into v_visit_request from app.field_visits where tenant_id = NEW.tenant_id and id = NEW.visit_id;
  select request_id into v_cabin_request from app.request_cabins where tenant_id = NEW.tenant_id and id = NEW.cabin_id;
  if v_visit_request is distinct from v_cabin_request then
    raise exception 'La cabina medida no pertenece a la solicitud de la visita técnica' using errcode = '23514';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_field_visit_measure_integrity on app.field_visit_cabin_measures;
create trigger trg_field_visit_measure_integrity
  before insert or update on app.field_visit_cabin_measures
  for each row execute function app_private.field_visit_measure_integrity();

-- 7. Persistencia de referencia estable a producto en líneas de cotización (C-06)
alter table app.quotation_items
  add column if not exists product_id uuid null;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'quotation_items_product_fk'
  ) then
    alter table app.quotation_items
      add constraint quotation_items_product_fk
      foreign key (tenant_id, product_id)
      references app.catalog_products(tenant_id, id);
  end if;
end $$;

-- 8. Disparador para impedir transiciones o creación de tareas/sesiones en solicitudes cerradas operativamente
create or replace function app_private.commercial_request_closure_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_has_closure boolean;
begin
  select exists (
    select 1 from app.operational_closures
    where tenant_id = NEW.tenant_id and request_id = NEW.request_id
  ) into v_has_closure;

  if v_has_closure then
    raise exception 'La solicitud ya cuenta con un cierre operativo y entrega firmada. Operación no permitida.'
      using errcode = '23514';
  end if;
  return NEW;
end;
$$;

drop trigger if exists trg_guard_tasks_on_closed_request on app.field_tasks;
create trigger trg_guard_tasks_on_closed_request
  before insert on app.field_tasks
  for each row execute function app_private.commercial_request_closure_guard();

drop trigger if exists trg_guard_sessions_on_closed_request on app.installation_sessions;
create trigger trg_guard_sessions_on_closed_request
  before insert on app.installation_sessions
  for each row execute function app_private.commercial_request_closure_guard();

-- 9. Confirmar permisos
grant select, insert, update on
  app.field_tasks,
  app.installation_sessions,
  app.operational_closures,
  app.operational_closure_photos,
  app.field_route_stops,
  app.field_visit_cabin_measures,
  app.quotation_items
to tibelio_dev_app;

revoke delete on
  app.field_tasks,
  app.installation_sessions,
  app.operational_closures,
  app.operational_closure_photos,
  app.field_route_stops,
  app.field_visit_cabin_measures,
  app.quotation_items
from tibelio_dev_app;

commit;

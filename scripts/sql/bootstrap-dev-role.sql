-- Infraestructura Fase 0: ejecutar solo en Tibelio DEV, como administrador.
-- No es una migración de entidades de negocio ni crea una credencial.
-- Se detiene si el rol ya existe: nunca sobrescribe roles existentes.
begin;
create role tibelio_dev_app
  nologin nosuperuser nocreatedb nocreaterole noinherit noreplication nobypassrls
  connection limit 5;
alter role tibelio_dev_app set default_transaction_read_only = on;
alter role tibelio_dev_app set statement_timeout = '8s';
commit;

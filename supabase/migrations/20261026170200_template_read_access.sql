-- Template documents call api.get_product while executing as app_executor.
-- USAGE allows name resolution, without granting CREATE or exposing private tables.
GRANT USAGE ON SCHEMA api TO app_executor;

NOTIFY pgrst, 'reload schema';

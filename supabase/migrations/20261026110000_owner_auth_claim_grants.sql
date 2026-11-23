-- The owner lookup runs as app_executor and reads only the verified JWT subject.
-- Keep the narrow schema/function grants needed for auth.uid(), not Auth tables.
GRANT USAGE ON SCHEMA auth TO app_executor;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_executor;

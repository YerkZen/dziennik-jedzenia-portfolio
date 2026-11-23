-- Deferred checks run after the RPC's SECURITY DEFINER context has ended.
-- The function remains owned by app_executor, which is subject to FORCE RLS.
ALTER FUNCTION private.ensure_template_has_items() SECURITY DEFINER;

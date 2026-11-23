-- Hosted postgres cannot grant USAGE on Supabase's managed auth schema.
-- Read exactly the verified PostgREST request settings used by auth.uid(),
-- without inheriting authenticated's Storage/Realtime privileges.
CREATE FUNCTION private.request_subject()
RETURNS uuid LANGUAGE sql STABLE SECURITY INVOKER SET search_path = '' AS $$
  SELECT coalesce(
    nullif(pg_catalog.current_setting('request.jwt.claim.sub', true), ''),
    (nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;
REVOKE ALL ON FUNCTION private.request_subject() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.request_subject() TO app_executor;

DO $$
DECLARE
  migration_role name := current_user;
  had_membership boolean;
  original_set boolean;
  can_set boolean;
  item record;
  definition text;
  command text;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles g ON g.oid=m.roleid
    JOIN pg_catalog.pg_roles r ON r.oid=m.member
    WHERE g.rolname='app_executor' AND r.rolname=migration_role
  ) INTO had_membership;
  IF had_membership THEN
    SELECT m.set_option INTO original_set FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles g ON g.oid=m.roleid
    JOIN pg_catalog.pg_roles r ON r.oid=m.member
    WHERE g.rolname='app_executor' AND r.rolname=migration_role;
  END IF;
  SELECT pg_catalog.pg_has_role(current_user,'app_executor','SET') INTO can_set;
  IF NOT can_set THEN
    EXECUTE pg_catalog.format('GRANT app_executor TO %I WITH SET TRUE',migration_role);
  END IF;

  FOR item IN
    SELECT p.oid FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname IN ('api','private') AND p.prokind='f'
      AND p.prosrc LIKE '%auth.uid()%'
  LOOP
    definition := pg_catalog.pg_get_functiondef(item.oid);
    EXECUTE pg_catalog.replace(definition,'auth.uid()','private.request_subject()');
  END LOOP;

  FOR item IN
    SELECT p.polname, c.relname,
      pg_catalog.pg_get_expr(p.polqual,p.polrelid) AS using_expression,
      pg_catalog.pg_get_expr(p.polwithcheck,p.polrelid) AS check_expression
    FROM pg_catalog.pg_policy p
    JOIN pg_catalog.pg_class c ON c.oid=p.polrelid
    JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='private'
  LOOP
    command := pg_catalog.format('ALTER POLICY %I ON private.%I',item.polname,item.relname);
    IF item.using_expression IS NOT NULL THEN
      command := command || ' USING (' || pg_catalog.replace(item.using_expression,'auth.uid()','private.request_subject()') || ')';
    END IF;
    IF item.check_expression IS NOT NULL THEN
      command := command || ' WITH CHECK (' || pg_catalog.replace(item.check_expression,'auth.uid()','private.request_subject()') || ')';
    END IF;
    EXECUTE command;
  END LOOP;

  IF NOT can_set THEN
    IF had_membership THEN
      IF NOT original_set THEN
        EXECUTE pg_catalog.format('GRANT app_executor TO %I WITH SET FALSE',migration_role);
      END IF;
    ELSE
      EXECUTE pg_catalog.format('REVOKE app_executor FROM %I',migration_role);
    END IF;
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';

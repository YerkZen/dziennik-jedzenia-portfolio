-- D007 / TASK-054. Preserve operator ACL; temporarily acquire ownership capability as in migration020.
DO $upgrade$
DECLARE
    migration_role name := current_user;
    previous_set boolean;
    can_set boolean;
    had_create boolean;
BEGIN
    SELECT membership.set_option INTO previous_set
      FROM pg_catalog.pg_auth_members membership
      JOIN pg_catalog.pg_roles granted ON granted.oid=membership.roleid
      JOIN pg_catalog.pg_roles member ON member.oid=membership.member
      JOIN pg_catalog.pg_roles grantor ON grantor.oid=membership.grantor
     WHERE granted.rolname='app_executor' AND member.rolname=migration_role AND grantor.rolname=migration_role;
    SELECT pg_catalog.pg_has_role(current_user,'app_executor','SET') INTO can_set;
    IF NOT can_set THEN
        EXECUTE pg_catalog.format('GRANT app_executor TO %I WITH SET TRUE',migration_role);
    END IF;
    SELECT pg_catalog.has_schema_privilege('app_executor','private','CREATE') INTO had_create;
    IF NOT had_create THEN GRANT CREATE ON SCHEMA private TO app_executor; END IF;
    EXECUTE $definition$CREATE OR REPLACE FUNCTION private.export_domain_table(p_table text)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_columns text[];
    v_projection text;
    v_rows jsonb;
    v_key text;
BEGIN
    IF p_table IS NULL OR p_table NOT IN (
        'app_user','product','meal_template','meal_template_item',
        'diary_meal','diary_item','goal_version','weight_entry','mutation_receipt'
    ) THEN
        RAISE EXCEPTION 'Unsupported backup table' USING ERRCODE = '22023';
    END IF;
    SELECT pg_catalog.array_agg(a.attname::text ORDER BY a.attnum),
           pg_catalog.string_agg(pg_catalog.format('%I::text AS %I',a.attname,a.attname),',' ORDER BY a.attnum)
      INTO v_columns,v_projection
      FROM pg_catalog.pg_attribute a
     WHERE a.attrelid=pg_catalog.format('private.%I',p_table)::pg_catalog.regclass
       AND a.attnum>0 AND NOT a.attisdropped;
    v_key := CASE WHEN p_table='mutation_receipt' THEN 'key' ELSE 'id' END;
    EXECUTE pg_catalog.format(
        'SELECT COALESCE(pg_catalog.jsonb_agg(pg_catalog.to_jsonb(rows) ORDER BY rows.%I),''[]''::jsonb) FROM (SELECT %s FROM private.%I) rows',
        v_key,v_projection,p_table
    ) INTO v_rows;
    RETURN pg_catalog.jsonb_build_object('columns',v_columns,'rows',v_rows);
END;
$$;
$definition$;
    ALTER FUNCTION private.export_domain_table(text) OWNER TO app_executor;
    IF NOT had_create THEN REVOKE CREATE ON SCHEMA private FROM app_executor; END IF;
    EXECUTE pg_catalog.format('GRANT EXECUTE ON FUNCTION private.export_domain_table(text) TO %I',migration_role);
    IF NOT can_set THEN
        IF previous_set IS NULL THEN
            EXECUTE pg_catalog.format('REVOKE app_executor FROM %I GRANTED BY CURRENT_USER',migration_role);
        ELSE
            EXECUTE pg_catalog.format('GRANT app_executor TO %I WITH SET FALSE',migration_role);
        END IF;
    END IF;
END;
$upgrade$;

REVOKE ALL ON FUNCTION private.export_domain_table(text) FROM PUBLIC,anon,authenticated;

-- JSON null must not bypass the required new-item discriminator in direct RPC.
DO $$
DECLARE
    migration_role name := current_user;
    v_definition text;
    had_direct_membership boolean;
    direct_set_option boolean;
    can_set_role boolean;
BEGIN
    SELECT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
          JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
         WHERE granted.rolname = 'app_executor'
           AND member.rolname = migration_role
    ) INTO had_direct_membership;

    IF had_direct_membership THEN
        SELECT membership.set_option
          INTO direct_set_option
          FROM pg_catalog.pg_auth_members AS membership
          JOIN pg_catalog.pg_roles AS granted ON granted.oid = membership.roleid
          JOIN pg_catalog.pg_roles AS member ON member.oid = membership.member
         WHERE granted.rolname = 'app_executor'
           AND member.rolname = migration_role;
    END IF;

    SELECT pg_catalog.pg_has_role(current_user, 'app_executor', 'SET')
      INTO can_set_role;
    IF NOT can_set_role THEN
        EXECUTE pg_catalog.format('GRANT app_executor TO %I WITH SET TRUE', migration_role);
    END IF;

    GRANT CREATE ON SCHEMA api TO app_executor;
    SELECT pg_catalog.pg_get_functiondef('api.create_meal(jsonb,uuid)'::regprocedure) INTO v_definition;
    IF pg_catalog.strpos(v_definition, 'OR v_item->>''kind'' <> ''new''') = 0 THEN
        RAISE EXCEPTION 'Expected create_meal validation is missing';
    END IF;
    v_definition := pg_catalog.replace(v_definition, 'OR v_item->>''kind'' <> ''new''',
        'OR pg_catalog.jsonb_typeof(v_item->''kind'') <> ''string'' OR v_item->>''kind'' IS DISTINCT FROM ''new''');
    v_definition := pg_catalog.replace(v_definition, 'Invalid source meal', 'Invalid source template');
    EXECUTE 'SET LOCAL ROLE app_executor';
    EXECUTE v_definition;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', migration_role);
    REVOKE CREATE ON SCHEMA api FROM app_executor;

    IF NOT can_set_role THEN
        IF had_direct_membership THEN
            IF NOT direct_set_option THEN
                EXECUTE pg_catalog.format('GRANT app_executor TO %I WITH SET FALSE', migration_role);
            END IF;
        ELSE
            EXECUTE pg_catalog.format('REVOKE app_executor FROM %I', migration_role);
        END IF;
    END IF;
END;
$$;

NOTIFY pgrst, 'reload schema';

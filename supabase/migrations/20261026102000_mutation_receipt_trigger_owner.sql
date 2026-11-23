ALTER FUNCTION private.ensure_mutation_receipt_completed() SECURITY DEFINER;

DO $$
DECLARE
    migration_role name := current_user;
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

    GRANT CREATE ON SCHEMA private TO app_executor;
    ALTER FUNCTION private.ensure_mutation_receipt_completed() OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA private FROM app_executor;

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

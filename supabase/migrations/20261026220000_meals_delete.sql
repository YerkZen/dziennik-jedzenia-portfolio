CREATE OR REPLACE FUNCTION private.guard_diary_meal_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (OLD.deleted_at IS NOT NULL AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'Meal identity and tombstones are immutable' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER diary_meal_identity_immutable BEFORE UPDATE ON private.diary_meal
FOR EACH ROW EXECUTE FUNCTION private.guard_diary_meal_identity();

CREATE OR REPLACE FUNCTION api.delete_meal(
    p_meal_id uuid,
    p_expected_revision integer,
    p_idempotency_key uuid
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner_id uuid;
    v_current_revision integer;
    v_deleted_at timestamptz;
    v_next_revision integer;
    v_canonical_payload jsonb;
    v_request_hash text;
    v_replayed boolean;
    v_applied_revision integer;
BEGIN
    IF p_meal_id IS NULL OR p_idempotency_key IS NULL
       OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
        RAISE EXCEPTION 'Invalid product archive request'
            USING ERRCODE = '22023';
    END IF;

    SELECT account.id
      INTO v_owner_id
      FROM private.app_user AS account
     WHERE account.singleton = 1
       AND account.auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped'
            USING ERRCODE = '42501';
    END IF;

    SELECT meal.revision, meal.deleted_at
      INTO v_current_revision, v_deleted_at
      FROM private.diary_meal AS meal
     WHERE meal.owner_id = v_owner_id
       AND meal.id = p_meal_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_canonical_payload := pg_catalog.jsonb_build_object(
        'expected_revision', p_expected_revision
    );
    v_request_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_canonical_payload::text, 'UTF8')),
        'hex'
    );

    SELECT receipt.replayed, receipt.applied_revision
      INTO v_replayed, v_applied_revision
      FROM private.begin_mutation(
          v_owner_id, p_idempotency_key, 'deleteMeal', p_meal_id, v_request_hash
      ) AS receipt;

    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object(
            'resource_id', p_meal_id::text,
            'applied_revision', v_applied_revision,
            'current_revision', v_current_revision,
            'replayed', true,
            'deleted', true
        );
    END IF;
    IF v_deleted_at IS NOT NULL THEN
        RAISE EXCEPTION 'RESOURCE_DELETED' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision = 2147483647 THEN
        RAISE EXCEPTION 'MEAL_REVISION_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE private.diary_meal AS meal
       SET deleted_at = pg_catalog.clock_timestamp(),
           revision = meal.revision + 1,
           updated_at = pg_catalog.clock_timestamp()
     WHERE meal.owner_id = v_owner_id
       AND meal.id = p_meal_id
       AND meal.revision = p_expected_revision
       AND meal.deleted_at IS NULL
    RETURNING meal.revision INTO v_next_revision;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;

    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, v_next_revision);
    RETURN pg_catalog.jsonb_build_object(
        'resource_id', p_meal_id::text,
        'applied_revision', v_next_revision,
        'current_revision', v_next_revision,
        'replayed', false,
        'deleted', true
    );
END;
$$;

REVOKE ALL ON FUNCTION api.delete_meal(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_diary_meal_identity() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.guard_diary_meal_identity() TO app_executor;
GRANT CREATE ON SCHEMA api, private TO app_executor;

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

    ALTER FUNCTION api.delete_meal(uuid, integer, uuid) OWNER TO app_executor;
    ALTER FUNCTION private.guard_diary_meal_identity() OWNER TO app_executor;
    SELECT pg_catalog.pg_get_functiondef('api.create_meal(jsonb,uuid)'::regprocedure) INTO v_definition;
    v_definition := pg_catalog.replace(v_definition, '    v_current integer;', '    v_current integer; v_deleted timestamptz;');
    v_definition := pg_catalog.replace(v_definition,
        'SELECT revision INTO v_current FROM private.diary_meal',
        'SELECT revision, deleted_at INTO v_current, v_deleted FROM private.diary_meal');
    v_definition := pg_catalog.replace(v_definition,
        '''current_revision'', v_current, ''replayed'', true, ''deleted'', false',
        '''current_revision'', v_current, ''replayed'', true, ''deleted'', v_deleted IS NOT NULL');
    EXECUTE 'SET LOCAL ROLE app_executor';
    EXECUTE v_definition;
    EXECUTE pg_catalog.format('SET LOCAL ROLE %I', migration_role);
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.delete_meal(uuid, integer, uuid) TO authenticated;

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

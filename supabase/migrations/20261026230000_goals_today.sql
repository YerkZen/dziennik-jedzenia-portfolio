CREATE OR REPLACE FUNCTION private.guard_goal_version()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from OR NEW.created_at IS DISTINCT FROM OLD.created_at
       OR (OLD.effective_from < (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date AND NEW IS DISTINCT FROM OLD) THEN
        RAISE EXCEPTION 'Goal identity and past versions are immutable' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER goal_version_immutable BEFORE UPDATE ON private.goal_version
FOR EACH ROW EXECUTE FUNCTION private.guard_goal_version();

CREATE OR REPLACE FUNCTION api.save_today_goals(p_payload jsonb, p_expected_revision integer, p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_id uuid;
    v_date date;
    v_today date := (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date;
    v_goal private.goal_version%ROWTYPE;
    v_values jsonb := '{}'::jsonb;
    v_field text;
    v_value numeric;
    v_hash text;
    v_replayed boolean;
    v_applied integer;
    v_current integer;
BEGIN
    IF p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_idempotency_key IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 0
       OR p_payload - ARRAY['id','expected_date','kcal_goal','protein_goal','fat_goal','carbs_goal'] <> '{}'::jsonb
       OR NOT(p_payload ?& ARRAY['id','expected_date','kcal_goal','protein_goal','fat_goal','carbs_goal'])
       OR pg_catalog.jsonb_typeof(p_payload->'id') <> 'string'
       OR p_payload->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(p_payload->'expected_date') <> 'string'
       OR p_payload->>'expected_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
        RAISE EXCEPTION 'Invalid goals command' USING ERRCODE = '22023';
    END IF;
    v_id := (p_payload->>'id')::uuid;
    BEGIN
        v_date := (p_payload->>'expected_date')::date;
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Invalid expected date' USING ERRCODE = '22023';
    END;
    FOREACH v_field IN ARRAY ARRAY['kcal_goal','protein_goal','fat_goal','carbs_goal'] LOOP
        IF pg_catalog.jsonb_typeof(p_payload->v_field) <> 'string' THEN
            RAISE EXCEPTION 'Goals must be decimal text' USING ERRCODE = '22023';
        END IF;
        v_value := private.assert_decimal_10_2(p_payload->>v_field, false);
        v_values := v_values || pg_catalog.jsonb_build_object(v_field, pg_catalog.trim_scale(v_value)::text);
    END LOOP;
    -- Serialize the first version too, without conflicting with FK KEY SHARE locks.
    SELECT id INTO v_owner_id FROM private.app_user
    WHERE singleton = 1 AND auth_subject = (SELECT auth.uid()) FOR NO KEY UPDATE;
    IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authenticated owner is not mapped' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_goal FROM private.goal_version WHERE owner_id = v_owner_id AND effective_from = v_today FOR UPDATE;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to((v_values || pg_catalog.jsonb_build_object(
        'expected_date', v_date::text, 'expected_revision', p_expected_revision))::text, 'UTF8')), 'hex');
    SELECT r.replayed,r.applied_revision INTO v_replayed,v_applied
    FROM private.begin_mutation(v_owner_id,p_idempotency_key,'saveTodayGoals',v_id,v_hash) r;
    IF v_replayed THEN
        SELECT revision INTO v_current FROM private.goal_version WHERE owner_id = v_owner_id AND id = v_id;
        IF v_current IS NULL THEN RAISE EXCEPTION 'Goal version no longer exists' USING ERRCODE = '55000'; END IF;
        RETURN pg_catalog.jsonb_build_object('resource_id',v_id::text,'applied_revision',v_applied,
            'current_revision',v_current,'replayed',true,'deleted',false);
    END IF;
    IF v_date <> v_today THEN RAISE EXCEPTION 'DAY_CHANGED' USING ERRCODE = 'P0001'; END IF;
    IF COALESCE(v_goal.revision,0) <> p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    IF v_goal.id IS NOT NULL AND v_goal.id <> v_id THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    IF v_goal.revision = 2147483647 THEN RAISE EXCEPTION 'GOAL_REVISION_EXHAUSTED' USING ERRCODE = 'P0001'; END IF;
    IF v_goal.id IS NULL THEN
        INSERT INTO private.goal_version(id,owner_id,effective_from,kcal_goal,protein_goal,fat_goal,carbs_goal)
        VALUES(v_id,v_owner_id,v_today,(v_values->>'kcal_goal')::numeric,(v_values->>'protein_goal')::numeric,
            (v_values->>'fat_goal')::numeric,(v_values->>'carbs_goal')::numeric);
        v_current := 1;
    ELSE
        UPDATE private.goal_version SET kcal_goal = (v_values->>'kcal_goal')::numeric,
            protein_goal = (v_values->>'protein_goal')::numeric, fat_goal = (v_values->>'fat_goal')::numeric,
            carbs_goal = (v_values->>'carbs_goal')::numeric, revision = revision + 1, updated_at = pg_catalog.clock_timestamp()
        WHERE owner_id = v_owner_id AND id = v_id RETURNING revision INTO v_current;
    END IF;
    PERFORM private.complete_mutation(v_owner_id,p_idempotency_key,v_current);
    RETURN pg_catalog.jsonb_build_object('resource_id',v_id::text,'applied_revision',v_current,
        'current_revision',v_current,'replayed',false,'deleted',false);
END;
$$;

REVOKE ALL ON FUNCTION api.save_today_goals(jsonb, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_goal_version() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.guard_goal_version() TO app_executor;
GRANT CREATE ON SCHEMA api, private TO app_executor;

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

    ALTER FUNCTION api.save_today_goals(jsonb, integer, uuid) OWNER TO app_executor;
    ALTER FUNCTION private.guard_goal_version() OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.save_today_goals(jsonb, integer, uuid) TO authenticated;

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

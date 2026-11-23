-- D007 / TASK-048. Additive schema; applied to isolated QA before release.
CREATE TABLE private.weight_entry (
    id uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid() UNIQUE,
    owner_id uuid NOT NULL REFERENCES private.app_user(id) ON DELETE CASCADE,
    entry_date date NOT NULL CHECK (entry_date >= DATE '1900-01-01' AND pg_catalog.isfinite(entry_date)),
    weight_kg numeric(5,2),
    revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT pg_catalog.transaction_timestamp(),
    deleted_at timestamptz,
    PRIMARY KEY (owner_id, entry_date),
    CHECK ((deleted_at IS NULL AND weight_kg IS NOT NULL AND weight_kg BETWEEN 0.01 AND 999.99)
        OR (deleted_at IS NOT NULL AND weight_kg IS NULL))
);
ALTER TABLE private.weight_entry ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.weight_entry FORCE ROW LEVEL SECURITY;
CREATE POLICY weight_entry_owner ON private.weight_entry FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT private.request_subject())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT private.request_subject())));
REVOKE ALL ON TABLE private.weight_entry FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE private.weight_entry TO app_executor;

CREATE FUNCTION private.guard_weight_entry() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
BEGIN
    IF NEW.entry_date > (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date THEN
        RAISE EXCEPTION 'Invalid weight date' USING ERRCODE = '22023';
    END IF;
    IF TG_OP = 'INSERT' THEN
        IF NEW.revision <> 1 OR NEW.deleted_at IS NOT NULL THEN
            RAISE EXCEPTION 'Invalid initial weight state' USING ERRCODE = '22023';
        END IF;
    ELSE
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
           OR NEW.entry_date IS DISTINCT FROM OLD.entry_date OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.revision::bigint <> OLD.revision::bigint + 1 THEN
            RAISE EXCEPTION 'Weight identity and monotonic revision are immutable' USING ERRCODE = '22023';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER weight_entry_guard BEFORE INSERT OR UPDATE ON private.weight_entry
FOR EACH ROW EXECUTE FUNCTION private.guard_weight_entry();

CREATE FUNCTION private.mutate_weight_entry(
    p_date date, p_payload jsonb, p_expected_revision integer, p_idempotency_key uuid, p_delete boolean
) RETURNS jsonb LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
DECLARE
    v_owner uuid;
    v_entry private.weight_entry%ROWTYPE;
    v_id uuid;
    v_weight numeric;
    v_hash text;
    v_replayed boolean;
    v_applied integer;
    v_revision integer;
    v_deleted boolean;
BEGIN
    IF p_date IS NULL OR NOT pg_catalog.isfinite(p_date) OR p_date < DATE '1900-01-01'
       OR p_date > (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date
       OR p_expected_revision IS NULL OR p_expected_revision < 0 OR p_idempotency_key IS NULL OR p_delete IS NULL THEN
        RAISE EXCEPTION 'Invalid weight command' USING ERRCODE = '22023';
    END IF;
    IF NOT p_delete THEN
        IF pg_catalog.jsonb_typeof(p_payload) IS DISTINCT FROM 'object'
           OR p_payload - 'weight_kg' <> '{}'::jsonb
           OR pg_catalog.jsonb_typeof(p_payload->'weight_kg') IS DISTINCT FROM 'string' THEN
            RAISE EXCEPTION 'Invalid weight payload' USING ERRCODE = '22023';
        END IF;
        IF p_payload->>'weight_kg' !~ '^(0|[1-9][0-9]{0,2})(\.[0-9]{1,2})?$' THEN
            RAISE EXCEPTION 'Invalid weight precision' USING ERRCODE = '22023';
        END IF;
        v_weight := (p_payload->>'weight_kg')::numeric;
        IF v_weight <= 0 OR v_weight > 999.99 THEN
            RAISE EXCEPTION 'Invalid weight range' USING ERRCODE = '22023';
        END IF;
    END IF;
    -- Same lock order as existing domain writes. Serializes a date's first insert too.
    SELECT id INTO v_owner FROM private.app_user
    WHERE singleton = 1 AND auth_subject = (SELECT private.request_subject()) FOR NO KEY UPDATE;
    IF v_owner IS NULL THEN RAISE EXCEPTION 'Owner required' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_entry FROM private.weight_entry WHERE owner_id = v_owner AND entry_date = p_date FOR UPDATE;
    v_id := COALESCE(v_entry.id, pg_catalog.gen_random_uuid());
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'date',p_date::text,'weight_kg',pg_catalog.trim_scale(v_weight)::text,
        'expected_revision',p_expected_revision,'delete',p_delete)::text,'UTF8')),'hex');
    -- Replay precedes OCC; retains original applied revision and returns current state.
    SELECT r.replayed,r.applied_revision INTO v_replayed,v_applied FROM private.begin_mutation(
        v_owner,p_idempotency_key,CASE WHEN p_delete THEN 'deleteWeightEntry' ELSE 'saveWeightEntry' END,v_id,v_hash) r;
    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object('date',p_date::text,'applied_revision',v_applied,
            'current_revision',v_entry.revision,'replayed',true,'deleted',v_entry.deleted_at IS NOT NULL);
    END IF;
    IF COALESCE(v_entry.revision,0) <> p_expected_revision THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF p_delete AND (v_entry.id IS NULL OR v_entry.deleted_at IS NOT NULL) THEN
        RAISE EXCEPTION 'NOT_FOUND' USING ERRCODE = 'P0002';
    END IF;
    IF v_entry.revision = 2147483647 THEN
        RAISE EXCEPTION 'REVISION_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;
    IF v_entry.id IS NULL THEN
        INSERT INTO private.weight_entry(id,owner_id,entry_date,weight_kg)
        VALUES(v_id,v_owner,p_date,v_weight) RETURNING revision INTO v_revision;
    ELSE
        UPDATE private.weight_entry SET weight_kg = CASE WHEN p_delete THEN NULL ELSE v_weight END,
            deleted_at = CASE WHEN p_delete THEN pg_catalog.clock_timestamp() ELSE NULL END,
            updated_at = pg_catalog.clock_timestamp(), revision = revision + 1
        WHERE owner_id = v_owner AND entry_date = p_date RETURNING revision INTO v_revision;
    END IF;
    v_deleted := p_delete;
    PERFORM private.complete_mutation(v_owner,p_idempotency_key,v_revision);
    RETURN pg_catalog.jsonb_build_object('date',p_date::text,'applied_revision',v_revision,
        'current_revision',v_revision,'replayed',false,'deleted',v_deleted);
END;
$$;

CREATE FUNCTION api.save_weight_entry(p_date date,p_payload jsonb,p_expected_revision integer,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.mutate_weight_entry(p_date,p_payload,p_expected_revision,p_idempotency_key,false)
$$;
CREATE FUNCTION api.delete_weight_entry(p_date date,p_expected_revision integer,p_idempotency_key uuid)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.mutate_weight_entry(p_date,NULL,p_expected_revision,p_idempotency_key,true)
$$;
REVOKE ALL ON FUNCTION private.guard_weight_entry() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION private.mutate_weight_entry(date,jsonb,integer,uuid,boolean) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION api.save_weight_entry(date,jsonb,integer,uuid) FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION api.delete_weight_entry(date,integer,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.guard_weight_entry() TO app_executor;
GRANT EXECUTE ON FUNCTION private.mutate_weight_entry(date,jsonb,integer,uuid,boolean) TO app_executor;
GRANT CREATE ON SCHEMA api,private TO app_executor;

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

    ALTER FUNCTION api.save_weight_entry(date,jsonb,integer,uuid) OWNER TO app_executor;
    ALTER FUNCTION api.delete_weight_entry(date,integer,uuid) OWNER TO app_executor;
    ALTER FUNCTION private.mutate_weight_entry(date,jsonb,integer,uuid,boolean) OWNER TO app_executor;
    ALTER FUNCTION private.guard_weight_entry() OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.save_weight_entry(date,jsonb,integer,uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.delete_weight_entry(date,integer,uuid) TO authenticated;

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

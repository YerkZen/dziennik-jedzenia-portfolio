CREATE OR REPLACE FUNCTION api.update_product(
    p_product_id uuid,
    p_payload jsonb,
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
    v_archived_at timestamptz;
    v_next_revision integer;
    v_name text;
    v_kcal numeric;
    v_protein numeric;
    v_fat numeric;
    v_carbs numeric;
    v_canonical_payload jsonb;
    v_request_hash text;
    v_replayed boolean;
    v_applied_revision integer;
BEGIN
    IF p_product_id IS NULL OR p_idempotency_key IS NULL
       OR p_expected_revision IS NULL OR p_expected_revision < 1
       OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload - ARRAY['name', 'kcal_per_100', 'protein_per_100', 'fat_per_100', 'carbs_per_100'] <> '{}'::jsonb
       OR NOT (p_payload ?& ARRAY['name', 'kcal_per_100', 'protein_per_100', 'fat_per_100', 'carbs_per_100']) THEN
        RAISE EXCEPTION 'Invalid product update request'
            USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.jsonb_typeof(p_payload -> 'name') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'kcal_per_100') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'protein_per_100') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'fat_per_100') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'carbs_per_100') <> 'string' THEN
        RAISE EXCEPTION 'Invalid product update field type'
            USING ERRCODE = '22023';
    END IF;

    v_name := pg_catalog.btrim(p_payload ->> 'name');
    IF pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 160 THEN
        RAISE EXCEPTION 'Invalid product name'
            USING ERRCODE = '22023';
    END IF;
    v_kcal := private.assert_decimal_10_2(p_payload ->> 'kcal_per_100', true);
    v_protein := private.assert_decimal_10_2(p_payload ->> 'protein_per_100', true);
    v_fat := private.assert_decimal_10_2(p_payload ->> 'fat_per_100', true);
    v_carbs := private.assert_decimal_10_2(p_payload ->> 'carbs_per_100', true);

    SELECT account.id
      INTO v_owner_id
      FROM private.app_user AS account
     WHERE account.singleton = 1
       AND account.auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped'
            USING ERRCODE = '42501';
    END IF;

    SELECT product.revision, product.archived_at
      INTO v_current_revision, v_archived_at
      FROM private.product AS product
     WHERE product.owner_id = v_owner_id
       AND product.id = p_product_id
     FOR UPDATE;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_canonical_payload := pg_catalog.jsonb_build_object(
        'expected_revision', p_expected_revision,
        'name', v_name,
        'kcal_per_100', v_kcal::text,
        'protein_per_100', v_protein::text,
        'fat_per_100', v_fat::text,
        'carbs_per_100', v_carbs::text
    );
    v_request_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(v_canonical_payload::text, 'UTF8')),
        'hex'
    );

    SELECT receipt.replayed, receipt.applied_revision
      INTO v_replayed, v_applied_revision
      FROM private.begin_mutation(
          v_owner_id, p_idempotency_key, 'updateProduct', p_product_id, v_request_hash
      ) AS receipt;

    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object(
            'resource_id', p_product_id::text,
            'applied_revision', v_applied_revision,
            'current_revision', v_current_revision,
            'replayed', true,
            'deleted', false
        );
    END IF;
    IF v_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'PRODUCT_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision = 2147483647 THEN
        RAISE EXCEPTION 'PRODUCT_REVISION_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE private.product AS product
       SET name = v_name,
           kcal_per_100 = v_kcal,
           protein_per_100 = v_protein,
           fat_per_100 = v_fat,
           carbs_per_100 = v_carbs,
           revision = product.revision + 1,
           updated_at = pg_catalog.clock_timestamp()
     WHERE product.owner_id = v_owner_id
       AND product.id = p_product_id
       AND product.revision = p_expected_revision
    RETURNING product.revision INTO v_next_revision;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;

    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, v_next_revision);
    RETURN pg_catalog.jsonb_build_object(
        'resource_id', p_product_id::text,
        'applied_revision', v_next_revision,
        'current_revision', v_next_revision,
        'replayed', false,
        'deleted', false
    );
END;
$$;

CREATE OR REPLACE FUNCTION api.archive_product(
    p_product_id uuid,
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
    v_archived_at timestamptz;
    v_next_revision integer;
    v_canonical_payload jsonb;
    v_request_hash text;
    v_replayed boolean;
    v_applied_revision integer;
BEGIN
    IF p_product_id IS NULL OR p_idempotency_key IS NULL
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

    SELECT product.revision, product.archived_at
      INTO v_current_revision, v_archived_at
      FROM private.product AS product
     WHERE product.owner_id = v_owner_id
       AND product.id = p_product_id
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
          v_owner_id, p_idempotency_key, 'archiveProduct', p_product_id, v_request_hash
      ) AS receipt;

    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object(
            'resource_id', p_product_id::text,
            'applied_revision', v_applied_revision,
            'current_revision', v_current_revision,
            'replayed', true,
            'deleted', false
        );
    END IF;
    IF v_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'PRODUCT_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision = 2147483647 THEN
        RAISE EXCEPTION 'PRODUCT_REVISION_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE private.product AS product
       SET archived_at = pg_catalog.clock_timestamp(),
           revision = product.revision + 1,
           updated_at = pg_catalog.clock_timestamp()
     WHERE product.owner_id = v_owner_id
       AND product.id = p_product_id
       AND product.revision = p_expected_revision
       AND product.archived_at IS NULL
    RETURNING product.revision INTO v_next_revision;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;

    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, v_next_revision);
    RETURN pg_catalog.jsonb_build_object(
        'resource_id', p_product_id::text,
        'applied_revision', v_next_revision,
        'current_revision', v_next_revision,
        'replayed', false,
        'deleted', false
    );
END;
$$;

REVOKE ALL ON FUNCTION api.update_product(uuid, jsonb, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.archive_product(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
GRANT CREATE ON SCHEMA api TO app_executor;

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

    ALTER FUNCTION api.update_product(uuid, jsonb, integer, uuid) OWNER TO app_executor;
    ALTER FUNCTION api.archive_product(uuid, integer, uuid) OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.update_product(uuid, jsonb, integer, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.archive_product(uuid, integer, uuid) TO authenticated;

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

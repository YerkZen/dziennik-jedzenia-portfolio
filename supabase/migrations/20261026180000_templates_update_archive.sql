CREATE OR REPLACE FUNCTION api.update_template(p_template_id uuid, p_payload jsonb, p_expected_revision integer, p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_id uuid := p_template_id;
    v_archived_at timestamptz;
    v_name text;
    v_item jsonb;
    v_items jsonb := '[]'::jsonb;
    v_item_ids uuid[] := ARRAY[]::uuid[];
    v_item_id uuid;
    v_product_id uuid;
    v_quantity numeric;
    v_revision integer;
    v_product private.product%ROWTYPE;
    v_hash text;
    v_replayed boolean;
    v_applied integer;
    v_current integer;
    v_position integer := 0;
BEGIN
    IF p_template_id IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1
       OR p_idempotency_key IS NULL OR p_payload IS NULL
       OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload - ARRAY['name','items'] <> '{}'::jsonb
       OR NOT (p_payload ?& ARRAY['name','items'])
       OR pg_catalog.jsonb_typeof(p_payload->'name') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload->'items') <> 'array' THEN
        RAISE EXCEPTION 'Invalid template payload' USING ERRCODE = '22023';
    END IF;
    v_name := pg_catalog.btrim(p_payload->>'name');
    IF pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 160 OR pg_catalog.jsonb_array_length(p_payload->'items') < 1 THEN
        RAISE EXCEPTION 'Template requires a name and ingredients' USING ERRCODE = '22023';
    END IF;
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_payload->'items') LOOP
        IF pg_catalog.jsonb_typeof(v_item) <> 'object'
           OR v_item - ARRAY['item_id','product_id','expected_product_revision','quantity'] <> '{}'::jsonb
           OR NOT (v_item ?& ARRAY['item_id','product_id','expected_product_revision','quantity'])
           OR pg_catalog.jsonb_typeof(v_item->'item_id') <> 'string'
           OR pg_catalog.jsonb_typeof(v_item->'product_id') <> 'string'
           OR v_item->>'item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR v_item->>'product_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR pg_catalog.jsonb_typeof(v_item->'quantity') <> 'string'
           OR pg_catalog.jsonb_typeof(v_item->'expected_product_revision') <> 'number'
           OR v_item->>'expected_product_revision' !~ '^[1-9][0-9]{0,9}$' THEN
            RAISE EXCEPTION 'Invalid template ingredient' USING ERRCODE = '22023';
        END IF;
        IF (v_item->>'expected_product_revision')::numeric > 2147483647 THEN
            RAISE EXCEPTION 'Invalid product revision' USING ERRCODE = '22023';
        END IF;
        v_item_id := (v_item->>'item_id')::uuid;
        v_product_id := (v_item->>'product_id')::uuid;
        v_quantity := private.assert_decimal_10_2(v_item->>'quantity', false);
        v_revision := (v_item->>'expected_product_revision')::integer;
        IF v_item_id = ANY(v_item_ids) THEN
            RAISE EXCEPTION 'Duplicate ingredient id' USING ERRCODE = '22023';
        END IF;
        v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
        v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
            'item_id', v_item_id::text, 'product_id', v_product_id::text,
            'expected_product_revision', v_revision, 'quantity', v_quantity::text
        ));
    END LOOP;
    SELECT a.id INTO v_owner_id FROM private.app_user a
    WHERE a.singleton = 1 AND a.auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped' USING ERRCODE = '42501';
    END IF;
    -- Lock the parent before touching its children or ingredient products.
    SELECT revision, archived_at INTO v_current, v_archived_at
    FROM private.meal_template WHERE owner_id = v_owner_id AND id = v_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object('expected_revision', p_expected_revision,
            'name', v_name, 'items', v_items)::text, 'UTF8'
    )), 'hex');
    SELECT r.replayed, r.applied_revision INTO v_replayed, v_applied
    FROM private.begin_mutation(v_owner_id, p_idempotency_key, 'updateTemplate', v_id, v_hash) r;
    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object('resource_id', v_id::text, 'applied_revision', v_applied,
            'current_revision', v_current, 'replayed', true, 'deleted', false);
    END IF;
    IF v_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'TEMPLATE_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
    IF v_current <> p_expected_revision THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF v_current = 2147483647 THEN
        RAISE EXCEPTION 'TEMPLATE_REVISION_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;
    -- Stable lock order prevents deadlocks; SHARE conflicts with product edits/archive.
    PERFORM p.id FROM private.product p WHERE p.owner_id = v_owner_id
        AND p.id IN (SELECT (value->>'product_id')::uuid FROM pg_catalog.jsonb_array_elements(v_items))
        ORDER BY p.id FOR SHARE;
    DELETE FROM private.meal_template_item WHERE owner_id = v_owner_id AND meal_template_id = v_id;
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_items) LOOP
        SELECT * INTO v_product FROM private.product
        WHERE owner_id = v_owner_id AND id = (v_item->>'product_id')::uuid;
        IF NOT FOUND THEN
            RAISE EXCEPTION 'Unknown ingredient product' USING ERRCODE = '22023';
        END IF;
        IF v_product.archived_at IS NOT NULL THEN
            RAISE EXCEPTION 'PRODUCT_ARCHIVED' USING ERRCODE = 'P0001';
        END IF;
        IF v_product.revision <> (v_item->>'expected_product_revision')::integer THEN
            RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
        END IF;
        INSERT INTO private.meal_template_item(id, owner_id, meal_template_id, product_id, quantity, position)
        VALUES((v_item->>'item_id')::uuid, v_owner_id, v_id, v_product.id,
            (v_item->>'quantity')::numeric, v_position);
        v_position := v_position + 1;
    END LOOP;
    UPDATE private.meal_template SET name = v_name, revision = revision + 1,
        updated_at = pg_catalog.clock_timestamp() WHERE owner_id = v_owner_id AND id = v_id
        RETURNING revision INTO v_current;
    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, v_current);
    RETURN pg_catalog.jsonb_build_object('resource_id', v_id::text, 'applied_revision', v_current,
        'current_revision', v_current, 'replayed', false, 'deleted', false);
END;
$$;

CREATE OR REPLACE FUNCTION api.archive_template(
    p_template_id uuid,
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
    IF p_template_id IS NULL OR p_idempotency_key IS NULL
       OR p_expected_revision IS NULL OR p_expected_revision < 1 THEN
        RAISE EXCEPTION 'Invalid template archive request'
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

    SELECT template.revision, template.archived_at
      INTO v_current_revision, v_archived_at
      FROM private.meal_template AS template
     WHERE template.owner_id = v_owner_id
       AND template.id = p_template_id
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
          v_owner_id, p_idempotency_key, 'archiveTemplate', p_template_id, v_request_hash
      ) AS receipt;

    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object(
            'resource_id', p_template_id::text,
            'applied_revision', v_applied_revision,
            'current_revision', v_current_revision,
            'replayed', true,
            'deleted', false
        );
    END IF;
    IF v_archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'TEMPLATE_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision <> p_expected_revision THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;
    IF v_current_revision = 2147483647 THEN
        RAISE EXCEPTION 'TEMPLATE_REVISION_EXHAUSTED' USING ERRCODE = 'P0001';
    END IF;

    UPDATE private.meal_template AS template
       SET archived_at = pg_catalog.clock_timestamp(),
           revision = template.revision + 1,
           updated_at = pg_catalog.clock_timestamp()
     WHERE template.owner_id = v_owner_id
       AND template.id = p_template_id
       AND template.revision = p_expected_revision
       AND template.archived_at IS NULL
    RETURNING template.revision INTO v_next_revision;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001';
    END IF;

    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, v_next_revision);
    RETURN pg_catalog.jsonb_build_object(
        'resource_id', p_template_id::text,
        'applied_revision', v_next_revision,
        'current_revision', v_next_revision,
        'replayed', false,
        'deleted', false
    );
END;
$$;

-- Internal command guard for create_meal. Call after locking its parent and before
-- reading products; include every selected product in p_product_ids so the union
-- of source and selected products is locked once in UUID order.
CREATE OR REPLACE FUNCTION private.lock_template_source(p_source jsonb, p_product_ids uuid[] DEFAULT ARRAY[]::uuid[])
RETURNS void LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_template private.meal_template%ROWTYPE;
BEGIN
    IF p_source IS NULL OR pg_catalog.jsonb_typeof(p_source) <> 'object'
       OR p_source - ARRAY['id','revision'] <> '{}'::jsonb
       OR NOT (p_source ?& ARRAY['id','revision'])
       OR pg_catalog.jsonb_typeof(p_source->'id') <> 'string'
       OR p_source->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(p_source->'revision') <> 'number'
       OR p_source->>'revision' !~ '^[1-9][0-9]{0,9}$' THEN
        RAISE EXCEPTION 'Invalid source template' USING ERRCODE = '22023';
    END IF;
    IF (p_source->>'revision')::numeric > 2147483647 THEN
        RAISE EXCEPTION 'Invalid source revision' USING ERRCODE = '22023';
    END IF;
    SELECT id INTO v_owner_id FROM private.app_user
    WHERE singleton = 1 AND auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped' USING ERRCODE = '42501';
    END IF;
    SELECT * INTO v_template FROM private.meal_template
    WHERE owner_id = v_owner_id AND id = (p_source->>'id')::uuid FOR SHARE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TEMPLATE_CHANGED' USING ERRCODE = 'P0001';
    END IF;
    IF v_template.archived_at IS NOT NULL THEN
        RAISE EXCEPTION 'TEMPLATE_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
    IF v_template.revision <> (p_source->>'revision')::integer THEN
        RAISE EXCEPTION 'TEMPLATE_CHANGED' USING ERRCODE = 'P0001';
    END IF;
    PERFORM p.id FROM private.product p WHERE p.owner_id = v_owner_id AND (
        p.id = ANY(p_product_ids) OR p.id IN (
            SELECT i.product_id FROM private.meal_template_item i
            WHERE i.owner_id = v_owner_id AND i.meal_template_id = v_template.id
        )
    ) ORDER BY p.id FOR SHARE;
    IF EXISTS (
        SELECT 1 FROM private.meal_template_item i JOIN private.product p
        ON p.owner_id = i.owner_id AND p.id = i.product_id
        WHERE i.owner_id = v_owner_id AND i.meal_template_id = v_template.id AND p.archived_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'PRODUCT_ARCHIVED' USING ERRCODE = 'P0001';
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION api.update_template(uuid, jsonb, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.archive_template(uuid, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.lock_template_source(jsonb, uuid[]) FROM PUBLIC, anon, authenticated;
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

    ALTER FUNCTION api.update_template(uuid, jsonb, integer, uuid) OWNER TO app_executor;
    ALTER FUNCTION api.archive_template(uuid, integer, uuid) OWNER TO app_executor;
    ALTER FUNCTION private.lock_template_source(jsonb, uuid[]) OWNER TO app_executor;
    GRANT EXECUTE ON FUNCTION private.lock_template_source(jsonb, uuid[]) TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.update_template(uuid, jsonb, integer, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.archive_template(uuid, integer, uuid) TO authenticated;

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

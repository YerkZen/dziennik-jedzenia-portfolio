CREATE OR REPLACE FUNCTION private.ensure_meal_has_items()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_meal_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'diary_meal' THEN
        v_meal_id := NEW.id;
    ELSE
        v_meal_id := OLD.diary_meal_id;
    END IF;
    IF EXISTS (SELECT 1 FROM private.diary_meal WHERE id = v_meal_id)
       AND NOT EXISTS (SELECT 1 FROM private.diary_item WHERE diary_meal_id = v_meal_id) THEN
        RAISE EXCEPTION 'Meal requires at least one ingredient' USING ERRCODE = '22023';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER diary_has_items
AFTER INSERT OR UPDATE ON private.diary_meal DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION private.ensure_meal_has_items();
CREATE CONSTRAINT TRIGGER diary_keeps_items
AFTER DELETE OR UPDATE ON private.diary_item DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION private.ensure_meal_has_items();

CREATE OR REPLACE FUNCTION api.create_meal(p_payload jsonb, p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_id uuid;
    v_name text;
    v_date date;
    v_category text;
    v_source jsonb;
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
    IF p_idempotency_key IS NULL OR p_payload IS NULL
       OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload - ARRAY['id','name','entry_date','category','source_template','items'] <> '{}'::jsonb
       OR NOT (p_payload ?& ARRAY['id','name','entry_date','category','items'])
       OR pg_catalog.jsonb_typeof(p_payload->'id') <> 'string'
       OR p_payload->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(p_payload->'name') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload->'items') <> 'array'
       OR pg_catalog.jsonb_typeof(p_payload->'entry_date') <> 'string'
       OR p_payload->>'entry_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR pg_catalog.jsonb_typeof(p_payload->'category') <> 'string'
       OR p_payload->>'category' NOT IN ('breakfast','lunch','dinner','snack') THEN
        RAISE EXCEPTION 'Invalid meal payload' USING ERRCODE = '22023';
    END IF;
    v_id := (p_payload->>'id')::uuid;
    v_name := pg_catalog.btrim(p_payload->>'name');
    BEGIN
        v_date := private.assert_read_date((p_payload->>'entry_date')::date);
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Invalid meal date' USING ERRCODE = '22023';
    END;
    v_category := p_payload->>'category';
    IF p_payload ? 'source_template' THEN
        v_source := p_payload->'source_template';
        IF pg_catalog.jsonb_typeof(v_source) <> 'object'
           OR v_source - ARRAY['id','revision'] <> '{}'::jsonb
           OR NOT(v_source ?& ARRAY['id','revision'])
           OR pg_catalog.jsonb_typeof(v_source->'id') <> 'string'
           OR v_source->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR pg_catalog.jsonb_typeof(v_source->'revision') <> 'number'
           OR v_source->>'revision' !~ '^[1-9][0-9]{0,9}$' THEN
            RAISE EXCEPTION 'Invalid source meal' USING ERRCODE = '22023';
        END IF;
        IF (v_source->>'revision')::numeric > 2147483647 THEN
            RAISE EXCEPTION 'Invalid source revision' USING ERRCODE = '22023';
        END IF;
        v_source := pg_catalog.jsonb_build_object('id', ((v_source->>'id')::uuid)::text,
            'revision', (v_source->>'revision')::integer);
    END IF;
    IF pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 160 OR pg_catalog.jsonb_array_length(p_payload->'items') < 1 THEN
        RAISE EXCEPTION 'Meal requires a name and ingredients' USING ERRCODE = '22023';
    END IF;
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_payload->'items') LOOP
        IF pg_catalog.jsonb_typeof(v_item) <> 'object'
           OR v_item - ARRAY['kind','item_id','product_id','expected_product_revision','quantity'] <> '{}'::jsonb
           OR NOT (v_item ?& ARRAY['kind','item_id','product_id','expected_product_revision','quantity'])
           OR v_item->>'kind' <> 'new'
           OR pg_catalog.jsonb_typeof(v_item->'item_id') <> 'string'
           OR pg_catalog.jsonb_typeof(v_item->'product_id') <> 'string'
           OR v_item->>'item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR v_item->>'product_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR pg_catalog.jsonb_typeof(v_item->'quantity') <> 'string'
           OR pg_catalog.jsonb_typeof(v_item->'expected_product_revision') <> 'number'
           OR v_item->>'expected_product_revision' !~ '^[1-9][0-9]{0,9}$' THEN
            RAISE EXCEPTION 'Invalid meal ingredient' USING ERRCODE = '22023';
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
            'kind', 'new', 'item_id', v_item_id::text, 'product_id', v_product_id::text,
            'expected_product_revision', v_revision, 'quantity', v_quantity::text
        ));
    END LOOP;
    SELECT a.id INTO v_owner_id FROM private.app_user a
    WHERE a.singleton = 1 AND a.auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped' USING ERRCODE = '42501';
    END IF;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object('id', v_id::text, 'name', v_name, 'entry_date', v_date::text, 'category', v_category, 'source_template', v_source, 'items', v_items)::text, 'UTF8'
    )), 'hex');
    SELECT r.replayed, r.applied_revision INTO v_replayed, v_applied
    FROM private.begin_mutation(v_owner_id, p_idempotency_key, 'createMeal', v_id, v_hash) r;
    IF v_replayed THEN
        SELECT revision INTO v_current FROM private.diary_meal WHERE owner_id = v_owner_id AND id = v_id;
        IF v_current IS NULL THEN
            RAISE EXCEPTION 'Created meal no longer exists' USING ERRCODE = '55000';
        END IF;
        RETURN pg_catalog.jsonb_build_object('resource_id', v_id::text, 'applied_revision', v_applied,
            'current_revision', v_current, 'replayed', true, 'deleted', false);
    END IF;
    INSERT INTO private.diary_meal(id, owner_id, name, entry_date, category)
    VALUES(v_id, v_owner_id, v_name, v_date, v_category);
    IF v_source IS NOT NULL THEN
        PERFORM private.lock_template_source(v_source, ARRAY(
            SELECT (value->>'product_id')::uuid FROM pg_catalog.jsonb_array_elements(v_items)
        ));
    END IF;
    -- Stable lock order prevents deadlocks; SHARE conflicts with product edits/archive.
    PERFORM p.id FROM private.product p WHERE p.owner_id = v_owner_id
        AND p.id IN (SELECT (value->>'product_id')::uuid FROM pg_catalog.jsonb_array_elements(v_items))
        ORDER BY p.id FOR SHARE;
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
        INSERT INTO private.diary_item(id, owner_id, diary_meal_id, product_id, source_product_revision,
            product_name, basis_unit, kcal_per_100, protein_per_100, fat_per_100, carbs_per_100, quantity, position)
        VALUES((v_item->>'item_id')::uuid, v_owner_id, v_id, v_product.id, v_product.revision,
            v_product.name, v_product.basis_unit, v_product.kcal_per_100, v_product.protein_per_100,
            v_product.fat_per_100, v_product.carbs_per_100, (v_item->>'quantity')::numeric, v_position);
        v_position := v_position + 1;
    END LOOP;
    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, 1);
    RETURN pg_catalog.jsonb_build_object('resource_id', v_id::text, 'applied_revision', 1,
        'current_revision', 1, 'replayed', false, 'deleted', false);
END;
$$;

CREATE OR REPLACE FUNCTION private.meal_document(p_meal_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT entry.value FROM private.diary_meal m
    JOIN private.app_user a ON a.id = m.owner_id
    CROSS JOIN LATERAL pg_catalog.jsonb_array_elements(api.get_day(m.entry_date)->'meals') entry(value)
    WHERE m.id = p_meal_id AND m.deleted_at IS NULL AND a.singleton = 1
      AND a.auth_subject = (SELECT auth.uid()) AND entry.value->>'id' = m.id::text
$$;
CREATE OR REPLACE FUNCTION api.get_meal(p_meal_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.meal_document(p_meal_id)
$$;

REVOKE ALL ON FUNCTION api.create_meal(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.get_meal(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.meal_document(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ensure_meal_has_items() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.meal_document(uuid) TO app_executor;
GRANT EXECUTE ON FUNCTION private.ensure_meal_has_items() TO app_executor;
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

    ALTER FUNCTION api.create_meal(jsonb, uuid) OWNER TO app_executor;
    ALTER FUNCTION api.get_meal(uuid) OWNER TO app_executor;
    ALTER FUNCTION private.meal_document(uuid) OWNER TO app_executor;
    ALTER FUNCTION private.ensure_meal_has_items() OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.create_meal(jsonb, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.get_meal(uuid) TO authenticated;

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

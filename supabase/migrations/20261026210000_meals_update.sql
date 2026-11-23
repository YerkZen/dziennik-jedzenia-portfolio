CREATE OR REPLACE FUNCTION private.guard_diary_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
    IF (pg_catalog.to_jsonb(NEW) - ARRAY['quantity','position']) IS DISTINCT FROM
       (pg_catalog.to_jsonb(OLD) - ARRAY['quantity','position']) THEN
        RAISE EXCEPTION 'Diary snapshot identity and values are immutable' USING ERRCODE = '22023';
    END IF;
    RETURN NEW;
END;
$$;
CREATE TRIGGER diary_snapshot_immutable BEFORE UPDATE ON private.diary_item
FOR EACH ROW EXECUTE FUNCTION private.guard_diary_snapshot();

CREATE OR REPLACE FUNCTION api.update_meal(p_meal_id uuid, p_payload jsonb, p_expected_revision integer, p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_parent private.diary_meal%ROWTYPE;
    v_existing private.diary_item%ROWTYPE;
    v_product private.product%ROWTYPE;
    v_name text;
    v_date date;
    v_item jsonb;
    v_items jsonb := '[]'::jsonb;
    v_rows jsonb := '[]'::jsonb;
    v_item_ids uuid[] := ARRAY[]::uuid[];
    v_item_id uuid;
    v_kind text;
    v_quantity numeric;
    v_position integer := 0;
    v_hash text;
    v_replayed boolean;
    v_applied integer;
BEGIN
    IF p_meal_id IS NULL OR p_idempotency_key IS NULL OR p_expected_revision IS NULL OR p_expected_revision < 1
       OR p_payload IS NULL OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload - ARRAY['name','entry_date','category','items'] <> '{}'::jsonb
       OR NOT(p_payload ?& ARRAY['name','entry_date','category','items'])
       OR pg_catalog.jsonb_typeof(p_payload->'name') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload->'entry_date') <> 'string'
       OR p_payload->>'entry_date' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
       OR pg_catalog.jsonb_typeof(p_payload->'category') <> 'string'
       OR p_payload->>'category' NOT IN ('breakfast','lunch','dinner','snack')
       OR pg_catalog.jsonb_typeof(p_payload->'items') <> 'array' THEN
        RAISE EXCEPTION 'Invalid meal update' USING ERRCODE = '22023';
    END IF;
    v_name := pg_catalog.btrim(p_payload->>'name');
    IF pg_catalog.char_length(v_name) NOT BETWEEN 1 AND 160 OR pg_catalog.jsonb_array_length(p_payload->'items') < 1 THEN
        RAISE EXCEPTION 'Meal requires a name and ingredients' USING ERRCODE = '22023';
    END IF;
    BEGIN
        v_date := private.assert_read_date((p_payload->>'entry_date')::date);
    EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN
        RAISE EXCEPTION 'Invalid meal date' USING ERRCODE = '22023';
    END;
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(p_payload->'items') LOOP
        IF pg_catalog.jsonb_typeof(v_item) <> 'object'
           OR NOT(v_item ?& ARRAY['kind','item_id','quantity'])
           OR pg_catalog.jsonb_typeof(v_item->'kind') <> 'string'
           OR v_item->>'kind' NOT IN ('existing','new')
           OR pg_catalog.jsonb_typeof(v_item->'item_id') <> 'string'
           OR v_item->>'item_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
           OR pg_catalog.jsonb_typeof(v_item->'quantity') <> 'string' THEN
            RAISE EXCEPTION 'Invalid meal ingredient' USING ERRCODE = '22023';
        END IF;
        v_kind := v_item->>'kind'; v_item_id := (v_item->>'item_id')::uuid;
        v_quantity := private.assert_decimal_10_2(v_item->>'quantity', false);
        IF v_item_id = ANY(v_item_ids) THEN
            RAISE EXCEPTION 'Duplicate ingredient id' USING ERRCODE = '22023';
        END IF;
        v_item_ids := pg_catalog.array_append(v_item_ids, v_item_id);
        IF v_kind = 'existing' THEN
            IF v_item - ARRAY['kind','item_id','quantity'] <> '{}'::jsonb THEN
                RAISE EXCEPTION 'Existing items accept only quantity' USING ERRCODE = '22023';
            END IF;
            v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'kind', v_kind, 'item_id', v_item_id::text, 'quantity', pg_catalog.trim_scale(v_quantity)::text));
        ELSE
            IF v_item - ARRAY['kind','item_id','quantity','product_id','expected_product_revision'] <> '{}'::jsonb
               OR NOT(v_item ?& ARRAY['product_id','expected_product_revision'])
               OR pg_catalog.jsonb_typeof(v_item->'product_id') <> 'string'
               OR v_item->>'product_id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
               OR pg_catalog.jsonb_typeof(v_item->'expected_product_revision') <> 'number'
               OR v_item->>'expected_product_revision' !~ '^[1-9][0-9]{0,9}$' THEN
                RAISE EXCEPTION 'Invalid new ingredient' USING ERRCODE = '22023';
            END IF;
            IF (v_item->>'expected_product_revision')::numeric > 2147483647 THEN
                RAISE EXCEPTION 'Invalid product revision' USING ERRCODE = '22023';
            END IF;
            v_items := v_items || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'kind', v_kind, 'item_id', v_item_id::text, 'quantity', pg_catalog.trim_scale(v_quantity)::text,
                'product_id', ((v_item->>'product_id')::uuid)::text,
                'expected_product_revision', (v_item->>'expected_product_revision')::integer));
        END IF;
    END LOOP;
    SELECT id INTO v_owner_id FROM private.app_user WHERE singleton = 1 AND auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN RAISE EXCEPTION 'Authenticated owner is not mapped' USING ERRCODE = '42501'; END IF;
    SELECT * INTO v_parent FROM private.diary_meal WHERE owner_id = v_owner_id AND id = p_meal_id FOR UPDATE;
    IF NOT FOUND THEN RETURN NULL; END IF;
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(pg_catalog.jsonb_build_object(
        'expected_revision', p_expected_revision, 'name', v_name, 'entry_date', v_date::text,
        'category', p_payload->>'category', 'items', v_items)::text, 'UTF8')), 'hex');
    SELECT r.replayed, r.applied_revision INTO v_replayed, v_applied
    FROM private.begin_mutation(v_owner_id, p_idempotency_key, 'updateMeal', p_meal_id, v_hash) r;
    IF v_replayed THEN
        RETURN pg_catalog.jsonb_build_object('resource_id', p_meal_id::text, 'applied_revision', v_applied,
            'current_revision', v_parent.revision, 'replayed', true, 'deleted', v_parent.deleted_at IS NOT NULL);
    END IF;
    IF v_parent.deleted_at IS NOT NULL THEN RAISE EXCEPTION 'RESOURCE_DELETED' USING ERRCODE = 'P0001'; END IF;
    IF v_parent.revision <> p_expected_revision THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001'; END IF;
    IF v_parent.revision = 2147483647 THEN RAISE EXCEPTION 'MEAL_REVISION_EXHAUSTED' USING ERRCODE = 'P0001'; END IF;
    PERFORM p.id FROM private.product p WHERE p.owner_id = v_owner_id AND p.id IN (
        SELECT (value->>'product_id')::uuid FROM pg_catalog.jsonb_array_elements(v_items) WHERE value->>'kind' = 'new'
    ) ORDER BY p.id FOR SHARE;
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_items) LOOP
        v_item_id := (v_item->>'item_id')::uuid;
        IF v_item->>'kind' = 'existing' THEN
            SELECT * INTO v_existing FROM private.diary_item
            WHERE owner_id = v_owner_id AND diary_meal_id = p_meal_id AND id = v_item_id FOR UPDATE;
            IF NOT FOUND THEN RAISE EXCEPTION 'Item does not belong to this meal' USING ERRCODE = '22023'; END IF;
            v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.to_jsonb(v_existing) ||
                pg_catalog.jsonb_build_object('quantity', v_item->>'quantity', 'position', v_position));
        ELSE
            IF EXISTS(SELECT 1 FROM private.diary_item WHERE id = v_item_id) THEN
                RAISE EXCEPTION 'New items require new UUIDs' USING ERRCODE = '22023';
            END IF;
            SELECT * INTO v_product FROM private.product WHERE owner_id = v_owner_id AND id = (v_item->>'product_id')::uuid;
            IF NOT FOUND THEN RAISE EXCEPTION 'Unknown ingredient product' USING ERRCODE = '22023'; END IF;
            IF v_product.archived_at IS NOT NULL THEN RAISE EXCEPTION 'PRODUCT_ARCHIVED' USING ERRCODE = 'P0001'; END IF;
            IF v_product.revision <> (v_item->>'expected_product_revision')::integer THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE = 'P0001'; END IF;
            v_rows := v_rows || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
                'id', v_item_id, 'owner_id', v_owner_id, 'diary_meal_id', p_meal_id,
                'product_id', v_product.id, 'source_product_revision', v_product.revision,
                'product_name', v_product.name, 'basis_unit', v_product.basis_unit,
                'kcal_per_100', v_product.kcal_per_100, 'protein_per_100', v_product.protein_per_100,
                'fat_per_100', v_product.fat_per_100, 'carbs_per_100', v_product.carbs_per_100,
                'quantity', v_item->>'quantity', 'position', v_position));
        END IF;
        v_position := v_position + 1;
    END LOOP;
    -- Reinsert validated snapshots atomically; swapped positions cannot violate immediate uniqueness.
    DELETE FROM private.diary_item WHERE owner_id = v_owner_id AND diary_meal_id = p_meal_id;
    FOR v_item IN SELECT value FROM pg_catalog.jsonb_array_elements(v_rows) LOOP
        INSERT INTO private.diary_item
        SELECT * FROM pg_catalog.jsonb_populate_record(NULL::private.diary_item, v_item);
    END LOOP;
    UPDATE private.diary_meal SET name = v_name, entry_date = v_date, category = p_payload->>'category',
        revision = revision + 1, updated_at = pg_catalog.clock_timestamp()
    WHERE owner_id = v_owner_id AND id = p_meal_id;
    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, v_parent.revision + 1);
    RETURN pg_catalog.jsonb_build_object('resource_id', p_meal_id::text, 'applied_revision', v_parent.revision + 1,
        'current_revision', v_parent.revision + 1, 'replayed', false, 'deleted', false);
END;
$$;

REVOKE ALL ON FUNCTION api.update_meal(uuid, jsonb, integer, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_diary_snapshot() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.guard_diary_snapshot() TO app_executor;
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

    ALTER FUNCTION api.update_meal(uuid, jsonb, integer, uuid) OWNER TO app_executor;
    ALTER FUNCTION private.guard_diary_snapshot() OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.update_meal(uuid, jsonb, integer, uuid) TO authenticated;

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

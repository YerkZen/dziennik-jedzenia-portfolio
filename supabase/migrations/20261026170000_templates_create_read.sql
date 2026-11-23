CREATE OR REPLACE FUNCTION private.template_document(p_template_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SET search_path = '' AS $$
    SELECT pg_catalog.jsonb_build_object(
        'id', t.id::text, 'name', t.name, 'revision', t.revision,
        'archived_at', t.archived_at, 'created_at', t.created_at, 'updated_at', t.updated_at,
        'items', COALESCE((
            SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
                'item_id', i.id::text, 'product', api.get_product(i.product_id),
                'quantity', i.quantity::text, 'position', i.position
            ) ORDER BY i.position)
            FROM private.meal_template_item i
            WHERE i.owner_id = t.owner_id AND i.meal_template_id = t.id
        ), '[]'::jsonb)
    )
    FROM private.meal_template t
    JOIN private.app_user a ON a.id = t.owner_id
    WHERE t.id = p_template_id AND a.singleton = 1 AND a.auth_subject = (SELECT auth.uid())
$$;

CREATE OR REPLACE FUNCTION private.ensure_template_has_items()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE
    v_template_id uuid;
BEGIN
    IF TG_TABLE_NAME = 'meal_template' THEN
        v_template_id := NEW.id;
    ELSE
        v_template_id := OLD.meal_template_id;
    END IF;
    IF EXISTS (SELECT 1 FROM private.meal_template WHERE id = v_template_id)
       AND NOT EXISTS (SELECT 1 FROM private.meal_template_item WHERE meal_template_id = v_template_id) THEN
        RAISE EXCEPTION 'Template requires at least one ingredient' USING ERRCODE = '22023';
    END IF;
    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER template_has_items
AFTER INSERT OR UPDATE ON private.meal_template DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION private.ensure_template_has_items();
CREATE CONSTRAINT TRIGGER template_keeps_items
AFTER DELETE OR UPDATE ON private.meal_template_item DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION private.ensure_template_has_items();

CREATE OR REPLACE FUNCTION api.create_template(p_payload jsonb, p_idempotency_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_id uuid;
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
    IF p_idempotency_key IS NULL OR p_payload IS NULL
       OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload - ARRAY['id','name','items'] <> '{}'::jsonb
       OR NOT (p_payload ?& ARRAY['id','name','items'])
       OR pg_catalog.jsonb_typeof(p_payload->'id') <> 'string'
       OR p_payload->>'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(p_payload->'name') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload->'items') <> 'array' THEN
        RAISE EXCEPTION 'Invalid template payload' USING ERRCODE = '22023';
    END IF;
    v_id := (p_payload->>'id')::uuid;
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
    v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
        pg_catalog.jsonb_build_object('id', v_id::text, 'name', v_name, 'items', v_items)::text, 'UTF8'
    )), 'hex');
    SELECT r.replayed, r.applied_revision INTO v_replayed, v_applied
    FROM private.begin_mutation(v_owner_id, p_idempotency_key, 'createTemplate', v_id, v_hash) r;
    IF v_replayed THEN
        SELECT revision INTO v_current FROM private.meal_template WHERE owner_id = v_owner_id AND id = v_id;
        IF v_current IS NULL THEN
            RAISE EXCEPTION 'Created template no longer exists' USING ERRCODE = '55000';
        END IF;
        RETURN pg_catalog.jsonb_build_object('resource_id', v_id::text, 'applied_revision', v_applied,
            'current_revision', v_current, 'replayed', true, 'deleted', false);
    END IF;
    INSERT INTO private.meal_template(id, owner_id, name) VALUES(v_id, v_owner_id, v_name);
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
        INSERT INTO private.meal_template_item(id, owner_id, meal_template_id, product_id, quantity, position)
        VALUES((v_item->>'item_id')::uuid, v_owner_id, v_id, v_product.id,
            (v_item->>'quantity')::numeric, v_position);
        v_position := v_position + 1;
    END LOOP;
    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, 1);
    RETURN pg_catalog.jsonb_build_object('resource_id', v_id::text, 'applied_revision', 1,
        'current_revision', 1, 'replayed', false, 'deleted', false);
END;
$$;

CREATE OR REPLACE FUNCTION api.get_template(p_template_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY DEFINER SET search_path = '' AS $$
    SELECT private.template_document(p_template_id)
$$;

CREATE OR REPLACE FUNCTION api.list_templates(p_q text DEFAULT '', p_include_archived boolean DEFAULT false,
    p_limit integer DEFAULT 50, p_offset integer DEFAULT 0)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner_id uuid;
    v_query text;
    v_result jsonb;
BEGIN
    IF p_q IS NULL OR pg_catalog.char_length(p_q) > 160 OR p_include_archived IS NULL
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100 OR p_offset IS NULL OR p_offset < 0 THEN
        RAISE EXCEPTION 'Invalid template query' USING ERRCODE = '22023';
    END IF;
    SELECT a.id INTO v_owner_id FROM private.app_user a
    WHERE a.singleton = 1 AND a.auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped' USING ERRCODE = '42501';
    END IF;
    v_query := pg_catalog.replace(pg_catalog.replace(pg_catalog.replace(p_q,
        pg_catalog.chr(92), pg_catalog.chr(92)||pg_catalog.chr(92)), '%', pg_catalog.chr(92)||'%'), '_', pg_catalog.chr(92)||'_');
    SELECT pg_catalog.jsonb_build_object('items', COALESCE(
        pg_catalog.jsonb_agg(private.template_document(page.id) ORDER BY page.name, page.id)
            FILTER (WHERE page.n <= p_limit), '[]'::jsonb),
        'limit', p_limit, 'offset', p_offset, 'has_more', pg_catalog.count(*) > p_limit)
    INTO v_result FROM (
        SELECT t.id, pg_catalog.lower(t.name) AS name,
            pg_catalog.row_number() OVER (ORDER BY pg_catalog.lower(t.name), t.id) - p_offset AS n
        FROM private.meal_template t WHERE t.owner_id = v_owner_id
            AND (p_include_archived OR t.archived_at IS NULL)
            AND t.name ILIKE ('%'||v_query||'%') ESCAPE E'\\'
        ORDER BY pg_catalog.lower(t.name), t.id OFFSET p_offset LIMIT p_limit + 1
    ) page;
    RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION api.create_template(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.list_templates(text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.get_template(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.template_document(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ensure_template_has_items() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.template_document(uuid) TO app_executor;
GRANT EXECUTE ON FUNCTION private.ensure_template_has_items() TO app_executor;
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

    ALTER FUNCTION api.create_template(jsonb, uuid) OWNER TO app_executor;
    ALTER FUNCTION api.list_templates(text, boolean, integer, integer) OWNER TO app_executor;
    ALTER FUNCTION api.get_template(uuid) OWNER TO app_executor;
    ALTER FUNCTION private.template_document(uuid) OWNER TO app_executor;
    ALTER FUNCTION private.ensure_template_has_items() OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.create_template(jsonb, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.list_templates(text, boolean, integer, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.get_template(uuid) TO authenticated;

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

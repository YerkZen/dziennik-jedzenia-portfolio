CREATE OR REPLACE FUNCTION api.create_product(p_payload jsonb, p_idempotency_key uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner_id uuid;
    product_id uuid;
    product_name text;
    basis_unit text;
    kcal_per_100 numeric;
    protein_per_100 numeric;
    fat_per_100 numeric;
    carbs_per_100 numeric;
    canonical_payload jsonb;
    request_hash text;
    replayed boolean;
    applied_revision integer;
    current_revision integer;
BEGIN
    IF p_idempotency_key IS NULL
       OR p_payload IS NULL
       OR pg_catalog.jsonb_typeof(p_payload) <> 'object'
       OR p_payload - ARRAY[
           'id', 'name', 'basis_unit', 'kcal_per_100', 'protein_per_100', 'fat_per_100', 'carbs_per_100'
       ] <> '{}'::jsonb
       OR NOT (p_payload ?& ARRAY[
           'id', 'name', 'basis_unit', 'kcal_per_100', 'protein_per_100', 'fat_per_100', 'carbs_per_100'
       ]) THEN
        RAISE EXCEPTION 'Invalid product request'
            USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.jsonb_typeof(p_payload -> 'id') <> 'string'
       OR p_payload ->> 'id' !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       OR pg_catalog.jsonb_typeof(p_payload -> 'name') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'basis_unit') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'kcal_per_100') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'protein_per_100') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'fat_per_100') <> 'string'
       OR pg_catalog.jsonb_typeof(p_payload -> 'carbs_per_100') <> 'string' THEN
        RAISE EXCEPTION 'Invalid product field type'
            USING ERRCODE = '22023';
    END IF;

    product_id := (p_payload ->> 'id')::uuid;
    product_name := pg_catalog.btrim(p_payload ->> 'name');
    basis_unit := p_payload ->> 'basis_unit';
    IF pg_catalog.char_length(product_name) NOT BETWEEN 1 AND 160
       OR basis_unit NOT IN ('g', 'ml') THEN
        RAISE EXCEPTION 'Invalid product name or basis unit'
            USING ERRCODE = '22023';
    END IF;

    kcal_per_100 := private.assert_decimal_10_2(p_payload ->> 'kcal_per_100', true);
    protein_per_100 := private.assert_decimal_10_2(p_payload ->> 'protein_per_100', true);
    fat_per_100 := private.assert_decimal_10_2(p_payload ->> 'fat_per_100', true);
    carbs_per_100 := private.assert_decimal_10_2(p_payload ->> 'carbs_per_100', true);

    SELECT account.id
      INTO v_owner_id
      FROM private.app_user AS account
     WHERE account.singleton = 1
       AND account.auth_subject = (SELECT auth.uid());
    IF v_owner_id IS NULL THEN
        RAISE EXCEPTION 'Authenticated owner is not mapped'
            USING ERRCODE = '42501';
    END IF;

    canonical_payload := pg_catalog.jsonb_build_object(
        'id', product_id::text,
        'name', product_name,
        'basis_unit', basis_unit,
        'kcal_per_100', kcal_per_100::text,
        'protein_per_100', protein_per_100::text,
        'fat_per_100', fat_per_100::text,
        'carbs_per_100', carbs_per_100::text
    );
    request_hash := pg_catalog.encode(
        pg_catalog.sha256(pg_catalog.convert_to(canonical_payload::text, 'UTF8')),
        'hex'
    );

    SELECT receipt.replayed, receipt.applied_revision
      INTO replayed, applied_revision
      FROM private.begin_mutation(
          v_owner_id,
          p_idempotency_key,
          'createProduct',
          product_id,
          request_hash
      ) AS receipt;

    IF replayed THEN
        SELECT product.revision
          INTO current_revision
          FROM private.product AS product
         WHERE product.owner_id = v_owner_id
           AND product.id = product_id;
        IF current_revision IS NULL THEN
            RAISE EXCEPTION 'Created product no longer exists'
                USING ERRCODE = '55000';
        END IF;
        RETURN pg_catalog.jsonb_build_object(
            'resource_id', product_id::text,
            'applied_revision', applied_revision,
            'current_revision', current_revision,
            'replayed', true,
            'deleted', false
        );
    END IF;

    IF EXISTS (
        SELECT 1
          FROM private.product AS product
         WHERE product.owner_id = v_owner_id
           AND product.id = product_id
    ) THEN
        RAISE EXCEPTION 'ID_EXISTS'
            USING ERRCODE = 'P0001';
    END IF;

    INSERT INTO private.product (
        id, owner_id, name, basis_unit, kcal_per_100,
        protein_per_100, fat_per_100, carbs_per_100
    ) VALUES (
        product_id, v_owner_id, product_name, basis_unit, kcal_per_100,
        protein_per_100, fat_per_100, carbs_per_100
    );
    PERFORM private.complete_mutation(v_owner_id, p_idempotency_key, 1);

    RETURN pg_catalog.jsonb_build_object(
        'resource_id', product_id::text,
        'applied_revision', 1,
        'current_revision', 1,
        'replayed', false,
        'deleted', false
    );
END;
$$;

CREATE OR REPLACE FUNCTION api.list_products(
    p_q text DEFAULT '',
    p_include_archived boolean DEFAULT false,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_owner_id uuid;
    escaped_query text;
    result jsonb;
BEGIN
    IF p_q IS NULL OR pg_catalog.char_length(p_q) > 160
       OR p_include_archived IS NULL
       OR p_limit IS NULL OR p_limit NOT BETWEEN 1 AND 100
       OR p_offset IS NULL OR p_offset < 0 THEN
        RAISE EXCEPTION 'Invalid product list query'
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

    escaped_query := pg_catalog.replace(
        pg_catalog.replace(
            pg_catalog.replace(p_q, pg_catalog.chr(92), pg_catalog.chr(92) || pg_catalog.chr(92)),
            '%', pg_catalog.chr(92) || '%'
        ),
        '_', pg_catalog.chr(92) || '_'
    );

    SELECT pg_catalog.jsonb_build_object(
               'items', COALESCE(
                   pg_catalog.jsonb_agg(page.product_json ORDER BY page.sort_name, page.id)
                       FILTER (WHERE page.row_number <= p_limit),
                   '[]'::jsonb
               ),
               'limit', p_limit,
               'offset', p_offset,
               'has_more', pg_catalog.count(*) > p_limit
           )
      INTO result
      FROM (
          SELECT page_rows.product_json,
                 page_rows.sort_name,
                 page_rows.id,
                 pg_catalog.row_number() OVER () AS row_number
            FROM (
                SELECT pg_catalog.jsonb_build_object(
                     'id', product.id::text,
                     'name', product.name,
                     'basis_unit', product.basis_unit,
                     'kcal_per_100', product.kcal_per_100::text,
                     'protein_per_100', product.protein_per_100::text,
                     'fat_per_100', product.fat_per_100::text,
                     'carbs_per_100', product.carbs_per_100::text,
                     'revision', product.revision,
                     'archived_at', product.archived_at,
                     'created_at', product.created_at,
                     'updated_at', product.updated_at
                 ) AS product_json,
                 pg_catalog.lower(product.name) AS sort_name,
                 product.id
            FROM private.product AS product
           WHERE product.owner_id = v_owner_id
             AND (p_include_archived OR product.archived_at IS NULL)
             AND product.name ILIKE ('%' || escaped_query || '%') ESCAPE E'\\'
           ORDER BY pg_catalog.lower(product.name), product.id
           OFFSET p_offset
           LIMIT p_limit + 1
            ) AS page_rows
      ) AS page;

    RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION api.get_product(p_product_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
    SELECT pg_catalog.jsonb_build_object(
               'id', product.id::text,
               'name', product.name,
               'basis_unit', product.basis_unit,
               'kcal_per_100', product.kcal_per_100::text,
               'protein_per_100', product.protein_per_100::text,
               'fat_per_100', product.fat_per_100::text,
               'carbs_per_100', product.carbs_per_100::text,
               'revision', product.revision,
               'archived_at', product.archived_at,
               'created_at', product.created_at,
               'updated_at', product.updated_at
           )
      FROM private.product AS product
      JOIN private.app_user AS account ON account.id = product.owner_id
     WHERE account.singleton = 1
       AND account.auth_subject = (SELECT auth.uid())
       AND product.id = p_product_id
$$;

REVOKE ALL ON FUNCTION api.create_product(jsonb, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.list_products(text, boolean, integer, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.get_product(uuid) FROM PUBLIC, anon, authenticated;
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

    ALTER FUNCTION api.create_product(jsonb, uuid) OWNER TO app_executor;
    ALTER FUNCTION api.list_products(text, boolean, integer, integer) OWNER TO app_executor;
    ALTER FUNCTION api.get_product(uuid) OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.create_product(jsonb, uuid) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.list_products(text, boolean, integer, integer) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.get_product(uuid) TO authenticated;

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

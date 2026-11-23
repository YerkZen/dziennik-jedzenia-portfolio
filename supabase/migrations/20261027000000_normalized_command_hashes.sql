-- Normalize numeric values for new commands without invalidating exact replays of existing receipts.
CREATE OR REPLACE FUNCTION private.normalize_command_json(p_value jsonb)
RETURNS jsonb LANGUAGE plpgsql IMMUTABLE SET search_path = '' AS $$
DECLARE v_result jsonb; v_key text; v_child jsonb;
BEGIN
  IF pg_catalog.jsonb_typeof(p_value) = 'object' THEN
    v_result := '{}'::jsonb;
    FOR v_key, v_child IN SELECT key,value FROM pg_catalog.jsonb_each(p_value) LOOP
      IF v_key = ANY(ARRAY['kcal_per_100','protein_per_100','fat_per_100','carbs_per_100','quantity'])
         AND pg_catalog.jsonb_typeof(v_child) = 'string' THEN
        v_child := pg_catalog.to_jsonb(pg_catalog.trim_scale((v_child #>> '{}')::numeric)::text);
      ELSE v_child := private.normalize_command_json(v_child);
      END IF;
      v_result := v_result || pg_catalog.jsonb_build_object(v_key,v_child);
    END LOOP;
    RETURN v_result;
  ELSIF pg_catalog.jsonb_typeof(p_value) = 'array' THEN
    SELECT COALESCE(pg_catalog.jsonb_agg(private.normalize_command_json(value) ORDER BY ordinality),'[]'::jsonb)
    INTO v_result FROM pg_catalog.jsonb_array_elements(p_value) WITH ORDINALITY;
    RETURN v_result;
  END IF;
  RETURN p_value;
END;
$$;
CREATE OR REPLACE FUNCTION private.compatible_mutation_hash(p_owner uuid,p_key uuid,p_canonical jsonb)
RETURNS text LANGUAGE plpgsql STABLE SET search_path = '' AS $$
DECLARE v_legacy text; v_stored text;
BEGIN
  v_legacy := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_canonical::text,'UTF8')),'hex');
  SELECT request_hash INTO v_stored FROM private.mutation_receipt WHERE owner_id=p_owner AND key=p_key;
  IF v_stored = v_legacy THEN RETURN v_legacy; END IF;
  RETURN pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(private.normalize_command_json(p_canonical)::text,'UTF8')),'hex');
END;
$$;
REVOKE ALL ON FUNCTION private.normalize_command_json(jsonb),private.compatible_mutation_hash(uuid,uuid,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION private.normalize_command_json(jsonb),private.compatible_mutation_hash(uuid,uuid,jsonb) TO app_executor;

-- Preserve the currently installed validation, tombstone and permissions fixes.
DO $$
DECLARE v_function regprocedure; v_definition text; v_expression text; v_payload text; v_updated text;
BEGIN
  FOREACH v_function IN ARRAY ARRAY[
    'api.create_product(jsonb,uuid)'::regprocedure,
    'api.update_product(uuid,jsonb,integer,uuid)'::regprocedure,
    'api.create_template(jsonb,uuid)'::regprocedure,
    'api.update_template(uuid,jsonb,integer,uuid)'::regprocedure,
    'api.create_meal(jsonb,uuid)'::regprocedure
  ] LOOP
    v_definition := pg_catalog.pg_get_functiondef(v_function);
    v_expression := (pg_catalog.regexp_match(v_definition,'((?:v_request_hash|request_hash|v_hash) :=[^;]+;)'))[1];
    v_payload := (pg_catalog.regexp_match(v_expression,'(?s)convert_to\((.*)::text,\s*''UTF8'''))[1];
    IF v_expression IS NULL OR v_payload IS NULL THEN RAISE EXCEPTION 'Cannot locate command hash in %',v_function; END IF;
    v_updated := pg_catalog.replace(v_definition,v_expression,
      pg_catalog.split_part(v_expression,':=',1) || ':= private.compatible_mutation_hash(v_owner_id,p_idempotency_key,' || v_payload || ');');
    EXECUTE v_updated;
  END LOOP;
END;
$$;
NOTIFY pgrst,'reload schema';

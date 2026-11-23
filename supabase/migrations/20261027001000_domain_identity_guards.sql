CREATE OR REPLACE FUNCTION private.guard_domain_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
DECLARE v_new jsonb := pg_catalog.to_jsonb(NEW); v_old jsonb := pg_catalog.to_jsonb(OLD);
BEGIN
  IF v_new->'id' IS DISTINCT FROM v_old->'id'
     OR v_new->'owner_id' IS DISTINCT FROM v_old->'owner_id'
     OR v_new->'created_at' IS DISTINCT FROM v_old->'created_at'
     OR v_new->'meal_template_id' IS DISTINCT FROM v_old->'meal_template_id' THEN
    RAISE EXCEPTION 'Domain identity is immutable' USING ERRCODE = '22023';
  END IF;
  IF TG_TABLE_NAME = 'product' AND v_new->'basis_unit' IS DISTINCT FROM v_old->'basis_unit' THEN
    RAISE EXCEPTION 'Product basis unit is immutable' USING ERRCODE = '22023';
  END IF;
  IF v_old->>'archived_at' IS NOT NULL AND v_new->'archived_at' IS DISTINCT FROM v_old->'archived_at' THEN
    RAISE EXCEPTION 'Archive state is irreversible' USING ERRCODE = '22023';
  END IF;
  IF TG_TABLE_NAME = 'app_user' AND CURRENT_USER = 'app_executor' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'Owner mapping requires an operator' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION private.guard_domain_identity() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER app_user_identity_immutable BEFORE UPDATE ON private.app_user FOR EACH ROW EXECUTE FUNCTION private.guard_domain_identity();
CREATE TRIGGER product_identity_immutable BEFORE UPDATE ON private.product FOR EACH ROW EXECUTE FUNCTION private.guard_domain_identity();
CREATE TRIGGER template_identity_immutable BEFORE UPDATE ON private.meal_template FOR EACH ROW EXECUTE FUNCTION private.guard_domain_identity();
CREATE TRIGGER template_item_identity_immutable BEFORE UPDATE ON private.meal_template_item FOR EACH ROW EXECUTE FUNCTION private.guard_domain_identity();

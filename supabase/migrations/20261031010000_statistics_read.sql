-- D007 / TASK-049: aggregate history at read time, without materialized totals.
CREATE FUNCTION api.get_statistics(p_from date, p_to date)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = '' AS $$
DECLARE
    v_owner uuid;
    v_today date := (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date;
    v_days jsonb;
BEGIN
    SELECT id INTO v_owner FROM private.app_user
    WHERE singleton = 1 AND auth_subject = (SELECT private.request_subject());
    IF v_owner IS NULL THEN
        RAISE EXCEPTION 'Owner required' USING ERRCODE = '42501';
    END IF;
    -- Reject infinity before subtracting dates; bound series generation before running SQL.
    IF p_from IS NULL OR p_to IS NULL OR NOT pg_catalog.isfinite(p_from) OR NOT pg_catalog.isfinite(p_to) THEN
        RAISE EXCEPTION 'Invalid statistics range' USING ERRCODE = '22023';
    END IF;
    IF p_from < DATE '1900-01-01' OR p_to > v_today OR p_from > p_to OR p_to - p_from >= 366 THEN
        RAISE EXCEPTION 'Invalid statistics range' USING ERRCODE = '22023';
    END IF;

    WITH daily_meals AS (
        SELECT m.entry_date, pg_catalog.count(DISTINCT m.id)::integer AS meal_count,
            COALESCE(pg_catalog.sum(i.quantity * i.kcal_per_100 / 100), 0)::numeric AS kcal
        FROM private.diary_meal m
        LEFT JOIN private.diary_item i ON i.owner_id = m.owner_id AND i.diary_meal_id = m.id
        WHERE m.owner_id = v_owner AND m.entry_date BETWEEN p_from AND p_to AND m.deleted_at IS NULL
        GROUP BY m.entry_date
    ), calendar AS (
        -- Integer calendar arithmetic is independent of session timezone and DST.
        SELECT p_from + seq.n AS entry_date FROM pg_catalog.generate_series(0, p_to - p_from) AS seq(n)
    )
    SELECT pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
        'date', c.entry_date::text,
        'kcal', CASE WHEN m.meal_count IS NULL THEN NULL ELSE pg_catalog.trim_scale(m.kcal)::text END,
        'meal_count', COALESCE(m.meal_count,0),
        'weight_kg', CASE WHEN w.deleted_at IS NULL THEN pg_catalog.trim_scale(w.weight_kg)::text ELSE NULL END,
        'weight_revision', COALESCE(w.revision,0)
    ) ORDER BY c.entry_date) INTO v_days
    FROM calendar c
    LEFT JOIN daily_meals m ON m.entry_date = c.entry_date
    LEFT JOIN private.weight_entry w ON w.owner_id = v_owner AND w.entry_date = c.entry_date;

    RETURN pg_catalog.jsonb_build_object('from',p_from::text,'to',p_to::text,
        'today',v_today::text,'timezone','Europe/Warsaw','days',v_days);
END;
$$;
REVOKE ALL ON FUNCTION api.get_statistics(date,date) FROM PUBLIC,anon,authenticated;
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

    ALTER FUNCTION api.get_statistics(date,date) OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api, private FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.get_statistics(date,date) TO authenticated;

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

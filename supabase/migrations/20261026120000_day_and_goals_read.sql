CREATE OR REPLACE FUNCTION private.assert_read_date(p_date date)
RETURNS date
LANGUAGE plpgsql
STABLE
SET search_path = ''
AS $$
DECLARE
    local_today date := (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date;
BEGIN
    IF p_date IS NULL THEN
        RAISE EXCEPTION 'A read date is required'
            USING ERRCODE = '22023';
    END IF;
    IF p_date > local_today THEN
        RAISE EXCEPTION 'Future dates cannot be read'
            USING ERRCODE = '22023';
    END IF;
    RETURN p_date;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_read_date(date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.assert_read_date(date) TO app_executor;

CREATE OR REPLACE FUNCTION api.get_day(p_date date)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
WITH requested_date AS (
    SELECT private.assert_read_date(p_date) AS value
),
current_owner AS (
    SELECT account.id
      FROM private.app_user AS account
     WHERE account.singleton = 1
       AND account.auth_subject = (SELECT auth.uid())
),
day_meals AS (
    SELECT meal.*
      FROM private.diary_meal AS meal
      JOIN current_owner AS owner ON owner.id = meal.owner_id
      CROSS JOIN requested_date AS requested
     WHERE meal.entry_date = requested.value
       AND meal.deleted_at IS NULL
),
meal_totals AS (
    SELECT item.diary_meal_id,
           COALESCE(SUM(item.quantity * item.kcal_per_100 / 100), 0)::numeric AS kcal,
           COALESCE(SUM(item.quantity * item.protein_per_100 / 100), 0)::numeric AS protein,
           COALESCE(SUM(item.quantity * item.fat_per_100 / 100), 0)::numeric AS fat,
           COALESCE(SUM(item.quantity * item.carbs_per_100 / 100), 0)::numeric AS carbs
      FROM private.diary_item AS item
      JOIN day_meals AS meal ON meal.id = item.diary_meal_id
     GROUP BY item.diary_meal_id
),
day_totals AS (
    SELECT COALESCE(SUM(meal.kcal), 0)::numeric AS kcal,
           COALESCE(SUM(meal.protein), 0)::numeric AS protein,
           COALESCE(SUM(meal.fat), 0)::numeric AS fat,
           COALESCE(SUM(meal.carbs), 0)::numeric AS carbs
      FROM meal_totals AS meal
),
selected_goal AS (
    SELECT goal.*
      FROM private.goal_version AS goal
      JOIN current_owner AS owner ON owner.id = goal.owner_id
      CROSS JOIN requested_date AS requested
     WHERE goal.effective_from <= requested.value
     ORDER BY goal.effective_from DESC
     LIMIT 1
),
meals_json AS (
    SELECT COALESCE(
               jsonb_agg(
                   jsonb_build_object(
                       'id', meal.id::text,
                       'name', meal.name,
                       'entry_date', meal.entry_date::text,
                       'category', meal.category,
                       'revision', meal.revision,
                       'items', COALESCE((
                           SELECT jsonb_agg(
                                      jsonb_build_object(
                                          'item_id', item.id::text,
                                          'product_id', item.product_id::text,
                                          'source_product_revision', item.source_product_revision,
                                          'product_name', item.product_name,
                                          'basis_unit', item.basis_unit,
                                          'kcal_per_100', item.kcal_per_100::text,
                                          'protein_per_100', item.protein_per_100::text,
                                          'fat_per_100', item.fat_per_100::text,
                                          'carbs_per_100', item.carbs_per_100::text,
                                          'quantity', item.quantity::text,
                                          'position', item.position
                                      ) ORDER BY item.position
                                  )
                             FROM private.diary_item AS item
                            WHERE item.owner_id = meal.owner_id
                              AND item.diary_meal_id = meal.id
                       ), '[]'::jsonb),
                       'totals', jsonb_build_object(
                           'kcal', COALESCE(meal_total.kcal, 0)::text,
                           'protein', COALESCE(meal_total.protein, 0)::text,
                           'fat', COALESCE(meal_total.fat, 0)::text,
                           'carbs', COALESCE(meal_total.carbs, 0)::text
                       ),
                       'created_at', meal.created_at,
                       'updated_at', meal.updated_at
                   )
                   ORDER BY CASE meal.category
                       WHEN 'breakfast' THEN 1
                       WHEN 'lunch' THEN 2
                       WHEN 'dinner' THEN 3
                       ELSE 4
                   END, meal.created_at, meal.id
               ),
               '[]'::jsonb
           ) AS value
      FROM day_meals AS meal
      LEFT JOIN meal_totals AS meal_total ON meal_total.diary_meal_id = meal.id
),
goal_json AS (
    SELECT jsonb_build_object(
               'id', goal.id::text,
               'effective_from', goal.effective_from::text,
               'kcal_goal', goal.kcal_goal::text,
               'protein_goal', goal.protein_goal::text,
               'fat_goal', goal.fat_goal::text,
               'carbs_goal', goal.carbs_goal::text,
               'revision', goal.revision,
               'created_at', goal.created_at,
               'updated_at', goal.updated_at
           ) AS value,
           goal.kcal_goal,
           goal.protein_goal,
           goal.fat_goal,
           goal.carbs_goal
      FROM selected_goal AS goal
),
goal_values AS (
    SELECT (SELECT value FROM goal_json) AS value,
           (SELECT kcal_goal FROM goal_json) AS kcal_goal,
           (SELECT protein_goal FROM goal_json) AS protein_goal,
           (SELECT fat_goal FROM goal_json) AS fat_goal,
           (SELECT carbs_goal FROM goal_json) AS carbs_goal
)
SELECT jsonb_build_object(
           'date', requested.value::text,
           'timezone', 'Europe/Warsaw',
           'meals', meals_json.value,
           'totals', jsonb_build_object(
               'kcal', day_totals.kcal::text,
               'protein', day_totals.protein::text,
               'fat', day_totals.fat::text,
               'carbs', day_totals.carbs::text
           ),
           'goals', goal_values.value,
           'remaining_kcal', CASE
               WHEN goal_values.kcal_goal IS NULL THEN NULL
               ELSE pg_catalog.trim_scale(goal_values.kcal_goal - day_totals.kcal)::text
           END,
           'percentages', CASE
               WHEN goal_values.kcal_goal IS NULL THEN NULL
               ELSE jsonb_build_object(
                   'kcal', pg_catalog.round(day_totals.kcal / goal_values.kcal_goal * 100, 2)::text,
                   'protein', pg_catalog.round(day_totals.protein / goal_values.protein_goal * 100, 2)::text,
                   'fat', pg_catalog.round(day_totals.fat / goal_values.fat_goal * 100, 2)::text,
                   'carbs', pg_catalog.round(day_totals.carbs / goal_values.carbs_goal * 100, 2)::text
               )
           END
       )
  FROM current_owner AS owner
 CROSS JOIN requested_date AS requested
 CROSS JOIN day_totals
 CROSS JOIN meals_json
 CROSS JOIN goal_values;
$$;

CREATE OR REPLACE FUNCTION api.get_goals(p_date date DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
WITH current_owner AS (
    SELECT account.id
      FROM private.app_user AS account
     WHERE account.singleton = 1
       AND account.auth_subject = (SELECT auth.uid())
),
dates AS (
    SELECT COALESCE(p_date, (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date) AS requested,
           (pg_catalog.transaction_timestamp() AT TIME ZONE 'Europe/Warsaw')::date AS today
),
validated_dates AS (
    SELECT private.assert_read_date(dates.requested) AS requested, dates.today
      FROM dates
),
current_goal AS (
    SELECT goal.*
      FROM private.goal_version AS goal
      JOIN current_owner AS owner ON owner.id = goal.owner_id
      CROSS JOIN validated_dates AS dates
     WHERE goal.effective_from <= dates.requested
     ORDER BY goal.effective_from DESC
     LIMIT 1
),
today_goal AS (
    SELECT goal.id, goal.revision
      FROM private.goal_version AS goal
      JOIN current_owner AS owner ON owner.id = goal.owner_id
      CROSS JOIN validated_dates AS dates
     WHERE goal.effective_from = dates.today
     LIMIT 1
),
goal_view AS (
    SELECT jsonb_build_object(
               'id', goal.id::text,
               'effective_from', goal.effective_from::text,
               'kcal_goal', goal.kcal_goal::text,
               'protein_goal', goal.protein_goal::text,
               'fat_goal', goal.fat_goal::text,
               'carbs_goal', goal.carbs_goal::text,
               'revision', goal.revision,
               'created_at', goal.created_at,
               'updated_at', goal.updated_at
           ) AS value
      FROM current_goal AS goal
)
SELECT jsonb_build_object(
           'date', dates.requested::text,
           'current', (SELECT value FROM goal_view),
           'today_id', (SELECT today_goal.id::text FROM today_goal),
           'today_revision', COALESCE((SELECT today_goal.revision FROM today_goal), 0)
       )
  FROM current_owner
 CROSS JOIN validated_dates AS dates;
$$;

REVOKE ALL ON FUNCTION api.get_day(date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.get_goals(date) FROM PUBLIC, anon, authenticated;
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

    ALTER FUNCTION api.get_day(date) OWNER TO app_executor;
    ALTER FUNCTION api.get_goals(date) OWNER TO app_executor;
    REVOKE CREATE ON SCHEMA api FROM app_executor;
    GRANT EXECUTE ON FUNCTION api.get_day(date) TO authenticated;
    GRANT EXECUTE ON FUNCTION api.get_goals(date) TO authenticated;

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

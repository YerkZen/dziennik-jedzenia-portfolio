DO $$
BEGIN
    BEGIN
        CREATE ROLE app_executor
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    EXCEPTION WHEN duplicate_object THEN
        IF EXISTS (
            SELECT 1 FROM pg_roles
            WHERE rolname = 'app_executor'
              AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit)
        ) THEN
            RAISE EXCEPTION 'Existing app_executor role has unsafe attributes';
        END IF;
    END;
END;
$$;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO app_executor;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA private TO app_executor;

GRANT USAGE ON SCHEMA auth TO app_executor;
REVOKE ALL ON FUNCTION auth.uid() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION auth.uid() TO app_executor;

GRANT USAGE ON SCHEMA api TO authenticated;
REVOKE ALL ON SCHEMA api FROM PUBLIC, anon;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA api FROM PUBLIC, anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA api REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;

ALTER TABLE private.app_user ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.app_user FORCE ROW LEVEL SECURITY;
ALTER TABLE private.product ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.product FORCE ROW LEVEL SECURITY;
ALTER TABLE private.meal_template ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meal_template FORCE ROW LEVEL SECURITY;
ALTER TABLE private.meal_template_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.meal_template_item FORCE ROW LEVEL SECURITY;
ALTER TABLE private.diary_meal ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.diary_meal FORCE ROW LEVEL SECURITY;
ALTER TABLE private.diary_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.diary_item FORCE ROW LEVEL SECURITY;
ALTER TABLE private.goal_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.goal_version FORCE ROW LEVEL SECURITY;

CREATE POLICY app_user_owner ON private.app_user
    FOR ALL TO app_executor
    USING (singleton = 1 AND auth_subject = (SELECT auth.uid()))
    WITH CHECK (singleton = 1 AND auth_subject = (SELECT auth.uid()));

CREATE POLICY product_owner ON private.product
    FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())));

CREATE POLICY meal_template_owner ON private.meal_template
    FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())));

CREATE POLICY meal_template_item_owner ON private.meal_template_item
    FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())));

CREATE POLICY diary_meal_owner ON private.diary_meal
    FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())));

CREATE POLICY diary_item_owner ON private.diary_item
    FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())));

CREATE POLICY goal_version_owner ON private.goal_version
    FOR ALL TO app_executor
    USING (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())))
    WITH CHECK (owner_id IN (SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())));

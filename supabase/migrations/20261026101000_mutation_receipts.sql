CREATE TABLE private.mutation_receipt (
    owner_id uuid NOT NULL REFERENCES private.app_user(id),
    key uuid NOT NULL,
    operation varchar(100) NOT NULL CHECK (char_length(btrim(operation)) BETWEEN 1 AND 100),
    resource_id uuid NOT NULL,
    request_hash varchar(64) NOT NULL CHECK (request_hash ~ '^[0-9a-f]{64}$'),
    applied_revision integer NOT NULL CHECK (applied_revision >= 0),
    created_at timestamptz NOT NULL DEFAULT transaction_timestamp(),
    PRIMARY KEY (owner_id, key)
);

ALTER TABLE private.mutation_receipt ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.mutation_receipt FORCE ROW LEVEL SECURITY;

CREATE POLICY mutation_receipt_owner ON private.mutation_receipt
    FOR ALL TO app_executor
    USING (owner_id IN (
        SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())
    ))
    WITH CHECK (owner_id IN (
        SELECT id FROM private.app_user WHERE auth_subject = (SELECT auth.uid())
    ));

REVOKE ALL ON TABLE private.mutation_receipt FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE private.mutation_receipt TO app_executor;

CREATE OR REPLACE FUNCTION private.begin_mutation(
    p_owner_id uuid,
    p_key uuid,
    p_operation text,
    p_resource_id uuid,
    p_request_hash text
)
RETURNS TABLE(replayed boolean, applied_revision integer)
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    inserted_rows integer;
    existing_receipt private.mutation_receipt%ROWTYPE;
BEGIN
    IF p_owner_id IS NULL
       OR p_key IS NULL
       OR p_resource_id IS NULL
       OR p_operation IS NULL
       OR char_length(btrim(p_operation)) NOT BETWEEN 1 AND 100
       OR p_request_hash IS NULL
       OR p_request_hash !~ '^[0-9a-f]{64}$' THEN
        RAISE EXCEPTION 'Invalid mutation receipt input'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO private.mutation_receipt (
        owner_id, key, operation, resource_id, request_hash, applied_revision
    ) VALUES (
        p_owner_id, p_key, p_operation, p_resource_id, p_request_hash, 0
    )
    ON CONFLICT (owner_id, key) DO NOTHING;
    GET DIAGNOSTICS inserted_rows = ROW_COUNT;

    IF inserted_rows = 1 THEN
        replayed := false;
        applied_revision := NULL;
        RETURN NEXT;
        RETURN;
    END IF;

    SELECT receipt.*
      INTO existing_receipt
      FROM private.mutation_receipt AS receipt
     WHERE receipt.owner_id = p_owner_id
       AND receipt.key = p_key;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Mutation receipt is not visible to the current owner'
            USING ERRCODE = '42501';
    END IF;

    IF existing_receipt.operation IS DISTINCT FROM p_operation
       OR existing_receipt.resource_id IS DISTINCT FROM p_resource_id
       OR existing_receipt.request_hash IS DISTINCT FROM p_request_hash THEN
        RAISE EXCEPTION 'IDEMPOTENCY_MISMATCH'
            USING ERRCODE = 'P0001';
    END IF;

    IF existing_receipt.applied_revision < 1 THEN
        RAISE EXCEPTION 'Mutation receipt has not been completed'
            USING ERRCODE = '55000';
    END IF;

    replayed := true;
    applied_revision := existing_receipt.applied_revision;
    RETURN NEXT;
END;
$$;

CREATE OR REPLACE FUNCTION private.complete_mutation(
    p_owner_id uuid,
    p_key uuid,
    p_applied_revision integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    updated_rows integer;
BEGIN
    IF p_owner_id IS NULL OR p_key IS NULL OR p_applied_revision IS NULL OR p_applied_revision < 1 THEN
        RAISE EXCEPTION 'Invalid applied mutation revision'
            USING ERRCODE = '22023';
    END IF;

    UPDATE private.mutation_receipt
       SET applied_revision = p_applied_revision
     WHERE owner_id = p_owner_id
       AND key = p_key
       AND applied_revision = 0;
    GET DIAGNOSTICS updated_rows = ROW_COUNT;

    IF updated_rows <> 1 THEN
        RAISE EXCEPTION 'Mutation receipt cannot be completed'
            USING ERRCODE = '55000';
    END IF;
END;
$$;

CREATE OR REPLACE FUNCTION private.guard_mutation_receipt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.applied_revision <> 0 THEN
            RAISE EXCEPTION 'Mutation receipt must be claimed before it is completed'
                USING ERRCODE = '23514';
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.applied_revision <> 0
       OR NEW.applied_revision < 1
       OR NEW.owner_id IS DISTINCT FROM OLD.owner_id
       OR NEW.key IS DISTINCT FROM OLD.key
       OR NEW.operation IS DISTINCT FROM OLD.operation
       OR NEW.resource_id IS DISTINCT FROM OLD.resource_id
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'Completed mutation receipt is immutable'
            USING ERRCODE = '23514';
    END IF;

    RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION private.ensure_mutation_receipt_completed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
    final_revision integer;
BEGIN
    SELECT receipt.applied_revision
      INTO final_revision
      FROM private.mutation_receipt AS receipt
     WHERE receipt.owner_id = NEW.owner_id
       AND receipt.key = NEW.key;

    IF NOT FOUND OR final_revision IS NULL OR final_revision < 1 THEN
        RAISE EXCEPTION 'Mutation receipt must be completed before commit'
            USING ERRCODE = '23514';
    END IF;

    RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER mutation_receipt_must_be_completed
    AFTER INSERT OR UPDATE ON private.mutation_receipt
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION private.ensure_mutation_receipt_completed();

CREATE TRIGGER mutation_receipt_guard
    BEFORE INSERT OR UPDATE ON private.mutation_receipt
    FOR EACH ROW EXECUTE FUNCTION private.guard_mutation_receipt();

REVOKE ALL ON FUNCTION private.begin_mutation(uuid, uuid, text, uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.complete_mutation(uuid, uuid, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.guard_mutation_receipt() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION private.ensure_mutation_receipt_completed() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.begin_mutation(uuid, uuid, text, uuid, text) TO app_executor;
GRANT EXECUTE ON FUNCTION private.complete_mutation(uuid, uuid, integer) TO app_executor;
GRANT EXECUTE ON FUNCTION private.guard_mutation_receipt() TO app_executor;
GRANT EXECUTE ON FUNCTION private.ensure_mutation_receipt_completed() TO app_executor;

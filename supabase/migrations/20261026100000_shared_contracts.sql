CREATE OR REPLACE FUNCTION private.assert_decimal_10_2(
    p_text text,
    p_allow_zero boolean DEFAULT true
)
RETURNS numeric
LANGUAGE plpgsql
IMMUTABLE
SET search_path = ''
AS $$
DECLARE
    parsed_value numeric;
BEGIN
    -- Validate the original text before any numeric cast. PostgreSQL casts to
    -- numeric(10,2) round values with extra fractional digits.
    IF p_text IS NULL OR p_text !~ '^(0|[1-9][0-9]{0,7})(\.[0-9]{1,2})?$' THEN
        RAISE EXCEPTION 'Invalid decimal(10,2) text'
            USING ERRCODE = '22023';
    END IF;

    parsed_value := p_text::numeric;
    IF NOT p_allow_zero AND parsed_value <= 0 THEN
        RAISE EXCEPTION 'Value must be greater than zero'
            USING ERRCODE = '22023';
    END IF;

    RETURN parsed_value;
END;
$$;

REVOKE ALL ON FUNCTION private.assert_decimal_10_2(text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION private.assert_decimal_10_2(text, boolean) TO app_executor;

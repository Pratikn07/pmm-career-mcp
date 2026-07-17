-- Optional fallback only. Select this function under Authentication > Hooks
-- only if the native OAuth resource indicator does not set the expected aud.
CREATE OR REPLACE FUNCTION public.mcp_audience_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  claims jsonb := event -> 'claims';
  audience text := claims -> 'app_metadata' ->> 'mcp_audience';
BEGIN
  IF audience IS NULL OR audience = '' THEN
    RETURN jsonb_build_object('claims', claims);
  END IF;

  RETURN jsonb_build_object(
    'claims',
    jsonb_set(claims, '{aud}', to_jsonb(audience), true)
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_audience_access_token_hook(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcp_audience_access_token_hook(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.mcp_audience_access_token_hook(jsonb) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.mcp_audience_access_token_hook(jsonb) TO supabase_auth_admin;

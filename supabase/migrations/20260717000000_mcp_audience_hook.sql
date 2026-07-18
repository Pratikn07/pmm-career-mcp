-- Required for MCP OAuth access tokens. Select this function under
-- Authentication > Hooks after configuring app_metadata.mcp_audience.
CREATE OR REPLACE FUNCTION public.mcp_audience_access_token_hook(event jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $$
DECLARE
  claims jsonb := event -> 'claims';
  client_id text := claims ->> 'client_id';
  audience text := claims -> 'app_metadata' ->> 'mcp_audience';
BEGIN
  IF client_id IS NULL OR client_id = '' OR audience IS NULL OR audience = '' THEN
    RETURN jsonb_build_object('claims', claims);
  END IF;

  claims := jsonb_set(claims, '{aud}', to_jsonb(audience), true);
  claims := jsonb_set(claims, '{scope}', to_jsonb('openid email'::text), true);

  RETURN jsonb_build_object(
    'claims',
    claims
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mcp_audience_access_token_hook(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.mcp_audience_access_token_hook(jsonb) FROM anon;
REVOKE ALL ON FUNCTION public.mcp_audience_access_token_hook(jsonb) FROM authenticated;
GRANT USAGE ON SCHEMA public TO supabase_auth_admin;
GRANT EXECUTE ON FUNCTION public.mcp_audience_access_token_hook(jsonb) TO supabase_auth_admin;

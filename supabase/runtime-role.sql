\set ON_ERROR_STOP on

-- Run this template with psql while connected as the same owner used by
-- MIGRATION_DATABASE_URL. The final \password command prompts privately and
-- does not put the entered value in this file, shell history, or psql history.

begin;

create schema if not exists career_mcp;

do $operator$
declare
  existing_role record;
begin
  select
    rolsuper,
    rolcreatedb,
    rolcreaterole,
    rolreplication,
    rolbypassrls
  into existing_role
    from pg_catalog.pg_roles
    where rolname = 'career_mcp_runtime';

  if not found then
    -- These omitted privilege attributes default to false. Supabase's postgres
    -- owner has CREATEROLE but is intentionally not a true superuser, so it
    -- cannot use ALTER ROLE to change superuser-only attributes afterwards.
    create role career_mcp_runtime
      noinherit
      login
      connection limit 10;
  elsif existing_role.rolsuper
    or existing_role.rolcreatedb
    or existing_role.rolcreaterole
    or existing_role.rolreplication
    or existing_role.rolbypassrls then
    raise exception 'career_mcp_runtime has unsafe role attributes; remove or harden it before continuing';
  end if;

  if exists (
    select 1
    from pg_catalog.pg_auth_members membership
    join pg_catalog.pg_roles member_role on member_role.oid = membership.member
    where member_role.rolname = 'career_mcp_runtime'
  ) then
    raise exception 'career_mcp_runtime has an existing parent role membership; remove it before continuing';
  end if;
end
$operator$;

alter role career_mcp_runtime
  noinherit
  login
  connection limit 10;

revoke all privileges on schema career_mcp from career_mcp_runtime;
revoke all privileges on all tables in schema career_mcp from career_mcp_runtime;
revoke all privileges on all sequences in schema career_mcp from career_mcp_runtime;
revoke all privileges on all functions in schema career_mcp from career_mcp_runtime;

grant usage on schema career_mcp to career_mcp_runtime;
grant select, insert, update, delete on all tables in schema career_mcp to career_mcp_runtime;
grant usage, select on all sequences in schema career_mcp to career_mcp_runtime;

alter default privileges in schema career_mcp
  revoke all privileges on tables from career_mcp_runtime;
alter default privileges in schema career_mcp
  revoke all privileges on sequences from career_mcp_runtime;
alter default privileges in schema career_mcp
  revoke all privileges on functions from career_mcp_runtime;
alter default privileges in schema career_mcp
  grant select, insert, update, delete on tables to career_mcp_runtime;
alter default privileges in schema career_mcp
  grant usage, select on sequences to career_mcp_runtime;

-- The durable claim ledger is trigger-managed. Keep this block after every
-- broad current/default grant so an idempotent rerun cannot restore mutations.
-- The guards also let operators provision the runtime role before migrations.
do $ledger_privileges$
begin
  if pg_catalog.to_regclass('career_mcp.media_usage_claims') is not null then
    execute 'revoke insert, update, delete, truncate on table career_mcp.media_usage_claims from career_mcp_runtime';
    execute 'grant select on table career_mcp.media_usage_claims to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.claim_post_draft_media_usage()'
  ) is not null then
    execute 'revoke all on function career_mcp.claim_post_draft_media_usage() from public';
    execute 'grant execute on function career_mcp.claim_post_draft_media_usage() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.claim_brand_source_media_usage()'
  ) is not null then
    execute 'revoke all on function career_mcp.claim_brand_source_media_usage() from public';
    execute 'grant execute on function career_mcp.claim_brand_source_media_usage() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regclass('career_mcp.brand_brief_source_claims') is not null then
    execute 'revoke insert, update, delete, truncate on table career_mcp.brand_brief_source_claims from career_mcp_runtime';
    execute 'grant select on table career_mcp.brand_brief_source_claims to career_mcp_runtime';
  end if;

  if pg_catalog.to_regclass('career_mcp.post_draft_owners') is not null then
    execute 'revoke insert, update, delete, truncate on table career_mcp.post_draft_owners from career_mcp_runtime';
    execute 'grant select on table career_mcp.post_draft_owners to career_mcp_runtime';
  end if;

  if pg_catalog.to_regclass('career_mcp.runtime_role_owners') is not null then
    execute 'revoke insert, update, delete, truncate on table career_mcp.runtime_role_owners from career_mcp_runtime';
    execute 'grant select on table career_mcp.runtime_role_owners to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.claim_post_draft_owner()'
  ) is not null then
    execute 'revoke all on function career_mcp.claim_post_draft_owner() from public';
    execute 'grant execute on function career_mcp.claim_post_draft_owner() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.keep_post_draft_owner_immutable()'
  ) is not null then
    execute 'revoke all on function career_mcp.keep_post_draft_owner_immutable() from public';
    execute 'grant execute on function career_mcp.keep_post_draft_owner_immutable() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.reject_post_draft_owner_mutation()'
  ) is not null then
    execute 'revoke all on function career_mcp.reject_post_draft_owner_mutation() from public';
    execute 'grant execute on function career_mcp.reject_post_draft_owner_mutation() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.reject_runtime_role_owner_mutation()'
  ) is not null then
    execute 'revoke all on function career_mcp.reject_runtime_role_owner_mutation() from public';
    execute 'grant execute on function career_mcp.reject_runtime_role_owner_mutation() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.claim_brand_brief_source()'
  ) is not null then
    execute 'revoke all on function career_mcp.claim_brand_brief_source() from public';
    execute 'grant execute on function career_mcp.claim_brand_brief_source() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.keep_brand_brief_source_immutable()'
  ) is not null then
    execute 'revoke all on function career_mcp.keep_brand_brief_source_immutable() from public';
    execute 'grant execute on function career_mcp.keep_brand_brief_source_immutable() to career_mcp_runtime';
  end if;

  if pg_catalog.to_regprocedure(
    'career_mcp.reject_brand_brief_source_claim_mutation()'
  ) is not null then
    execute 'revoke all on function career_mcp.reject_brand_brief_source_claim_mutation() from public';
    execute 'grant execute on function career_mcp.reject_brand_brief_source_claim_mutation() to career_mcp_runtime';
  end if;
end
$ledger_privileges$;

commit;

\password career_mcp_runtime
\echo 'The career_mcp_runtime login is ready. Store its URL only as the private DATABASE_URL secret.'

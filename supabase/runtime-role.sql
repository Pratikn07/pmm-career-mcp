\set ON_ERROR_STOP on

-- Run this template with psql while connected as the same owner used by
-- MIGRATION_DATABASE_URL. The final \password command prompts privately and
-- does not put the entered value in this file, shell history, or psql history.

begin;

do $operator$
begin
  if not exists (
    select 1
    from pg_catalog.pg_roles
    where rolname = 'career_mcp_runtime'
  ) then
    create role career_mcp_runtime;
  end if;
end
$operator$;

alter role career_mcp_runtime
  nosuperuser
  nocreatedb
  nocreaterole
  noinherit
  login
  noreplication
  nobypassrls
  connection limit 10;

revoke all privileges on schema career_mcp from career_mcp_runtime;
revoke all privileges on all tables in schema career_mcp from career_mcp_runtime;
revoke all privileges on all sequences in schema career_mcp from career_mcp_runtime;

grant usage on schema career_mcp to career_mcp_runtime;
grant select, insert, update, delete on all tables in schema career_mcp to career_mcp_runtime;
grant usage, select on all sequences in schema career_mcp to career_mcp_runtime;

alter default privileges in schema career_mcp
  revoke all privileges on tables from career_mcp_runtime;
alter default privileges in schema career_mcp
  revoke all privileges on sequences from career_mcp_runtime;
alter default privileges in schema career_mcp
  grant select, insert, update, delete on tables to career_mcp_runtime;
alter default privileges in schema career_mcp
  grant usage, select on sequences to career_mcp_runtime;

commit;

\password career_mcp_runtime
\echo 'The career_mcp_runtime login is ready. Store its URL only as the private DATABASE_URL secret.'

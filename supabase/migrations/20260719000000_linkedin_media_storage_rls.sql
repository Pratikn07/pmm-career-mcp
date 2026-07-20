do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkedin draft media select own'
  ) then
    execute $ddl$
      create policy "linkedin draft media select own"
      on storage.objects for select to authenticated
      using (
        bucket_id = 'linkedin-draft-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
    $ddl$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkedin draft media insert own'
  ) then
    execute $ddl$
      create policy "linkedin draft media insert own"
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'linkedin-draft-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
    $ddl$;
  end if;
end
$policy$;

do $policy$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'linkedin draft media delete own'
  ) then
    execute $ddl$
      create policy "linkedin draft media delete own"
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'linkedin-draft-media'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
    $ddl$;
  end if;
end
$policy$;

-- 0003: hardening for hosted Supabase. Safe to run on plain Postgres (guards make it a no-op there).
-- 1) Supabase's "automatically enable RLS" option installs public.rls_auto_enable(), a SECURITY DEFINER event-trigger function
--    that the platform exposes to anon/authenticated through the public API. It does not need to be callable by API roles.
do $$
begin
  if to_regprocedure('public.rls_auto_enable()') is not null then
    revoke execute on function public.rls_auto_enable() from public, anon, authenticated;
  end if;
end $$;

-- 2) Hosted platforms pre-grant sequence privileges to API roles by default. Nothing here needs them: inserts into tables with
--    identity columns happen inside SECURITY DEFINER functions owned by the migration role.
revoke all on all sequences in schema public from public, anon, authenticated;

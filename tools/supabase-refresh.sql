-- Bouton « Actualiser » (Notes, Emploi du temps) : la base demande à GitHub de lancer le robot.
-- À coller dans Supabase › SQL Editor, APRÈS avoir remplacé COLLE-TON-JETON par ton jeton GitHub, puis « Run ».
create extension if not exists pg_net;

insert into public.app_config (key, value) values ('github_token', 'COLLE-TON-JETON')
on conflict (key) do update set value = excluded.value;

create or replace function public.request_refresh() returns text
language plpgsql security definer set search_path = public as $$
declare
  tok text;
  feats jsonb;
  last timestamptz;
begin
  select features into feats from public.profiles where id = auth.uid();
  if not coalesce((feats->>'edtSync')::boolean, false) then raise exception 'non autorisé'; end if;
  -- Une demande toutes les 3 minutes au plus.
  select value::timestamptz into last from public.app_config where key = 'last_refresh';
  if last is not null and last > now() - interval '3 minutes' then return 'deja'; end if;
  insert into public.app_config (key, value) values ('last_refresh', now()::text)
  on conflict (key) do update set value = excluded.value;
  select value into tok from public.app_config where key = 'github_token';
  perform net.http_post(
    url := 'https://api.github.com/repos/sneaqix/flashcards-data/actions/workflows/edt.yml/dispatches',
    body := '{"ref":"main"}'::jsonb,
    headers := jsonb_build_object(
      'Authorization', 'Bearer ' || tok,
      'Accept', 'application/vnd.github+json',
      'X-GitHub-Api-Version', '2022-11-28',
      'User-Agent', 'flashcards-tsi'));
  return 'ok';
end $$;
revoke all on function public.request_refresh() from public, anon;
grant execute on function public.request_refresh() to authenticated;

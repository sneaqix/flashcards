-- Page « Camarades » : statistiques de révision de tous les comptes, lisibles seulement par un compte « admin ».
-- À coller dans Supabase › SQL Editor, puis « Run ».
create or replace function public.admin_stats() returns jsonb
language plpgsql security definer set search_path = public stable as $$
begin
  if not coalesce((select (features->>'admin')::boolean from public.profiles where id = auth.uid()), false) then
    raise exception 'non autorisé';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'username', p.username,
      'me', p.id = auth.uid(),
      'created', p.created_at,
      'updated', d.updated_at,
      'logs', coalesce((d.content::jsonb) -> 'logs', '{}'::jsonb)
    ) order by p.username)
    from public.profiles p
    left join public.docs d on d.user_id = p.id and d.path = 'progress.json'
  ), '[]'::jsonb);
end $$;
revoke all on function public.admin_stats() from public, anon;
grant execute on function public.admin_stats() to authenticated;

-- Le compte de Louison voit cette page.
update public.profiles set features = features || '{"admin": true}'::jsonb where username = 'louison-bleger';

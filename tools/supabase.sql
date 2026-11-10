-- Flashcards : comptes et données sur Supabase.
-- À coller dans Supabase › SQL Editor, puis « Run ». Peut être relancé sans risque.
-- AVANT de lancer : remplace CHANGE-MOI (tout en bas) par le code d'invitation que tu donneras à tes camarades.

-- ---------- Profils (un par compte) ----------
create table if not exists public.profiles (
  id uuid primary key references auth.users on delete cascade,
  username text unique not null,
  features jsonb not null default '{}'::jsonb,   -- pages réservées : {"notes": true, "edt": true, "notifs": true}
  created_at timestamptz not null default now()
);
alter table public.profiles enable row level security;
drop policy if exists "profil : lecture par soi" on public.profiles;
create policy "profil : lecture par soi" on public.profiles for select using (auth.uid() = id);

-- ---------- Réglages privés (code d'invitation) : aucune règle d'accès, donc illisibles depuis l'appli ----------
create table if not exists public.app_config (key text primary key, value text not null);
alter table public.app_config enable row level security;

-- ---------- Inscription : code d'invitation obligatoire, profil créé automatiquement ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  code text;
  uname text;
begin
  select value into code from public.app_config where key = 'invite_code';
  if code is null or coalesce(new.raw_user_meta_data->>'invite', '') <> code then
    raise exception 'invitation invalide';
  end if;
  uname := lower(coalesce(new.raw_user_meta_data->>'username', split_part(new.email, '@', 1)));
  insert into public.profiles (id, username) values (new.id, uname);
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- Vérifications avant inscription, pour des messages clairs (sans révéler le code).
create or replace function public.check_invite(p_code text) returns boolean
language sql security definer set search_path = public stable as $$
  select exists (select 1 from public.app_config where key = 'invite_code' and value = p_code);
$$;
create or replace function public.username_available(p_username text) returns boolean
language sql security definer set search_path = public stable as $$
  select not exists (select 1 from public.profiles where username = lower(p_username));
$$;
grant execute on function public.check_invite(text) to anon, authenticated;
grant execute on function public.username_available(text) to anon, authenticated;

-- ---------- Données : un « fichier » JSON par ligne (cartes, progression, calendrier…) ----------
create table if not exists public.docs (
  user_id uuid not null default auth.uid() references auth.users on delete cascade,
  path text not null,
  content text not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);
alter table public.docs enable row level security;
drop policy if exists "docs : chacun les siens" on public.docs;
create policy "docs : chacun les siens" on public.docs for all
  using (auth.uid() = user_id) with check (auth.uid() = user_id);

-- Écriture avec contrôle de version : refusée si le document a changé ailleurs entre-temps.
create or replace function public.put_doc(p_path text, p_content text, p_version bigint)
returns bigint language plpgsql security invoker set search_path = public as $$
declare v bigint;
begin
  if p_version is null then
    insert into public.docs (user_id, path, content) values (auth.uid(), p_path, p_content)
    on conflict (user_id, path) do nothing returning version into v;
  else
    update public.docs set content = p_content, version = version + 1, updated_at = now()
    where user_id = auth.uid() and path = p_path and version = p_version returning version into v;
  end if;
  if v is null then raise exception 'conflit' using errcode = '40001'; end if;
  return v;
end $$;
grant execute on function public.put_doc(text, text, bigint) to authenticated;

-- ---------- Fichiers (PDF du Classeur, images de cartes) : chacun dans son dossier ----------
insert into storage.buckets (id, name, public) values ('files', 'files', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('images', 'images', true) on conflict (id) do nothing;
drop policy if exists "fichiers : lecture perso" on storage.objects;
drop policy if exists "fichiers : ajout perso" on storage.objects;
drop policy if exists "fichiers : modif perso" on storage.objects;
drop policy if exists "fichiers : suppression perso" on storage.objects;
create policy "fichiers : lecture perso" on storage.objects for select
  using (bucket_id in ('files', 'images') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fichiers : ajout perso" on storage.objects for insert
  with check (bucket_id in ('files', 'images') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fichiers : modif perso" on storage.objects for update
  using (bucket_id in ('files', 'images') and (storage.foldername(name))[1] = auth.uid()::text);
create policy "fichiers : suppression perso" on storage.objects for delete
  using (bucket_id in ('files', 'images') and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- Code d'invitation (à changer ici) ----------
insert into public.app_config (key, value) values ('invite_code', 'CHANGE-MOI')
on conflict (key) do update set value = excluded.value;

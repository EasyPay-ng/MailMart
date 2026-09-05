-- Run this file in the Supabase SQL Editor before using MailMart.
create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  uid uuid unique not null,
  username text not null default '',
  phone text not null default '',
  email text not null default '',
  "displayName" text not null default '',
  "photoURL" text not null default '',
  balance numeric(12,2) not null default 0,
  status text not null default 'active',
  is_admin boolean not null default false,
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz not null default now()
);

create table if not exists public.sales (
  id uuid primary key default gen_random_uuid(),
  uid uuid not null references auth.users(id) on delete cascade,
  email text not null,
  password text not null,
  status text not null default 'pending' check (status in ('pending','approved','paid','rejected')),
  submissions jsonb not null default '[]'::jsonb,
  payout numeric(12,2),
  "createdAt" timestamptz not null default now(),
  "updatedAt" timestamptz,
  "paidAt" timestamptz
);

alter table public.users enable row level security;
alter table public.sales enable row level security;

create or replace function public.is_admin()
returns boolean language sql stable security definer set search_path = public
as $$ select exists(select 1 from public.users where id = auth.uid() and is_admin); $$;

create policy "users can read own profile" on public.users for select using (id = auth.uid() or public.is_admin());
create policy "users can create own profile" on public.users for insert with check (id = auth.uid() and uid = auth.uid());
create policy "users can update own profile" on public.users for update using (id = auth.uid()) with check (id = auth.uid() and uid = auth.uid());

create policy "sellers and admins can read sales" on public.sales for select using (uid = auth.uid() or public.is_admin());
create policy "sellers can create sales" on public.sales for insert with check (uid = auth.uid());
-- This preserves the current follow-up submission flow. For a production app,
-- use an RPC that only appends to submissions instead of permitting row updates.
create policy "sellers can update own sales" on public.sales for update using (uid = auth.uid()) with check (uid = auth.uid());
create policy "admins can update sales" on public.sales for update using (public.is_admin()) with check (public.is_admin());

-- RLS controls rows, while these triggers protect privileged columns inside a
-- row from being changed by its owner.
create or replace function public.protect_user_admin_flag()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and new.is_admin is distinct from old.is_admin and not public.is_admin() then
    raise exception 'Only an administrator may change is_admin';
  end if;
  return new;
end; $$;
drop trigger if exists protect_user_admin_flag on public.users;
create trigger protect_user_admin_flag before update on public.users
for each row execute function public.protect_user_admin_flag();

create or replace function public.protect_sale_fields()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.is_admin() and (
    new.uid is distinct from old.uid or new.email is distinct from old.email or
    new.password is distinct from old.password or new.status is distinct from old.status or
    new.payout is distinct from old.payout or new."paidAt" is distinct from old."paidAt" or
    new."createdAt" is distinct from old."createdAt"
  ) then
    raise exception 'Sellers may only append follow-up submissions';
  end if;
  return new;
end; $$;
drop trigger if exists protect_sale_fields on public.sales;
create trigger protect_sale_fields before update on public.sales
for each row execute function public.protect_sale_fields();

-- Enable Postgres Changes used by the live sale/admin screens.
do $$ begin
  alter publication supabase_realtime add table public.sales;
exception when duplicate_object then null;
end $$;

-- After registering the intended administrator, grant access with:
-- update public.users set is_admin = true where email = 'admin@example.com';

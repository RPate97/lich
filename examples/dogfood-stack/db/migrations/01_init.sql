-- Ported from supabase/migrations/20260523000000_create_things.sql.
-- RLS policy dropped; raw postgres doesn't need it and existing assertions
-- only count rows in public.things.
create table public.things (
  id bigserial primary key,
  name text not null,
  created_at timestamp with time zone default now()
);

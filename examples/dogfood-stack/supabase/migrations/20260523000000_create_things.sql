create table public.things (
  id bigserial primary key,
  name text not null,
  created_at timestamp with time zone default now()
);

alter table public.things enable row level security;

create policy "Things are publicly readable"
on public.things for select
using (true);

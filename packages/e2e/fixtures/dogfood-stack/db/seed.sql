insert into public.things (name) values
  ('first thing'),
  ('second thing'),
  ('third thing')
on conflict do nothing;

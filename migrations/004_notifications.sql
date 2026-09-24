-- Telling people, on their phone, when something happens to them here: for
-- now, when a trip is shared with them.
--
-- Every notification is stored (so the app can show a list, and so one that
-- arrives while the phone is off is not lost) and, when Firebase Cloud
-- Messaging is configured, also pushed to their devices.

create table device_tokens (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references users (id) on delete cascade,
  token         text not null unique,
  platform      text not null default 'android' check (platform in ('android', 'ios', 'web')),
  created_at    timestamptz not null default now(),
  last_seen_at  timestamptz not null default now()
);
create index device_tokens_user_idx on device_tokens (user_id);

create table notifications (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users (id) on delete cascade,
  kind        text not null check (char_length(kind) between 1 and 40),
  title       text not null check (char_length(title) between 1 and 120),
  body        text not null check (char_length(body) between 1 and 300),
  trip_id     uuid references trips (id) on delete cascade,
  actor_id    uuid references users (id) on delete set null,
  read_at     timestamptz,
  created_at  timestamptz not null default now()
);
create index notifications_user_time_idx on notifications (user_id, created_at desc);

alter table device_tokens enable row level security;
alter table notifications enable row level security;

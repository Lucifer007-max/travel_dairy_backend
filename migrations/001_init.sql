-- TravelDiary schema: people, their trips, the memories on each trip, and the photos in each memory.

create extension if not exists pgcrypto;

create table users (
  id          uuid primary key default gen_random_uuid(),
  google_sub  text unique,                      -- Google account id; null for guests
  email       text,
  name        text not null check (char_length(name) between 1 and 80),
  photo_url   text,
  is_guest    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  check (is_guest or google_sub is not null)
);

create table trips (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references users (id) on delete cascade,
  title           text not null check (char_length(title) between 1 and 120),
  destination     text not null check (char_length(destination) between 1 and 120),
  kind            text not null default 'other'
                  check (kind in ('beach', 'mountains', 'city', 'roadTrip', 'other')),
  start_date      date not null,
  end_date        date not null,
  cover_photo_id  uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  check (end_date >= start_date)
);
create index trips_user_start_idx on trips (user_id, start_date desc);

create table memories (
  id           uuid primary key default gen_random_uuid(),
  trip_id      uuid not null references trips (id) on delete cascade,
  title        text check (char_length(title) <= 120),
  note         text check (char_length(note) <= 4000),
  emoji        text check (char_length(emoji) <= 16),
  happened_at  timestamptz not null,
  place_name   text check (char_length(place_name) <= 200),
  latitude     double precision check (latitude between -90 and 90),
  longitude    double precision check (longitude between -180 and 180),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  check ((latitude is null) = (longitude is null))
);
create index memories_trip_time_idx on memories (trip_id, happened_at);

create table photos (
  id            uuid primary key default gen_random_uuid(),
  memory_id     uuid not null references memories (id) on delete cascade,
  storage_path  text not null unique,
  content_type  text not null,
  size_bytes    integer not null check (size_bytes > 0),
  position      integer not null default 0,
  taken_at      timestamptz,
  place_name    text check (char_length(place_name) <= 200),
  latitude      double precision check (latitude between -90 and 90),
  longitude     double precision check (longitude between -180 and 180),
  created_at    timestamptz not null default now(),
  check ((latitude is null) = (longitude is null))
);
create index photos_memory_position_idx on photos (memory_id, position);

alter table trips
  add constraint trips_cover_photo_fk
  foreign key (cover_photo_id) references photos (id) on delete set null;

-- Supabase exposes the public schema through its REST API. Only this backend
-- (connecting as the table owner) may touch these tables, so turn on row level
-- security with no policies: the anon and authenticated roles see nothing.
alter table users enable row level security;
alter table trips enable row level security;
alter table memories enable row level security;
alter table photos enable row level security;

-- Sharing one trip with the people you travelled with.
--
-- A trip is shared by the email address on someone's Google account, so the
-- invitation can be made before that person has ever opened the app: the row
-- waits with user_id null and is claimed the moment they sign in with that
-- address. Sharing is per trip; a person invited to one trip sees only that one.

create table trip_members (
  id          uuid primary key default gen_random_uuid(),
  trip_id     uuid not null references trips (id) on delete cascade,
  email       text not null check (char_length(email) between 3 and 320),
  user_id     uuid references users (id) on delete cascade,
  invited_by  uuid references users (id) on delete set null,
  created_at  timestamptz not null default now(),
  joined_at   timestamptz,
  unique (trip_id, email)
);
create index trip_members_user_idx on trip_members (user_id);
create index trip_members_email_idx on trip_members (email);

-- Who wrote a memory, so people sharing a trip can remove their own entries
-- without being able to touch anyone else's. Existing memories belong to the
-- trip's owner.
alter table memories add column created_by uuid references users (id) on delete set null;
update memories m set created_by = t.user_id from trips t where t.id = m.trip_id;

alter table trip_members enable row level security;

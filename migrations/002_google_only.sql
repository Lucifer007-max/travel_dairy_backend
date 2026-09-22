-- Accounts are Google-only. Remove any guest accounts (their trips, memories
-- and photo rows go with them by cascade) and require a Google account id.

delete from users where is_guest;

-- Dropping the column also drops the check that referred to it.
alter table users drop column is_guest;
alter table users alter column google_sub set not null;

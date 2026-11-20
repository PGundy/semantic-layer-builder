-- Daily balance snapshots of two synthetic accounts across January and February 2024: one row per
-- account and day it was read, primary key (account_id, snapshot_date). Account 2 has no row on
-- 2024-01-31, so its January closes on 2024-01-15. Runs unchanged on PostgreSQL and DuckDB.
--
-- Hand-counted totals the balance tests check:
--   last balance by month:   2024-01  120 + 1100 = 1220    2024-02  200 + 1300 = 1500
--   first balance by month:  2024-01  100 + 1000 = 1100    2024-02  130 + 1050 = 1180
--   sum of every row:        2024-01  370 + 2100 = 2470    2024-02  660 + 4800 = 5460
--   latest overall: 200 + 1300 = 1500 over 2 rows; earliest overall: 100 + 1000 = 1100
--   savings only (account 2), balance under 1260: 2024-01 1100, 2024-02 1250
--   rows on or before 2024-02-15 only: 2024-01 1220, 2024-02 160 + 1250 = 1410
--   last balance by week starting Sunday: 2023-12-31 1100, 2024-01-14 1250, 2024-01-28 1180,
--     2024-02-04 1370, 2024-02-11 1410, 2024-02-25 1500
--   last balance by week starting Monday: 2024-01-01 1100, 2024-01-15 1250, 2024-01-29 1180,
--     2024-02-05 1410, 2024-02-26 1500
create table balances (
  account_id integer not null,
  snapshot_date date not null,
  account_type varchar(16) not null,
  balance integer not null,
  primary key (account_id, snapshot_date)
);

insert into balances values
  (1, date '2024-01-02', 'checking', 100),
  (1, date '2024-01-15', 'checking', 150),
  (1, date '2024-01-31', 'checking', 120),
  (1, date '2024-02-01', 'checking', 130),
  (1, date '2024-02-10', 'checking', 170),
  (1, date '2024-02-11', 'checking', 160),
  (1, date '2024-02-29', 'checking', 200),
  (2, date '2024-01-02', 'savings', 1000),
  (2, date '2024-01-15', 'savings', 1100),
  (2, date '2024-02-01', 'savings', 1050),
  (2, date '2024-02-10', 'savings', 1200),
  (2, date '2024-02-11', 'savings', 1250),
  (2, date '2024-02-29', 'savings', 1300);

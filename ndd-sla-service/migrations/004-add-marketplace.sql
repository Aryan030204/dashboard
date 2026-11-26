-- NDD / SLA Reports: record each order's marketplace (EasyCom "MP Name") so reports can be filtered by it.
-- Run ONCE by hand, after 001-003 and BEFORE deploying the version that writes it (a second run fails harmlessly on
-- "Duplicate column"). Reports built earlier keep NULL and show no marketplace filter.
ALTER TABLE ndd_sla_orders
  ADD COLUMN marketplace VARCHAR(64) NULL AFTER courier;

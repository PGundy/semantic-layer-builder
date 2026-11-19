-- CRM and HR work, and a few odd ones out.
select account_id, owner_email from crm.accounts where tier = 'gold';
select count(*) from hr.employees where department = 'sales';
select a.account_id, sum(o.amount_cents)
from acme.fct_orders o
join crm.accounts a on a.customer_id = o.customer_id
where o.status = 'completed'
group by a.account_id;
select region_code, region_name from dim_regions order by 1;
select count(*) from acme.orders_v1 where status = 'completed';
select order_id from acme.stg_orders limit 10;

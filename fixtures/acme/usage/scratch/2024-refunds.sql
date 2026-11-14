-- Refunds, dated by the order they belong to.
with counted as (
  select order_id, created_at
  from acme.fct_orders
  where status in ('completed', 'shipped')
)
select date_trunc('month', counted.created_at) as order_month, sum(r.refunded_cents) as refunded
from acme.fct_refunds r
join counted on counted.order_id = r.order_id
group by 1;

select reason, count(*) from acme.fct_refunds group by reason;

select r.reason, sum(r.refunded_cents) filter (where r.reason <> 'price_adjustment') as refunded
from fct_refunds r
group by r.reason;

-- Value of fully refunded orders.
select sum(case when status = 'refunded' then amount_cents else 0 end) as refunded_order_cents
from acme.fct_orders;

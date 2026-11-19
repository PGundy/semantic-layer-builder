{{ config(materialized='table') }}
{# Revenue by ship region and month, counted orders only. #}
select o.ship_region,
       date_trunc('month', o.created_at) as month,
       sum(o.amount_cents) as revenue_cents
from {{ ref('fct_orders') }} o
join {{ source('acme', 'dim_customers') }} c on c.customer_id = o.customer_id
where o.status in ('completed', 'shipped')
  and c.is_test_account = false
{% if is_incremental() %}
  and o.created_at > (select max(created_at) from {{ this }})
{% endif %}
group by 1, 2

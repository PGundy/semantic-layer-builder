select count(*) as purchases
from {{ var('events_table') }}
where event_type = 'purchase'

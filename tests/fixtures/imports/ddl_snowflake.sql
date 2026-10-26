create or replace database ANALYTICS;

create or replace schema ANALYTICS.MARTS;

create or replace TABLE ANALYTICS.MARTS.DIM_CUSTOMERS (
	CUSTOMER_ID NUMBER(38,0) NOT NULL autoincrement start 1 increment 1 noorder COMMENT 'Surrogate key',
	EMAIL VARCHAR(16777216),
	SIGNUP_AT TIMESTAMP_NTZ(9),
	ATTRIBUTES VARIANT,
	constraint PK_DIM_CUSTOMERS primary key (CUSTOMER_ID) RELY
) COMMENT='One row per customer'
;

create or replace TRANSIENT TABLE ANALYTICS.MARTS.FCT_ORDERS (
	ORDER_ID NUMBER(38,0) NOT NULL,
	CUSTOMER_ID NUMBER(38,0),
	ORDERED_AT TIMESTAMP_LTZ(9) NOT NULL,
	ORDER_TOTAL NUMBER(12,2),
	IS_TEST BOOLEAN DEFAULT FALSE,
	"lineItems" ARRAY,
	primary key (ORDER_ID) NOT ENFORCED,
	constraint FK_ORDERS_CUSTOMER foreign key (CUSTOMER_ID) references ANALYTICS.MARTS.DIM_CUSTOMERS(CUSTOMER_ID)
) cluster by (to_date(ORDERED_AT))
  DATA_RETENTION_TIME_IN_DAYS = 1
  COMMENT = 'One row per order'
;

create or replace TABLE ANALYTICS.MARTS.DIM_DATES cluster by (DATE_DAY)(
	DATE_DAY DATE NOT NULL,
	PERIOD VARCHAR(7) COMMENT 'Year and month, as YYYY-MM'
);

create or replace schema ANALYTICS.RAW;

create or replace external table ANALYTICS.RAW.WEB_EVENTS (
	EVENT_ID VARCHAR AS (VALUE:event_id::VARCHAR),
	EVENT_DATE DATE AS (TO_DATE(VALUE:ts::VARCHAR)),
	USER_ID NUMBER(38,0) AS (VALUE:user_id::NUMBER)
)
partition by (EVENT_DATE)
location=@ANALYTICS.RAW.EVENTS_STAGE/web/
auto_refresh=true
file_format=(TYPE=PARQUET);

create or replace secure view ANALYTICS.MARTS.CUSTOMER_REVENUE(
	CUSTOMER_ID COMMENT 'The customer',
	REVENUE
) COMMENT='Revenue per customer, completed orders only'
 as
select o.CUSTOMER_ID, sum(o.ORDER_TOTAL) as REVENUE
from ANALYTICS.MARTS.FCT_ORDERS o
where not o.IS_TEST
group by 1;

create or replace view ANALYTICS.MARTS.ORDER_ITEMS_FLAT as
select o.ORDER_ID, f.value:sku::varchar as SKU
from ANALYTICS.MARTS.FCT_ORDERS o, lateral flatten(input => o."lineItems") f;

COMMENT ON COLUMN ANALYTICS.MARTS.FCT_ORDERS.ORDER_TOTAL IS 'Order total in USD';

create or replace stage ANALYTICS.RAW.EVENTS_STAGE url='s3://acme-lake/events/' file_format=(type=parquet);

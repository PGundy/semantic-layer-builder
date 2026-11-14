-- connect with postgres://analyst:Sup3rS3cret@warehouse.acme.example:5432/acme?sslmode=require
\connect postgresql://analyst:Sup3rS3cret@warehouse.acme.example/acme
select customer_id, phone from acme.dim_customers where email = 'qa.lead@example-test.com';
select count(*) from acme.dim_customers where first_name = 'Avery' and last_name = 'Okafor';
select count(*) from acme.dim_customers where lower(email) like '%@example-test.com';
select * from dblink('host=warehouse.acme.example user=analyst password=Sup3rS3cret dbname=acme', 'select 1') as t(x int);
select count(*) from acme.fct_orders where currency = 'USD' and customer_id = 4412873;

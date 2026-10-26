--
-- PostgreSQL database dump
--

SET statement_timeout = 0;
SET client_encoding = 'UTF8';
SELECT pg_catalog.set_config('search_path', '', false);
SET default_tablespace = '';

CREATE SCHEMA sales;

CREATE TYPE sales.order_status AS ENUM (
    'placed',
    'shipped',
    'completed',
    'cancelled'
);

CREATE SEQUENCE sales.customers_customer_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

CREATE FUNCTION sales.touch() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at := now(); -- a semicolon inside the body
  RETURN NEW;
END;
$$;

CREATE TABLE sales.customers (
    customer_id integer DEFAULT nextval('sales.customers_customer_id_seq'::regclass) NOT NULL,
    email character varying(255) NOT NULL,
    "Region" text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tags text[] DEFAULT '{}'::text[],
    profile jsonb,
    CONSTRAINT customers_email_check CHECK (((email)::text ~~ '%@%'::text))
);

CREATE TABLE sales.orders (
    order_id bigserial,
    customer_id integer REFERENCES sales.customers (customer_id) ON DELETE SET NULL,
    status sales.order_status DEFAULT 'placed'::sales.order_status NOT NULL,
    amount_cents bigint NOT NULL,
    placed_at timestamp without time zone,
    PRIMARY KEY (order_id)
) WITH (fillfactor='90');

CREATE TABLE sales.order_lines (
    order_id bigint NOT NULL,
    line_number integer NOT NULL,
    sku character varying(64) NOT NULL,
    quantity numeric(10,2) GENERATED ALWAYS AS (1) STORED,
    id integer GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1)
) PARTITION BY RANGE (order_id);

CREATE TABLE sales.order_lines_2025 PARTITION OF sales.order_lines FOR VALUES FROM (0) TO (1000000);

CREATE TABLE public.Audit_Log (
    id serial PRIMARY KEY,
    payload json
);

CREATE VIEW sales.customer_orders AS
 SELECT c.customer_id,
    count(o.order_id) AS orders,
    sum(o.amount_cents) AS amount_cents
   FROM (sales.customers c
     LEFT JOIN sales.orders o ON ((o.customer_id = c.customer_id)))
  GROUP BY c.customer_id;

CREATE VIEW sales.monthly_labels AS
 SELECT to_char(o.placed_at, 'YYYY-MM'::text) AS month
   FROM sales.orders o;

COMMENT ON TABLE sales.customers IS 'One row per customer; test accounts excluded.';
COMMENT ON COLUMN sales.customers.email IS 'Login email, lowercased';
COMMENT ON COLUMN sales.orders.amount_cents IS 'Order value in cents';
COMMENT ON VIEW sales.customer_orders IS 'Orders per customer';

ALTER TABLE ONLY sales.customers
    ADD CONSTRAINT customers_pkey PRIMARY KEY (customer_id);

ALTER TABLE ONLY sales.order_lines
    ADD CONSTRAINT order_lines_pkey PRIMARY KEY (order_id, line_number);

ALTER TABLE ONLY sales.order_lines
    ADD CONSTRAINT order_lines_order_id_fkey FOREIGN KEY (order_id) REFERENCES sales.orders(order_id);

ALTER TABLE ONLY sales.customers ALTER COLUMN customer_id SET DEFAULT nextval('sales.customers_customer_id_seq'::regclass);

CREATE UNIQUE INDEX customers_email_key ON sales.customers USING btree (email);
CREATE UNIQUE INDEX customers_lower_email ON sales.customers USING btree (lower((email)::text));
CREATE INDEX orders_customer_idx ON sales.orders USING btree (customer_id);

CREATE TRIGGER customers_touch BEFORE UPDATE ON sales.customers FOR EACH ROW EXECUTE FUNCTION sales.touch();

GRANT SELECT ON ALL TABLES IN SCHEMA sales TO analyst;

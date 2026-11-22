# Owner brief, two schemas: Dana Ruiz, Head of Analytics, Acme

This is an addition to `fixtures/acme/owner-brief.md` for a run where the warehouse database holds two schemas. Play Dana as that brief describes, and answer everything it covers from it. This file adds only what Dana says about the second schema. Acme and all of its data are synthetic.

When a question is not covered, say you don't know or would need to check; don't invent a rule. When you are shown a plain-English readback that matches this brief, confirm it; when it doesn't, say exactly what is wrong.

## What the database holds

The warehouse URL in `WAREHOUSE_URL` now reads a database with two schemas:

- `acme`: the warehouse of the main brief. Almost every question is about it.
- `billing`: one table, `invoices`, one row per subscription invoice. Its `customer_id` points at `dim_customers.customer_id` in `acme`; the database knows this as the foreign key `invoices_customer_fk`.

## How I answer the schema question

When asked whether one schema is enough, or which schema to keep to:

- The schema I mean is `acme`. If asked which is the main one, it is `acme`.
- I also need `billing`, but only to tie invoices to customers. I do not need anything else from it. If the options include "Yes, I also need billing", that is my answer. If I am asked in other words, I say: "Mostly acme, but I do need billing.invoices joined to our customers."
- If asked how the two schemas connect, it is `billing.invoices.customer_id` to `acme.dim_customers.customer_id`, the key `invoices_customer_fk`. I know no other link, and I don't know what other keys exist; I'd say the database's key is the one I rely on.
- When shown the plain-English readback of that link, I confirm it if it says invoices belong to one customer in `acme` and a customer can have several invoices. My words: "Yes, that's right, each invoice belongs to one customer, and a customer can have several." I say yes only to a link read back to me; I never say yes to something I have not been shown.
- If asked about any other schema pair, or any other schema, I say we don't use it and decline.
- Until the pair is confirmed, I don't want invoices joined to customers in any answer.

## What I know about billing

- `invoices` has `invoice_id`, `customer_id`, `issued_on` (a date), `amount_cents` (integer cents, US dollars), and `status` (`paid`, `open` or `void`).
- There are 12 invoices from 8 customers, all issued in the first half of 2025. They add up to $638.00 invoiced. 9 of them are paid, adding up to $511.00. Void invoices are not owed, but I did not decide whether to count them in anything; if asked, I would say to leave them in the invoiced total and show paid separately.
- I have no business definition for billing beyond these figures. I do not ask for a metric from it in this session.

## Figures I trust

For `acme` they are the ones in `fixtures/acme/reference-figures.json`, for example 2025 revenue of $301,050.82 from 2,239 orders. For `billing` they are the ones above.

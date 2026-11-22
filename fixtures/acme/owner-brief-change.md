# Owner brief, a change round: Dana Ruiz, Head of Analytics, Acme

This is an addition to `fixtures/acme/owner-brief.md` for a run on a layer that is already built and approved over the Acme warehouse, schema `acme`. Play Dana as that brief describes, answer everything it covers from it, and use this file only for the change below. Acme and all of its data are synthetic.

When a question is not covered, say you don't know or would need to check; don't invent a rule. When you are shown a plain-English readback that matches this brief, confirm it; when it doesn't, say exactly what is wrong.

## What I ask for

I ask for two changes in one message, in my own words: "Two things. Please add shipping charged as a metric, and change revenue so that it only counts delivered orders."

### One added metric: shipping charged

- **Shipping charged**: the sum of `fct_orders.shipping_cents` / 100 over the same orders that count toward revenue (status `completed` or `shipped`, test accounts excluded, orders of deleted customers kept), dated by when the order was placed (`created_at`, UTC). US dollars.
- For 2025 it is $4,443.33, over the same 2,239 orders as today's revenue.
- It is not revenue. It does not change revenue or net revenue.

### One changed definition: revenue

- **Revenue now**: the sum of `amount_cents` / 100 over orders with status `completed` only. `shipped` orders no longer count, until they are marked delivered. Everything else in the definition stays: test accounts are excluded, orders of deleted customers count, shipping is not revenue, dated by `created_at` in UTC.
- Order count and average order value follow the same orders, so they change with it. Refunds and net revenue follow too, since refunds are taken from the orders that count.
- For 2025 it changes as follows:
  - Revenue before: $301,050.82 from 2,239 orders. This is the figure in `fixtures/acme/reference-figures.json`.
  - Revenue after: $265,895.89 from 1,975 orders.
- I expect the old figure to move to the new one and I want to be told which saved checks, if any, no longer match. I do not know which ones those are; I'd ask the agent to list them.

## How I answer

- If asked whether to keep the old definition under another name, I say no, change it, but tell me what moved.
- If asked whether shipping charged needs a split, I say no: one figure.
- When shown the new definitions read back, I confirm them if they say what is above. I never say yes to something I have not been shown.
- I make no other change in this session. If the agent proposes one, I decline it.

# semantic-layer-builder

Build a semantic layer for your data by talking it through with Claude, in your terminal.

A semantic layer is a small set of plain files that say what your data means: what each table holds, how a number such as revenue is calculated, how tables join, and who may see what. Tools that answer questions about your data, such as a chat-with-your-data assistant, a text-to-SQL agent or a BI tool, give better answers when they read one.

This is a plugin for [Claude Code](https://code.claude.com/docs/en/setup). Claude measures your tables with a small read-only command, `semlayer`, asks you only what the data cannot tell it, reads each definition back in plain English, and records it only when you say yes.

## What you get

- **Plain YAML files** you review and commit like code. Nothing lives in a hosted service.
- **Definitions you approved.** Every table, number and join is read back to you, and none is marked approved without your recorded yes.
- **Questions with confirmed answers.** You give a few figures you already trust ("revenue in 2025 was 1.2M"); the tool reruns them later, so you find out when the data or a definition moves.
- **Access rules.** Personal and sensitive columns are hidden by default, and you decide which roles see what.
- **A database that is only read.** Every query runs read-only, and your connection string stays out of the files and out of the chat.

## Quick start

You need [Claude Code](https://code.claude.com/docs/en/setup) and [Bun](https://bun.sh) 1.4 or later. The [quick start guide](docs/quickstart.md) covers each step below in detail.

**1. Install the plugin**, once, from your shell:

```sh
claude plugin marketplace add PGundy/semantic-layer-builder
claude plugin install semantic-layer-builder@semantic-layer-builder
```

**2. Try it on sample data.** It needs no database and no password. In an empty folder, start `claude` and type `/semlayer demo`. It makes a practice project, `semlayer-demo/`. Then:

```sh
cd semlayer-demo
claude    # then type: /semlayer
```

Claude starts asking about the sample store's data. You play the data owner: the answers are in `OWNER.md`.

**3. Use it on your own database** (Postgres):

1. Ask your database administrator for a read-only role. Claude prints the `GRANT` statements to send them when you ask it to run `semlayer setup --print-role-sql --dialect postgres --schemas <your schema>`.
2. Put the connection in a file named `.env` in your project folder, on one line you write yourself:

   ```sh
   WAREHOUSE_URL=postgres://<user>:<password>@<host>:5432/<database>?sslmode=require
   ```

3. Start `claude` in that folder and type `/semlayer`.

If something does not work, type `/semlayer doctor`. It checks the setup line by line and names the fix for each problem.

## What a session looks like

An abridged, illustrative first session on a Postgres warehouse (the figures are made up); the commands are the ones the agent runs:

```text
> /semlayer
  Which database is it, and where does its read-only connection live?
> Postgres. WAREHOUSE_URL is in .env.
  semlayer setup --source warehouse --dialect postgres --env WAREHOUSE_URL --name acme
  semlayer baseline --source warehouse --json
  Here is what I think your tables are; correct me. 20 tables; 6 look like staging copies.
  1. fct_orders: one row per order, my guess, since order_id appears once in each of 48,210 rows.
  ...
  Stop here or continue?
> Leave out the staging tables. Revenue is completed and shipped orders only.
  ...
  Revenue: order value in dollars for completed and shipped orders. Approve?
> yes
  semlayer reply --readback rb_0004 --answers - --approve
```

The agent measures row counts, keys and join match rates itself and asks you only for meaning. Each definition is read back in plain words and approved only on your yes; a guess is labelled as a guess. Say "stop" at any point: everything is already in files, and `/semlayer` in a later session picks up where you left off (the plugin's session start hook shows a line that says a layer is here, as Claude Code's [hooks documentation](https://code.claude.com/docs/en/hooks) describes for `systemMessage`). Review the files and commit them like code.

## How a build goes

`/semlayer` always continues from where the files stand, so you can do this in one sitting or over several.

| Step | What Claude does | What you do |
|---|---|---|
| 1. Connect | Reads the list of tables and columns | Say which database, and set up the connection |
| 2. Focus | Groups the tables when there are many | Choose the ones that matter |
| 3. Measure and draft | Counts rows, finds keys, drafts a description of each table | Nothing yet |
| 4. Interview | Reads each table, number and join back, a few at a time | Correct it, then say yes |
| 5. Metrics and access | Drafts ratios such as average order value, and who sees what | Decide and approve |
| 6. Confirmed questions | Runs questions whose answers you already know | Confirm the figures match |
| 7. Hand off | Records the layer as version 1.0 | Review the files and commit them |

Later changes are made in small rounds, and only what changed is read back to you.

## Is it safe to point at my database?

- **It only reads.** On Postgres every query runs alone in a read-only transaction. Connect with a SELECT-only role, and the tool warns you when the role can do more.
- **Your password stays yours.** The files name an environment variable, never its value, and the plugin stops the agent reading your `.env`.
- **Personal data is hidden by default.** Columns that look personal or sensitive are shown as `[protected]`. This rests on name rules, so review what the tool saved before you commit it.
- **Nothing is approved without you.** Text found in your data is treated as evidence, never as an instruction or an approval.

The [trust model](docs/reference.md#trust-model) has the full account, limits included.

## Documentation

| If you are | Read |
|---|---|
| Setting it up for the first time | [Quick start guide](docs/quickstart.md) |
| Looking for a command, a file format or a feature | [Reference](docs/reference.md), then the [specification](skills/semantic-layer/references/spec.md) |
| An AI agent, or pointing one at this repository | [Agent quick start](docs/agent-quickstart.md) |
| Checking what the plugin installs | [Plugin details](docs/plugin.md) |
| Changing the code | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Reporting a security problem | [SECURITY.md](SECURITY.md) |

[`examples/acme/`](examples/acme/) holds a finished layer, built end to end on synthetic data, to see what the result looks like.

## Status

This is a first working version.

- **Supported:** Claude Code in the terminal; Postgres 13 to 17; DuckDB and CSV or Parquet files for the demo and sample data.
- **Not supported for new work:** Snowflake, BigQuery, Databricks, Redshift, MySQL and SQL Server. Their code is kept, and [`other-dialects.md`](skills/semantic-layer/references/other-dialects.md) describes it.
- **Tested on:** synthetic data and local Postgres servers, with majors 13 to 17 in CI. A managed Postgres service is proven only once someone records a run against it; [`docs/compat/postgres.md`](docs/compat/postgres.md) gives the steps.

## License

MIT

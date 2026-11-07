# Phase card: scope and focus

Load this card when `sl next` names phase `scope`. It holds focusing a large source, widening scope, and a model whose table left scope. Load `references/scoping.md` with it.

**Checklist:** 1. `sl tables --source <s> --groups`. 2. Preview with `sl scope --source <s> --include <p>`. 3. After the owner confirms, the same command with `--write`. 4. `sl validate`.

```
sl tables --source <s> --json
```

`semantic.yaml` holds `settings.focus_threshold` (12 unless changed). If more tables are in scope than that, **always** ask the owner whether to focus on specific tables before profiling anything. Then:

1. Run `sl tables --source <s> --groups` and summarise it in plain words, alongside the baseline's star-schema sketch and its noise and staging guesses: schemas, common prefixes (`fct_`, `dim_`, `stg_`), suffixes (`_daily`, `_backup`), and tables that look like noise. Its `Suggested scope` line (`suggested_scope` in `--json`) is one combined `sl scope` command: the include-suggested groups, less the noise tables they would catch. Start from it.
2. Offer the default and the choices. Prefer patterns when the owner's rule is a pattern ("all the fact tables": `fct_*`) and exact names when the owner names a few tables (`--tables a,b,c`); with exact names, say that new tables are not picked up automatically.
3. Preview: `sl scope --source <s> --include 'fct_*' --include 'dim_*' --exclude '*_backup'`. Read back the count and names, and preview again after every change unless the owner stated the exact final list.
4. After the owner confirms the final list, rerun the same command with `--write`.

The first scoping message always says tables can be added later with another `sl scope ... --write`. Even under the threshold, confirm that obvious noise is excluded. If the owner wants more tables than `focus_threshold`, `settings.focus_threshold` in `semantic.yaml` is raised to the agreed count (a write without a typed command: `SKILL.md`, Hand edits), then run `sl validate`; otherwise `sl status` keeps asking for focus and `sl draft` refuses. You can also draft one batch at a time with `sl draft --source <s> --tables a,b,c`.

**A model whose table left scope.** The `scope` step also holds while `left_scope_with_models` lists a model: a warning "left scope with approved models" means a modeled table is gone or no longer matches. The model is kept and still served, so ask the owner whether to bring the table back into scope or revoke or remove the model; `next_step.command` previews the tables with `sl scope --source <s> --tables <tables>`.

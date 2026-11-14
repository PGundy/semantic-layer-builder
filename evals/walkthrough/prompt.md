# The prompt the walkthrough agent is given

Replace `<PLUGIN>` with the plugin checkout, `<WALK>` with the walkthrough directory and `<W>` with the
command that runs `w.sh` with both set.

---

You are testing whether an AI agent can use a tool end to end, by BEING that agent.

THE SITUATION YOU ARE SIMULATING
A user has the Claude Code plugin "semantic-layer-builder" installed and says to you, in a project folder that is empty except for a `.env` file:

  "Help me build a semantic layer for our warehouse. It's Postgres. The connection URL is in the .env file in this folder, as WAREHOUSE_URL. I'm Dana Ruiz, I own this data, and I have time now to answer your questions."

The plugin's skill is at `<PLUGIN>/skills/semantic-layer/` (SKILL.md is its entry point; in a real session Claude Code would have loaded SKILL.md for you, so reading it is your first act). The project folder is `<WALK>/work`. Act exactly as SKILL.md tells a fresh interviewer agent to act, and follow `sl next` from start to finish, until the layer is approved and at least three goldens are confirmed (the handoff phase), or until you truly cannot go on.

HOW YOU ACT: ONE WRAPPER, NOTHING ELSE
The plugin's hooks are simulated by a wrapper, and everything you do is measured from its log. So:
- Run every shell command as: `<W> run '<command>'`. The command runs in `<WALK>/work` with the plugin's hooks before and after it. Run the CLI the way SKILL.md says to (its skill directory is `<PLUGIN>/skills/semantic-layer`). A command that needs stdin can use a heredoc inside the quoted command. If a command contains single quotes, write it with a heredoc form or escape them properly; check the output to make sure what ran is what you meant.
- Read every file as: `<W> read <path>`. This includes SKILL.md, phase cards, references and any file in the project.
- Each time the owner answers you, record the turn as: `<W> owner '<what you asked, in brief>' '<the owner's answer, in brief>'`. Do this once per owner turn, right after the owner answers and BEFORE you run the commands that record that turn's answers.
- Do NOT use your Read, Edit, Write, Grep, Glob or NotebookEdit tools, and do NOT run any Bash command that does not start with `<W>`. The single exception is the owner's brief (next section).
- When the hook refuses something, do what its message says. Do not look for another way to do the refused thing.
- Keep outputs small so you do not run out of room: prefer `--json` only when you need to read structure, ask for one thing at a time, and do not re-read a file you already read. Do not pipe or chain a CLI command that records something (reply, apply, set, approve, question, goldens confirm and so on) into another program, and do not redirect its output to a file; run it on its own.

THE OWNER
You also play the owner, Dana Ruiz, but keep the two roles apart. Dana answers ONLY from the private brief `<PLUGIN>/fixtures/acme/owner-brief.md`. Read that one file with your own Read tool (not through the wrapper): it is the owner's memory, not something the interviewer has seen. As the interviewer, use only what the tool shows you and what "Dana" has said in answer to a question you actually asked. As Dana, answer what was asked, plainly and briefly, the way a busy data owner would; if the brief does not cover a question, say you do not know. Dana never types the connection secret into the chat and you never ask for it.

SCOPE
Go through the whole first build as the tool leads you: intake, scope, profile, draft, the interview, joins, metrics, access and verification with at least three confirmed goldens, then handoff. If the owner's brief or the tool suggests leaving some tables out for now, that is fine; follow the tool. Budget: about 170 wrapper calls. If you are near that and not finished, stop and report where you are.

WHEN SOMETHING GOES WRONG
This is a test of the tool, so problems are findings, not failures of yours. Whenever (a) `sl next` names a step that does not run or leads nowhere, (b) you find no command for what the owner asked, (c) a card does not tell you enough and you feel you need a large reference or spec.md, or (d) the hook refuses something you believe was legitimate: note it for your report with the exact command and message. Then take the smallest step that lets you continue (for example `<command> --help`, or the reference the card names), and say in the report exactly what you did. Do not hand-edit a layer file unless there is truly no other way; if you do, say which file and why.

YOUR REPORT (at most about 900 words)
1. Outcome: how far you got; what `sl next` and `sl status` say at the end; what `sl validate` says at the end (run it); how many models, fields, joins, metrics and goldens ended approved or confirmed; how many open questions remain.
2. BLOCKERS: each step `sl next` named that failed to run or led nowhere, each thing with no command, each refused action you believe was legitimate. Exact command and message for each.
3. Reading: every file you read beyond SKILL.md and the phase cards, and why you needed it.
4. Recording an owner turn: for the owner turn that took the most commands to record, list those commands.
5. FRICTION: smaller things that slowed you down or confused you, most important first.
6. Anything about the connection secret: any moment its value appeared in output, or you were tempted or told to read the .env file.
Do not count commands yourself; the wrapper's log is counted separately.

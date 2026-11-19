#!/usr/bin/env bash
# w.sh: runs one tool call the way Claude Code would with the semantic-layer plugin installed, and logs it.
# The agent under test acts only through this script, so the plugin's hooks see every call and the log
# is the record that count.ts counts. WALK is the walkthrough directory (the project is $WALK/work) and
# PLUGIN the plugin checkout.
#
#   w.sh run '<shell command>'        the Bash tool: PreToolUse hook, the command (with the plugin's bin/
#                                     last on PATH, so a bare semlayer runs), PostToolUse hook
#   w.sh read <file>                  the Read tool: PreToolUse hook, then the file's text
#   w.sh owner '<question>' '<answer>'   records one owner turn (no command runs)
#
# Every call is logged under $WALK/log as NNNN.json (what ran, exit code, bytes) and NNNN.out (its output).
set -u
WALK=${WALK:?set WALK to the walkthrough directory}
PLUGIN=${PLUGIN:?set PLUGIN to the plugin checkout}
WORK=$WALK/work
LOG=$WALK/log
ROLE=${WALK_ROLE:-semlayer-interviewer}
export CLAUDE_PLUGIN_ROOT=$PLUGIN CLAUDE_PLUGIN_DATA=$WALK/plugin-data CLAUDE_PROJECT_DIR=$WORK
export TMPDIR=$WALK/tmp
unset PG_URL WAREHOUSE_URL SEMANTIC_ROOT SEMLAYER_ENV_FILE 2>/dev/null
mkdir -p "$LOG" "$CLAUDE_PLUGIN_DATA" "$TMPDIR" "$WORK"
HOOKS=$PLUGIN/skills/semantic-layer/scripts/hooks

n=$(( $(ls "$LOG" 2>/dev/null | grep -c '\.json$') + 1 ))
id=$(printf '%04d' "$n")
kind=${1:?run, read or owner}; shift

# The hash of every file under the semantic root, to tell whether a call changed the layer.
tree() { (cd "$WORK" 2>/dev/null && find semantic -type f 2>/dev/null | LC_ALL=C sort | xargs -r sha256sum 2>/dev/null | sha256sum | cut -c1-16); }

record() { # kind text exit bytes refused changed
  bun -e 'const [f,kind,text,code,bytes,refused,changed,extra]=process.argv.slice(1); await Bun.write(f, JSON.stringify({kind,text,exit:Number(code),bytes:Number(bytes),refused:refused==="1",changed_layer:changed==="1",...(extra?JSON.parse(extra):{})})+"\n")' \
    "$LOG/$id.json" "$@"
}

hook() { # event tool input-json  -> prints the hook's stderr, returns its exit code
  local payload
  payload=$(bun -e 'const [event,tool,input,cwd,id,role]=process.argv.slice(1); console.log(JSON.stringify({hook_event_name:event,session_id:"walk-1",tool_use_id:id,agent_type:role,cwd,tool_name:tool,tool_input:JSON.parse(input)}))' "$1" "$2" "$3" "$WORK" "w_$id" "$ROLE")
  local script=$HOOKS/guard-edits.ts
  [ "$1" = PreToolUse ] || script=$HOOKS/integrity.ts
  (cd "$WORK" && printf '%s' "$payload" | bun "$script" 2>&1 >/dev/null)
}

case $kind in
  owner)
    q=${1:?question}; a=${2:?answer}
    printf 'OWNER TURN\nQ: %s\nA: %s\n' "$q" "$a" > "$LOG/$id.out"
    record owner "$q" 0 "${#a}" 0 0
    echo "owner turn recorded as $id"
    ;;
  read)
    file=${1:?file}
    abs=$(cd "$WORK" && realpath -m "$file")
    input=$(bun -e 'console.log(JSON.stringify({file_path:process.argv[1]}))' "$abs")
    msg=$(hook PreToolUse Read "$input"); rc=$?
    if [ $rc -eq 2 ]; then
      printf '%s\n' "$msg" | tee "$LOG/$id.out"
      record read "$abs" 2 0 1 0
      exit 2
    fi
    if [ ! -f "$abs" ]; then echo "no such file: $abs" | tee "$LOG/$id.out"; record read "$abs" 1 0 0 0; exit 1; fi
    cat "$abs" | tee "$LOG/$id.out"
    record read "$abs" 0 "$(wc -c < "$abs")" 0 0
    ;;
  run)
    cmd=${1:?command}
    input=$(bun -e 'console.log(JSON.stringify({command:process.argv[1]}))' "$cmd")
    msg=$(hook PreToolUse Bash "$input"); rc=$?
    if [ $rc -eq 2 ]; then
      printf '%s\n' "$msg" | tee "$LOG/$id.out"
      record run "$cmd" 2 0 1 0
      exit 2
    fi
    before=$(tree)
    # Claude Code puts the plugin's bin/ on the PATH of the Bash tool's shell, after the user's own entries.
    (cd "$WORK" && PATH="$PATH:$PLUGIN/bin" bash -c "$cmd") > "$LOG/$id.out" 2>&1; code=$?
    after=$(tree)
    event=PostToolUse; [ $code -eq 0 ] || event=PostToolUseFailure
    post=$(hook "$event" Bash "$input"); prc=$?
    cat "$LOG/$id.out"
    [ $code -eq 0 ] || echo "[exit code $code]"
    if [ $prc -eq 2 ]; then printf '%s\n' "$post" | tee -a "$LOG/$id.out"; fi
    changed=0; [ "$before" = "$after" ] || changed=1
    record run "$cmd" "$code" "$(wc -c < "$LOG/$id.out")" 0 "$changed" "{\"undone\":$([ $prc -eq 2 ] && echo true || echo false)}"
    exit $code
    ;;
  *) echo "usage: w.sh run '<command>' | read <file> | owner '<question>' '<answer>'"; exit 64 ;;
esac

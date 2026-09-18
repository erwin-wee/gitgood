#!/bin/sh
# GitGood review plugin, session-start hook (Claude Code and Codex read it from
# hooks/hooks.json). Prints one line when the current repository has open AI
# review findings exported by GitGood, and nothing otherwise. Needs only a
# POSIX shell and git; uses node to count when available, grep when not.
set -u
dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0
case "$dir" in
  /*|[A-Za-z]:*) ;;
  *) dir="$(pwd)/$dir" ;;
esac
file="$dir/gitgood/review/latest.json"
[ -f "$file" ] || exit 0

count=""
if command -v node >/dev/null 2>&1; then
  count=$(node -e 'const d = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(d.findings.filter((f) => !f.dismissed).length);' "$file" 2>/dev/null) || count=""
fi
if [ -z "$count" ]; then
  # The export is pretty-printed with two-space indentation, so each live finding has exactly one such line.
  count=$(grep -c '"dismissed": false' "$file" 2>/dev/null) || count=0
fi
case "$count" in
  ''|*[!0-9]*) exit 0 ;;
esac
[ "$count" -gt 0 ] || exit 0

if [ "$count" -eq 1 ]; then plural=""; else plural="s"; fi
echo "GitGood has $count open AI review finding$plural for this repository in $file. Run /gitgood-review (skill: gitgood-review) to fix them and ask GitGood to re-review."
exit 0

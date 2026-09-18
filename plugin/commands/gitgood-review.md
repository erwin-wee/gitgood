---
description: Fix the AI review findings GitGood exported for this repository, then ask GitGood to re-review.
---

Use the `gitgood-review` skill. Read `$(git rev-parse --git-dir)/gitgood/review/latest.json`, fix every finding that is not dismissed in severity order and one file at a time, do not commit, then run the `rerun.command` from that file and report which findings the re-review confirms as fixed.

$ARGUMENTS

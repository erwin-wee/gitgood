# Tasks

## 1. Shared contract

- [x] 1.1 Add `Issue`, `IssueComment`, `IssueFilter`, `IssueTemplate` types and the `gh.issue.*`, `gh.labels`, `gh.milestones` methods to `src/shared/types.ts` and `src/shared/ipc.ts`; verify `npm run typecheck` passes with stub handlers
- [x] 1.2 Add `issueFilters` per-repository persistence to the app state in `src/main/store.ts`; verify a filter written for one repo is read back after restart in a unit test

## 2. Main process

- [x] 2.1 Implement `gh issue list` argument builder from `IssueFilter` and the list/view/create/setState/comment wrappers in `src/main/gh/gh.ts` using stdin for bodies; verify argument shapes with a stubbed `gh` test
- [x] 2.2 Implement `gh label list` and `gh api …/milestones` wrappers; verify parsing with canned JSON
- [x] 2.3 Implement issue template discovery and YAML front matter parsing; verify with unit tests covering `name/about/title/labels` and templates without front matter
- [x] 2.4 Classify rate-limit responses (403 with reset header) into the existing error classification; verify with a unit test on sample stderr
- [x] 2.5 Register the IPC handlers in `src/main/ipc.ts`; verify handlers respond through the preload bridge in a smoke run

## 3. Renderer

- [x] 3.1 Build the Issues dialog (filter bar, list, detail pane, comments) with loading, empty, error, signed-out, disabled-issues and rate-limited states; verify each state renders with stubbed data
- [x] 3.2 Implement *Reference in commit* (append to commit description), *Create branch for issue* (slugified pre-fill), copy actions and *Open on GitHub*; verify slugify unit tests and a smoke dump of the commit description
- [x] 3.3 Implement close/reopen with a one-time confirmation and in-place row update, and the comment form; verify via stubbed `gh` that the correct commands run and the row state changes
- [x] 3.4 Build the New Issue form with template dropdown, labels and assignees; verify creation toast links to the returned URL
- [x] 3.5 Add the fork toggle *Show parent repository issues*; verify actions target the parent when enabled
- [x] 3.6 Wire entry points: Repository menu item and shortcut in `src/main/menu.ts`, commit-form `#` button, branch dialog link; verify each opens the dialog

## 4. Verification

- [x] 4.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 4.2 Smoke pass with a stubbed `gh` on PATH: open the dialog, screenshot list and detail, dump the selected issue; verify screenshots show filters, chips and detail
- [x] 4.3 Update README Features to mention the Issues dialog; verify the section reads correctly

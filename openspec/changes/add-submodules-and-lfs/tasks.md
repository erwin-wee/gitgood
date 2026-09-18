# Tasks

## 1. Shared contract

- [x] 1.1 Add `Submodule`, `LfsStatus`, `LfsFile`, the `lfs` diff kind, `lfs` flags on file entries, `RepositoryInfo.parentRepoId`, `ToolsState.gitLfs` and the `repo.submodules`, `git.submodule.*`, `repo.lfs.*`, `git.lfs.*` methods; verify `npm run typecheck`

## 2. Submodules (main process)

- [x] 2.1 Implement `src/main/git/submodules.ts`: status parser (all prefixes, nested paths, describe suffix), `.gitmodules` parser, recorded vs checked-out comparison, relative URL resolution for display; verify with unit tests
- [x] 2.2 Implement update (with `--progress` parsed into progress events and cancellation) and sync; verify with a fixture superproject built from a local bare repo that uninitialized → up to date
- [x] 2.3 Implement open-as-repository registration with `parentRepoId`; verify the repo list nests it

## 3. LFS (main process)

- [x] 3.1 Detect LFS installation and repository usage in `src/main/tools.ts` and `src/main/git/lfs.ts`; verify tools state and `.gitattributes` detection with unit tests
- [x] 3.2 Add pointer detection (with trailing CR) before binary detection in `src/main/git/diff.ts`, emitting the `lfs` diff kind with optional inner image diff; verify unit tests and an image fixture
- [x] 3.3 Implement `ls-files -l -s` and `status --porcelain` parsers, install, track/untrack (stage attributes, preserve line endings), fetch/pull with progress, prune dry-run and real; verify parsers with unit tests and behaviour with LFS-installed fixture tests (skipped when LFS is absent)

## 4. Renderer

- [x] 4.1 Build the Submodules dialog with states and row actions, the post-clone banner, and the enriched diff-pane submodule summary; verify with a fixture screenshot
- [x] 4.2 Build the LFS install banner, file-list chips, the LFS diff summary with Download, and the Git LFS dialog with prune confirmation; verify each state with stubbed data
- [x] 4.3 Wire Repository menu items and the Options → Advanced tool row; verify they open the dialogs

## 5. Verification

- [x] 5.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 5.2 Smoke pass on a fixture clone with a submodule: screenshot the banner and Submodules dialog; verify the screenshot
- [x] 5.3 Update README Features; verify text

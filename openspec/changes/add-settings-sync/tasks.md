# Tasks

## 1. Shared contract

- [x] 1.1 Add `SettingsExport`, `ImportPreview`, the `settings.*` and `app.chooseSavePath` methods and the `settingsSync` app state; verify `npm run typecheck`

## 2. Export and import

- [x] 2.1 Implement the allowlist export builder and file writer in `src/main/store.ts`; verify a unit test that scans exported keys for forbidden fields and that section selection is respected
- [x] 2.2 Implement the import validator (schema version, types, unknown keys → warnings) and preview counts; verify unit tests for valid, newer-schema and malformed files
- [x] 2.3 Implement merge and replace semantics with confirmation flag, backups (retain 5) and missing-repository handling plus other-platform path skipping; verify unit tests on `AppSettings` and a temp user-data directory
- [ ] 2.4 Add the save dialog method in the main process; verify it returns a path in a smoke run

## 3. Gist sync

- [x] 3.1 Implement gist find/create/view/edit/metadata wrappers in `src/main/gh/gh.ts` with stdin content; verify argument shapes and stdin with a stubbed `gh`
- [x] 3.2 Implement enable (reuse or create), status comparison, upload, download, disconnect with optional delete, and missing-gist recovery; verify with stubbed responses including a 404

## 4. Renderer

- [x] 4.1 Build the export dialog (checklist, exclusion note) and import dialog (preview table, Merge/Replace, relocate hint); verify each renders with stubbed previews
- [x] 4.2 Build the sync card with states (signed out, newer local, newer remote, gist missing) and actions; verify stubbed states render
- [x] 4.3 Wire Options → Advanced section and File menu items; verify they open the dialogs

## 5. Verification

- [x] 5.1 Run `npm run typecheck` and `npm test`; verify both pass
- [x] 5.2 Smoke pass: export preferences to a temp file, assert keys, import into a fresh user-data directory and assert the theme applied
- [x] 5.3 Update README; verify text

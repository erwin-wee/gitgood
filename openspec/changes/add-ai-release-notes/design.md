# Design

## Context

See proposal.md. Tags come from `getTags` in `src/main/git/operations.ts`, history parsing from `parseLog` in `src/main/git/log.ts`, PR metadata from `GhClient.prView`, file IO from `repo.readFile` / `repo.writeFile`, and line-ending helpers `splitLines` / `joinLines` exist in `src/shared/util.ts`.

## Goals / Non-Goals

**Goals:**
- Every bullet traceable to a commit or PR in the range; GitGood owns the Markdown structure.
- All writes (changelog, tag, release) behind explicit clicks; draft by default.

**Non-Goals:**
- Publishing to package registries; attaching build assets.
- Training a user-facing/not classifier.

## Decisions

1. **Range gathering in main** (`repo.release.range`): `git describe --tags --abbrev=0 HEAD` for the default From; `git log --no-merges --format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1f%b%x1e <from>..<to>` capped at 500 (subjects only beyond); PR numbers from `git log --merges --format=%s` (`Merge pull request #N`) and from subjects ending in `(#N)`; `gh pr view N --json number,title,labels,author,url` for up to 100 numbers with concurrency 4; `git diff --stat=120 <from>..<to>` capped at 200 lines for context.
2. **The model returns sections and items with refs; GitGood renders Markdown** (`## <version> (<date>)`, `### <section>`, `- text (refs)`). Alternative: free Markdown from the model, rejected because references could not be validated reliably.
3. **Validation**: refs must be a PR number or SHA prefix in range; unknown refs removed; zero-ref items → `unreferenced`; fixed section order; duplicates merged; items ≤ 200 chars; ≤ 6 sections; uncited commits/PRs appended to `unreferenced`.
4. **Changelog insertion** reads the file, splits with `splitLines`, inserts after the first `# ` heading (or creates `# Changelog`), joins with the original EOL. The file is then selected in the Changes tab.
5. **Release creation** via `gh release create <tag> --title <t> --notes-file - [--draft] [--prerelease] [--target <toSha>]` with the body on stdin; `gh release view <tag> --json url` first to detect an existing release.

Schema:

```json
{ "type": "object",
  "properties": { "sections": { "type": "array", "items": { "type": "object",
    "properties": { "title": { "enum": ["Breaking changes", "Features", "Fixes", "Performance", "Docs", "Internal"] },
      "items": { "type": "array", "items": { "type": "object",
        "properties": { "text": { "type": "string" }, "refs": { "type": "array", "items": { "type": "string" } } },
        "required": ["text", "refs"], "additionalProperties": false } } },
    "required": ["title", "items"], "additionalProperties": false } } },
  "required": ["sections"], "additionalProperties": false }
```

Prompt inputs: version, audience, from/to labels, commits (sha, subject, body ≤ 400 chars, PR number), PRs (number, title, labels), diff stat, `truncated`. System intent: factual past-tense bullets, one per user-visible change, ignore version bumps and merge commits, incompatible changes under Breaking changes.

Types and IPC:

```ts
interface ReleaseRange { from; to }
interface ReleaseCommit { sha; shortSha; subject; body; author; date; prNumber: number | null }
interface ReleasePr { number; title; labels: string[]; author; url }
interface ReleaseNotesInput { range; version; audience: 'users' | 'developers'; includePrs: boolean }
interface ReleaseNotes { version; markdown; sections: { title; items: { text; refs: string[] }[] }[]; unreferenced: string[]; truncated: boolean; model }
interface CreateReleaseOptions { tag; title; body; draft; prerelease; targetSha: string | null }
'repo.release.range'(repoPath, range) → { commits, prs, latestTag }
'ai.releaseNotes'(repoPath, input) → ReleaseNotes
'repo.changelog.insert'(repoPath, markdown) → { created: boolean }
'gh.release.create'(repoPath, opts) → { url }
'gh.release.view'(repoPath, tag) → { url } | null
AiSettings.releaseNotesAudience: 'users' | 'developers' (default 'users')
```

## Risks / Trade-offs

- [Invented entries] → reference validation and the unreferenced list.
- [Private PR titles sent to the provider] → first-use data notice; include-PR option can be turned off.
- [Non-semver tags] → version left blank for the user.
- [Tag missing at To] → `--target <sha>` lets `gh` create it; the confirmation states this.
- [CRLF changelog] → EOL detected and preserved on insert.

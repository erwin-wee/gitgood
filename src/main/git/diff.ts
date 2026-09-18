import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { DiffOptions } from '@shared/ipc';
import type { CommitFile, FileDiff, ImagePayload, WorkingFile } from '@shared/types';
import { parseConflicts } from '@shared/diff/conflicts';
import { countDiffLines, parseUnifiedDiff, synthesizeAddedDiff, type ParsedDiff } from '@shared/diff/parse';
import { buildStagePatch, selectAll } from '@shared/diff/patch';
import { imageMediaType, isImagePath, languageFromPath } from '@shared/util';
import { EMPTY_TREE_SHA, type GitClient } from './git';
import { isLfsPointerBuffer, readLfsObject } from './lfs';
import { mergeBase, parseNameStatusZ } from './log';
import { getGitDir } from './status';

/** The pointer spec line every LFS pointer file starts with; checked before binary detection so pointer diffs get their own summary. */
const LFS_POINTER_MARKER = /version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\n/;

const MAX_DIFF_BYTES = 8 * 1024 * 1024;
const MAX_DIFF_LINES = 40_000;
const MAX_CONTENT_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

export function toFsPath(repoPath: string, gitPath: string): string {
  return join(repoPath, ...gitPath.split('/'));
}

export function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8000);
  for (let i = 0; i < len; i++) if (buf[i] === 0) return true;
  return false;
}

function baseDiffArgs(opts: DiffOptions): string[] {
  const args = ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', '--no-relative', `--unified=${opts.context ?? 3}`];
  if (opts.hideWhitespace) args.push('-w');
  return args;
}

export async function readBlob(git: GitClient, repoPath: string, ref: string, path: string): Promise<Buffer | null> {
  const res = await git.tryRun(repoPath, ['show', `${ref}:${path}`], { readOnly: true, maxBuffer: 256 * 1024 * 1024 });
  return res ? res.stdoutBuffer : null;
}

export async function readWorktree(repoPath: string, path: string): Promise<Buffer | null> {
  try {
    const p = toFsPath(repoPath, path);
    const s = await stat(p);
    if (!s.isFile()) return null;
    return await readFile(p);
  } catch {
    return null;
  }
}

function toImage(buf: Buffer | null, path: string): ImagePayload | null {
  if (!buf || buf.length > MAX_IMAGE_BYTES) return null;
  return { mediaType: imageMediaType(path), base64: buf.toString('base64'), bytes: buf.length };
}

function textOrNull(buf: Buffer | null): string | null {
  if (!buf || buf.length > MAX_CONTENT_BYTES || looksBinary(buf)) return null;
  return buf.toString('utf8');
}

export function buildTextDiff(parsed: ParsedDiff, path: string, oldContent: string | null, newContent: string | null): FileDiff {
  const counts = countDiffLines(parsed.hunks);
  if (counts.total > MAX_DIFF_LINES) return { kind: 'too-large', lineCount: counts.total, bytes: 0 };
  const hasCRLF = (newContent ?? oldContent ?? '').includes('\r\n');
  return {
    kind: 'text',
    hunks: parsed.hunks,
    oldPath: parsed.header.oldPath ?? (parsed.header.isNew ? null : path),
    newPath: parsed.header.newPath ?? (parsed.header.isDeleted ? null : path),
    language: languageFromPath(path),
    lineCount: counts.total,
    newContent,
    oldContent,
    hasCRLF,
  };
}

async function submoduleSummary(git: GitClient, repoPath: string, path: string, oldSha: string | null, newSha: string | null): Promise<string> {
  if (!oldSha || !newSha) return newSha ? `Submodule added at ${newSha.slice(0, 7)}` : `Submodule removed`;
  const out = await git.tryRun(toFsPath(repoPath, path), ['log', '--oneline', '--max-count=20', `${oldSha}..${newSha}`], { readOnly: true });
  return out?.stdout.trim() || `Submodule updated ${oldSha.slice(0, 7)} → ${newSha.slice(0, 7)}`;
}

/** Builds the `lfs` diff kind when either side's content is an LFS pointer; null otherwise. */
async function buildLfsDiff(git: GitClient, repoPath: string, path: string, oldBuf: Buffer | null, newBuf: Buffer | null): Promise<FileDiff | null> {
  const oldPtr = isLfsPointerBuffer(oldBuf);
  const newPtr = isLfsPointerBuffer(newBuf);
  if (!oldPtr && !newPtr) return null;
  const gitDir = await getGitDir(git, repoPath);
  const [oldObj, newObj] = await Promise.all([oldPtr ? readLfsObject(gitDir, oldPtr.oid) : null, newPtr ? readLfsObject(gitDir, newPtr.oid) : null]);
  const present = (!oldPtr || !!oldObj) && (!newPtr || !!newObj);
  let inner: FileDiff | null = null;
  if (present && isImagePath(path) && (oldObj || newObj)) {
    inner = { kind: 'image', oldImage: toImage(oldObj, path), newImage: toImage(newObj, path) };
  }
  return { kind: 'lfs', path, oldOid: oldPtr?.oid ?? null, newOid: newPtr?.oid ?? null, size: newPtr?.size ?? oldPtr?.size ?? 0, present, inner };
}

/** Diff between HEAD and the working tree for one file (GitHub Desktop semantics). */
export async function getWorkingDiff(git: GitClient, repoPath: string, file: WorkingFile, opts: DiffOptions): Promise<FileDiff> {
  const path = file.path;
  if (file.conflict) {
    const buf = await readWorktree(repoPath, path);
    if (!buf) return { kind: 'empty', reason: file.conflict === 'deleted-by-us' || file.conflict === 'both-deleted' ? 'This file was deleted on your side.' : 'File is missing from the working tree.' };
    if (looksBinary(buf)) return { kind: 'binary', oldBytes: null, newBytes: buf.length };
    const content = buf.toString('utf8');
    const parsed = parseConflicts(content);
    return { kind: 'conflict', content, lines: parsed.lines, blocks: parsed.blocks, language: languageFromPath(path), oursLabel: parsed.oursLabel, theirsLabel: parsed.theirsLabel };
  }

  if (file.status === 'untracked' || (file.status === 'new' && !file.staged)) {
    const buf = await readWorktree(repoPath, path);
    if (buf === null) return { kind: 'empty', reason: 'File no longer exists.' };
    const pointer = isLfsPointerBuffer(buf);
    if (pointer) {
      const lfsDiff = await buildLfsDiff(git, repoPath, path, null, buf);
      if (lfsDiff) return lfsDiff;
    }
    if (isImagePath(path)) return { kind: 'image', oldImage: null, newImage: toImage(buf, path) };
    if (looksBinary(buf)) return { kind: 'binary', oldBytes: null, newBytes: buf.length };
    if (buf.length > MAX_DIFF_BYTES) return { kind: 'too-large', lineCount: 0, bytes: buf.length };
    const content = buf.toString('utf8');
    return buildTextDiff(synthesizeAddedDiff(path, content), path, null, content);
  }

  const paths = file.oldPath ? [file.oldPath, path] : [path];
  const args = [...baseDiffArgs(opts), 'HEAD', '--', ...paths];
  const result = await git.run(repoPath, args, { readOnly: true, okExitCodes: [1], maxBuffer: 256 * 1024 * 1024 });
  const text = result.stdout;
  if (text.length > MAX_DIFF_BYTES) return { kind: 'too-large', lineCount: text.split('\n').length, bytes: text.length };
  const parsed = parseUnifiedDiff(text);

  if (file.submodule || parsed.header.subproject) {
    const sp = parsed.header.subproject;
    return { kind: 'submodule', oldSha: sp?.oldSha ?? null, newSha: sp?.newSha ?? null, summary: await submoduleSummary(git, repoPath, path, sp?.oldSha ?? null, sp?.newSha ?? null) };
  }

  if (LFS_POINTER_MARKER.test(text)) {
    const [oldBuf, newBuf] = await Promise.all([
      file.status === 'new' ? Promise.resolve(null) : readBlob(git, repoPath, 'HEAD', file.oldPath ?? path),
      file.status === 'deleted' ? Promise.resolve(null) : readWorktree(repoPath, path),
    ]);
    const lfsDiff = await buildLfsDiff(git, repoPath, path, oldBuf, newBuf);
    if (lfsDiff) return lfsDiff;
  }

  if (parsed.header.isBinary || (parsed.hunks.length === 0 && isImagePath(path) && file.status !== 'renamed')) {
    if (isImagePath(path)) {
      const [oldBuf, newBuf] = await Promise.all([file.status === 'new' ? null : readBlob(git, repoPath, 'HEAD', file.oldPath ?? path), file.status === 'deleted' ? null : readWorktree(repoPath, path)]);
      return { kind: 'image', oldImage: toImage(oldBuf, path), newImage: toImage(newBuf, path) };
    }
    const [oldBuf, newBuf] = await Promise.all([readBlob(git, repoPath, 'HEAD', file.oldPath ?? path), readWorktree(repoPath, path)]);
    return { kind: 'binary', oldBytes: oldBuf?.length ?? null, newBytes: newBuf?.length ?? null };
  }

  if (parsed.hunks.length === 0) {
    if (file.status === 'renamed') return { kind: 'empty', reason: `Renamed from ${file.oldPath} with no content changes.` };
    if (parsed.header.oldMode && parsed.header.newMode) return { kind: 'empty', reason: `File mode changed from ${parsed.header.oldMode} to ${parsed.header.newMode}.` };
    if (opts.hideWhitespace) return { kind: 'empty', reason: 'Only whitespace changes; turn off "Hide whitespace changes" to see them.' };
    return { kind: 'empty', reason: 'No changes to display.' };
  }

  const [oldBuf, newBuf] = await Promise.all([
    file.status === 'new' ? Promise.resolve(null) : readBlob(git, repoPath, 'HEAD', file.oldPath ?? path),
    file.status === 'deleted' ? Promise.resolve(null) : readWorktree(repoPath, path),
  ]);
  return buildTextDiff(parsed, path, textOrNull(oldBuf), textOrNull(newBuf));
}

/** Diff of a file within a commit against its first parent. */
export async function getCommitFileDiff(git: GitClient, repoPath: string, sha: string, parents: string[], file: CommitFile, opts: DiffOptions): Promise<FileDiff> {
  const parent = parents.length ? parents[0] : EMPTY_TREE_SHA;
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const result = await git.run(repoPath, [...baseDiffArgs(opts), parent, sha, '--', ...paths], { readOnly: true, okExitCodes: [1], maxBuffer: 256 * 1024 * 1024 });
  return finishRefDiff(git, repoPath, result.stdout, file, parent, sha, opts);
}

async function finishRefDiff(git: GitClient, repoPath: string, text: string, file: CommitFile, oldRef: string, newRef: string, opts: DiffOptions): Promise<FileDiff> {
  const path = file.path;
  if (text.length > MAX_DIFF_BYTES) return { kind: 'too-large', lineCount: text.split('\n').length, bytes: text.length };
  const parsed = parseUnifiedDiff(text);
  if (parsed.header.subproject) {
    const sp = parsed.header.subproject;
    return { kind: 'submodule', oldSha: sp.oldSha, newSha: sp.newSha, summary: await submoduleSummary(git, repoPath, path, sp.oldSha, sp.newSha) };
  }
  if (LFS_POINTER_MARKER.test(text)) {
    const oldPath = file.oldPath ?? path;
    const [oldBuf, newBuf] = await Promise.all([file.status === 'new' ? Promise.resolve(null) : readBlob(git, repoPath, oldRef, oldPath), file.status === 'deleted' ? Promise.resolve(null) : readBlob(git, repoPath, newRef, path)]);
    const lfsDiff = await buildLfsDiff(git, repoPath, path, oldBuf, newBuf);
    if (lfsDiff) return lfsDiff;
  }
  if (parsed.header.isBinary || file.binary) {
    const oldPath = file.oldPath ?? path;
    const [oldBuf, newBuf] = await Promise.all([file.status === 'new' ? null : readBlob(git, repoPath, oldRef, oldPath), file.status === 'deleted' ? null : readBlob(git, repoPath, newRef, path)]);
    if (isImagePath(path)) return { kind: 'image', oldImage: toImage(oldBuf, oldPath), newImage: toImage(newBuf, path) };
    return { kind: 'binary', oldBytes: oldBuf?.length ?? null, newBytes: newBuf?.length ?? null };
  }
  if (parsed.hunks.length === 0) {
    if (file.status === 'renamed') return { kind: 'empty', reason: `Renamed from ${file.oldPath} with no content changes.` };
    if (parsed.header.oldMode && parsed.header.newMode) return { kind: 'empty', reason: `File mode changed from ${parsed.header.oldMode} to ${parsed.header.newMode}.` };
    if (opts.hideWhitespace) return { kind: 'empty', reason: 'Only whitespace changes; turn off "Hide whitespace changes" to see them.' };
    return { kind: 'empty', reason: 'No changes to display.' };
  }
  const [oldBuf, newBuf] = await Promise.all([
    file.status === 'new' ? Promise.resolve(null) : readBlob(git, repoPath, oldRef, file.oldPath ?? path),
    file.status === 'deleted' ? Promise.resolve(null) : readBlob(git, repoPath, newRef, path),
  ]);
  return buildTextDiff(parsed, path, textOrNull(oldBuf), textOrNull(newBuf));
}

/** Diff of one file between two refs using merge-base semantics (`base...head`), as GitHub shows a pull request. */
export async function getRangeFileDiff(git: GitClient, repoPath: string, base: string, head: string, file: CommitFile, opts: DiffOptions): Promise<FileDiff> {
  const paths = file.oldPath ? [file.oldPath, file.path] : [file.path];
  const result = await git.run(repoPath, [...baseDiffArgs(opts), `${base}...${head}`, '--', ...paths], { readOnly: true, okExitCodes: [1], maxBuffer: 256 * 1024 * 1024 });
  const mergeBase = (await git.tryRun(repoPath, ['merge-base', base, head], { readOnly: true }))?.stdout.trim() || base;
  return finishRefDiff(git, repoPath, result.stdout, file, mergeBase, head, opts);
}

/** Text of a blob at a ref, or null when missing or binary. */
export async function readBlobText(git: GitClient, repoPath: string, ref: string, path: string): Promise<string | null> {
  return textOrNull(await readBlob(git, repoPath, ref, path));
}

/** Files changed in a stash (including untracked files stored in the third parent). */
export async function getStashFiles(git: GitClient, repoPath: string, stashRef: string): Promise<CommitFile[]> {
  const tracked = await git.stdout(repoPath, ['diff', '--name-status', '-z', '-M', `${stashRef}^1`, stashRef], { readOnly: true });
  const files = parseNameStatusZ(tracked);
  const untracked = await git.tryRun(repoPath, ['ls-tree', '-r', '--name-only', '-z', `${stashRef}^3`], { readOnly: true });
  if (untracked) {
    for (const p of untracked.stdout.split('\0').filter(Boolean)) files.push({ path: p, oldPath: null, status: 'new', additions: null, deletions: null, binary: false, lfs: false });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return files;
}

export async function getStashFileDiff(git: GitClient, repoPath: string, stashRef: string, path: string, opts: DiffOptions): Promise<FileDiff> {
  const files = await getStashFiles(git, repoPath, stashRef);
  const file = files.find((f) => f.path === path) ?? { path, oldPath: null, status: 'modified' as const, additions: null, deletions: null, binary: false, lfs: false };
  const inUntracked = await git.tryRun(repoPath, ['cat-file', '-e', `${stashRef}^3:${path}`], { readOnly: true });
  if (inUntracked) {
    const buf = await readBlob(git, repoPath, `${stashRef}^3`, path);
    if (!buf) return { kind: 'empty', reason: 'File not found in stash.' };
    if (isImagePath(path)) return { kind: 'image', oldImage: null, newImage: toImage(buf, path) };
    if (looksBinary(buf)) return { kind: 'binary', oldBytes: null, newBytes: buf.length };
    const content = buf.toString('utf8');
    return buildTextDiff(synthesizeAddedDiff(path, content), path, null, content);
  }
  const paths = file.oldPath ? [file.oldPath, path] : [path];
  const result = await git.run(repoPath, [...baseDiffArgs(opts), `${stashRef}^1`, stashRef, '--', ...paths], { readOnly: true, okExitCodes: [1] });
  return finishRefDiff(git, repoPath, result.stdout, file, `${stashRef}^1`, stashRef, opts);
}

/**
 * Stat summary and byte-capped patch text between the merge base of `base`
 * and `head` (i.e. what GitHub would show for a pull request), used to build
 * the AI pull request draft prompt (see src/main/ai/prDraft.ts). Falls back
 * to `base` itself when no merge base can be found (unrelated histories or a
 * ref that does not resolve), so callers still get a best-effort diff rather
 * than an outright failure.
 */
export async function getRangePatch(git: GitClient, repoPath: string, base: string, head: string, maxBytes: number): Promise<{ stat: string; patch: string; truncated: boolean }> {
  const mb = (await mergeBase(git, repoPath, base, head)) ?? base;
  const [statRes, diffRes] = await Promise.all([
    git.tryRun(repoPath, ['diff', '--no-color', '--no-ext-diff', '-M', '--stat=120', `${mb}...${head}`], { readOnly: true, okExitCodes: [1] }),
    git.run(repoPath, ['diff', '--no-color', '--no-ext-diff', '-M', `${mb}...${head}`], { readOnly: true, okExitCodes: [1], maxBuffer: 256 * 1024 * 1024 }),
  ]);
  const patch = diffRes.stdout;
  const truncated = patch.length > maxBytes;
  return { stat: statRes?.stdout ?? '', patch: truncated ? patch.slice(0, maxBytes) : patch, truncated };
}

/**
 * Renders an untracked file's full content as a unified diff patch with the
 * same header shape and line numbering `buildStagePatch` would produce for a
 * real "everything selected" addition (so it round-trips through
 * `parseUnifiedDiffs` identically to a tracked file's patch). Returns null
 * for an empty file.
 */
export function renderAddedFilePatch(path: string, content: string): string | null {
  const synthesized = synthesizeAddedDiff(path, content);
  if (!synthesized.hunks.length) return null;
  return buildStagePatch({ oldPath: null, newPath: path, hunks: synthesized.hunks }, selectAll);
}

/**
 * Raw patch text used for AI commit message generation and pre-commit
 * review: matches exactly what `createCommit` would apply. Files with a
 * partial line selection use `partialPatches` (from `buildStagePatch`)
 * verbatim instead of their whole-file diff; untracked files are rendered
 * with `synthesizeAddedDiff` + `buildStagePatch` so their line numbering is
 * identical to a real "everything added" patch (and round-trips through
 * `parseUnifiedDiffs`).
 */
export async function getPatchForFiles(git: GitClient, repoPath: string, files: WorkingFile[], maxBytes: number, partialPatches: Record<string, string> = {}, baseRef = 'HEAD'): Promise<{ patch: string; truncated: boolean; stat: string }> {
  const isPartial = (p: string) => Object.prototype.hasOwnProperty.call(partialPatches, p);
  const tracked = files.filter((f) => f.status !== 'untracked' && !f.conflict && !isPartial(f.path)).flatMap((f) => (f.oldPath ? [f.oldPath, f.path] : [f.path]));
  const partial = files.filter((f) => f.status !== 'untracked' && !f.conflict && isPartial(f.path));
  const untracked = files.filter((f) => f.status === 'untracked');
  let patch = '';
  if (tracked.length) {
    const res = await git.run(repoPath, ['diff', '--no-color', '--no-ext-diff', '--src-prefix=a/', '--dst-prefix=b/', '-M', baseRef, '--', ...tracked], { readOnly: true, okExitCodes: [1] });
    patch += res.stdout;
  }
  for (const f of partial) {
    patch += `\n${partialPatches[f.path]}`;
  }
  for (const f of untracked) {
    const buf = await readWorktree(repoPath, f.path);
    if (!buf || looksBinary(buf)) {
      patch += `\ndiff --git a/${f.path} b/${f.path}\nnew file (binary or unreadable)\n`;
      continue;
    }
    const content = buf.toString('utf8');
    const rendered = renderAddedFilePatch(f.path, content);
    patch += rendered ? `\n${rendered}` : `\ndiff --git a/${f.path} b/${f.path}\nnew file mode 100644\n--- /dev/null\n+++ b/${f.path}\n(empty file)\n`;
  }
  const statRes = tracked.length ? await git.tryRun(repoPath, ['diff', '--stat=120', baseRef, '--', ...tracked], { readOnly: true, okExitCodes: [1] }) : null;
  const stat = (statRes?.stdout ?? '') + [...partial, ...untracked].map((f) => ` ${f.path} | ${f.status === 'untracked' ? 'new file' : 'partial'}`).join('\n');
  const truncated = patch.length > maxBytes;
  return { patch: truncated ? patch.slice(0, maxBytes) : patch, truncated, stat };
}

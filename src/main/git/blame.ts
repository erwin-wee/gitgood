import type { BlameHunk, BlameResult, FileAtCommitResult, Identity } from '@shared/types';
import { BLAME_MAX_LINES, FILE_AT_COMMIT_MAX_BYTES } from '@shared/types';
import { languageFromPath } from '@shared/util';
import type { GitClient } from './git';
import { looksBinary, readBlob, readWorktree } from './diff';

const HEADER_RE = /^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/;

interface CommitMeta {
  author: Identity;
  committer: Identity;
  summary: string;
  previousSha: string | null;
  filename: string;
}

/** Converts git's `<epoch-seconds> <+/-HHMM>` pair into a strict ISO 8601 string, matching `%aI`/`%cI` elsewhere. */
function toIso(epochSeconds: string, tz: string): string {
  const ms = parseInt(epochSeconds, 10) * 1000;
  if (Number.isNaN(ms)) return '';
  const m = /^([+-])(\d{2})(\d{2})$/.exec(tz);
  const sign = m?.[1] === '-' ? -1 : 1;
  const hh = m ? parseInt(m[2], 10) : 0;
  const mm = m ? parseInt(m[3], 10) : 0;
  const offsetMs = sign * (hh * 60 + mm) * 60_000;
  const local = new Date(ms + offsetMs);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const offsetStr = `${sign < 0 ? '-' : '+'}${pad(hh)}:${pad(mm)}`;
  return `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}${offsetStr}`;
}

/**
 * Parses `git blame --porcelain` output into one BlameHunk per contiguous run
 * of lines attributed to the same commit. Per-commit metadata (author,
 * summary, previous/filename headers) is only emitted by git the first time a
 * commit is seen in the stream, so it is cached here and reused for later
 * runs from the same commit.
 */
export function parseBlamePorcelain(output: string): BlameHunk[] {
  const lines = output.split('\n');
  const commitMeta = new Map<string, CommitMeta>();
  const hunks: BlameHunk[] = [];
  let i = 0;

  while (i < lines.length) {
    const header = HEADER_RE.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    const sha = header[1];
    const resultLine = parseInt(header[3], 10);
    const numLines = header[4] !== undefined ? parseInt(header[4], 10) : null;
    i++;

    const draft: Record<string, string> = {};
    while (i < lines.length && !lines[i].startsWith('\t')) {
      const line = lines[i];
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? '' : line.slice(sp + 1);
      switch (key) {
        case 'author':
        case 'author-mail':
        case 'author-time':
        case 'author-tz':
        case 'committer':
        case 'committer-mail':
        case 'committer-time':
        case 'committer-tz':
        case 'summary':
        case 'previous':
        case 'filename':
          draft[key] = value;
          break;
        default:
          break; // 'boundary' and other unrecognized porcelain lines are ignored.
      }
      i++;
    }
    if (i < lines.length && lines[i].startsWith('\t')) i++; // consume the content line; its text is not needed here.

    const existing = commitMeta.get(sha);
    const previous = draft.previous ? draft.previous.split(' ')[0] : null;
    const meta: CommitMeta = {
      author: {
        name: draft.author ?? existing?.author.name ?? '',
        email: (draft['author-mail'] ?? existing?.author.email ?? '').replace(/^<|>$/g, ''),
        date: draft['author-time'] ? toIso(draft['author-time'], draft['author-tz'] ?? '+0000') : existing?.author.date ?? '',
      },
      committer: {
        name: draft.committer ?? existing?.committer.name ?? '',
        email: (draft['committer-mail'] ?? existing?.committer.email ?? '').replace(/^<|>$/g, ''),
        date: draft['committer-time'] ? toIso(draft['committer-time'], draft['committer-tz'] ?? '+0000') : existing?.committer.date ?? '',
      },
      summary: draft.summary ?? existing?.summary ?? '',
      previousSha: previous ?? existing?.previousSha ?? null,
      filename: draft.filename ?? existing?.filename ?? '',
    };
    commitMeta.set(sha, meta);

    if (numLines !== null) {
      hunks.push({
        sha,
        shortSha: sha.slice(0, 7),
        author: meta.author,
        summary: meta.summary,
        originalPath: meta.filename,
        startLine: resultLine,
        lineCount: numLines,
        previousSha: meta.previousSha,
      });
    }
  }

  hunks.sort((a, b) => a.startLine - b.startLine);
  return hunks;
}

export async function getBlame(git: GitClient, repoPath: string, path: string, rev: string | null, ignoreWhitespace: boolean): Promise<BlameHunk[]> {
  const args = ['blame', '--porcelain', '-M', '-C'];
  if (ignoreWhitespace) args.push('-w');
  if (rev) args.push(rev);
  args.push('--', path);
  const out = await git.stdout(repoPath, args, { readOnly: true, maxBuffer: 256 * 1024 * 1024 });
  return parseBlamePorcelain(out);
}

async function isShallowRepository(git: GitClient, repoPath: string): Promise<boolean> {
  const out = await git.tryRun(repoPath, ['rev-parse', '--is-shallow-repository'], { readOnly: true });
  return out?.stdout.trim() === 'true';
}

function countLines(content: string): number {
  if (content === '') return 0;
  const trailingNewline = /\r?\n$/.test(content);
  const n = content.split(/\r?\n/).length;
  return trailingNewline ? n - 1 : n;
}

/** Builds the full BlameResult for a file at `rev` (or the working tree when null), applying the line/size caps and detecting binary/shallow. */
export async function getBlameResult(git: GitClient, repoPath: string, path: string, rev: string | null, ignoreWhitespace: boolean): Promise<BlameResult> {
  const empty = { path, rev, hunks: [], content: null, language: languageFromPath(path), lineCount: 0, tooLarge: false, binary: false, shallow: false };
  let buf: Buffer | null;
  if (rev) buf = await readBlob(git, repoPath, rev, path);
  else buf = await readWorktree(repoPath, path);
  if (!buf) return empty;
  if (looksBinary(buf)) return { ...empty, binary: true };

  const content = buf.toString('utf8');
  const lineCount = countLines(content);
  const shallow = await isShallowRepository(git, repoPath);
  if (lineCount > BLAME_MAX_LINES) return { ...empty, lineCount, tooLarge: true, shallow };

  const hunks = await getBlame(git, repoPath, path, rev, ignoreWhitespace);
  return { path, rev, hunks, content, language: languageFromPath(path), lineCount, tooLarge: false, binary: false, shallow };
}

export async function readFileAtCommit(git: GitClient, repoPath: string, sha: string, path: string): Promise<FileAtCommitResult> {
  const buf = await readBlob(git, repoPath, sha, path);
  if (!buf) return { content: null, binary: false, bytes: 0 };
  if (looksBinary(buf)) return { content: null, binary: true, bytes: buf.length };
  if (buf.length > FILE_AT_COMMIT_MAX_BYTES) return { content: null, binary: false, bytes: buf.length };
  return { content: buf.toString('utf8'), binary: false, bytes: buf.length };
}

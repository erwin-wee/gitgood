import type { Explanation, ExplainTarget, GitHubRepoRef, HistoryQuery } from './types';
import { EMPTY_HISTORY_QUERY } from './types';

export function basename(p: string): string {
  const normalized = p.replace(/[\\/]+$/, '');
  const idx = Math.max(normalized.lastIndexOf('/'), normalized.lastIndexOf('\\'));
  return idx === -1 ? normalized : normalized.slice(idx + 1);
}

export function dirname(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx === -1 ? '' : p.slice(0, idx);
}

export function extname(p: string): string {
  const base = basename(p);
  const idx = base.lastIndexOf('.');
  return idx <= 0 ? '' : base.slice(idx).toLowerCase();
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif']);

export function isImagePath(p: string): boolean {
  return IMAGE_EXTENSIONS.has(extname(p));
}

export function imageMediaType(p: string): string {
  switch (extname(p)) {
    case '.png':
      return 'image/png';
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    case '.bmp':
      return 'image/bmp';
    case '.ico':
      return 'image/x-icon';
    case '.avif':
      return 'image/avif';
    default:
      return 'application/octet-stream';
  }
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.mts': 'typescript',
  '.cts': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.mjs': 'javascript',
  '.cjs': 'javascript',
  '.json': 'json',
  '.jsonc': 'json',
  '.json5': 'json',
  '.py': 'python',
  '.pyi': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.kts': 'kotlin',
  '.scala': 'scala',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.cxx': 'cpp',
  '.hpp': 'cpp',
  '.hh': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.swift': 'swift',
  '.m': 'objectivec',
  '.mm': 'objectivec',
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'bash',
  '.ps1': 'powershell',
  '.psm1': 'powershell',
  '.bat': 'dos',
  '.cmd': 'dos',
  '.yml': 'yaml',
  '.yaml': 'yaml',
  '.toml': 'ini',
  '.ini': 'ini',
  '.cfg': 'ini',
  '.conf': 'ini',
  '.xml': 'xml',
  '.html': 'xml',
  '.htm': 'xml',
  '.svg': 'xml',
  '.vue': 'xml',
  '.svelte': 'xml',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.md': 'markdown',
  '.markdown': 'markdown',
  '.mdx': 'markdown',
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dart': 'dart',
  '.lua': 'lua',
  '.r': 'r',
  '.pl': 'perl',
  '.pm': 'perl',
  '.groovy': 'groovy',
  '.gradle': 'groovy',
  '.diff': 'diff',
  '.patch': 'diff',
  '.proto': 'protobuf',
  '.cmake': 'cmake',
  '.mk': 'makefile',
  '.make': 'makefile',
  '.tf': 'ini',
  '.hcl': 'ini',
  '.txt': 'plaintext',
  '.lock': 'plaintext',
  '.env': 'bash',
  '.nginx': 'nginx',
  '.ex': 'elixir',
  '.exs': 'elixir',
  '.erl': 'erlang',
  '.hs': 'haskell',
  '.clj': 'clojure',
  '.vb': 'vbnet',
  '.f90': 'fortran',
  '.jl': 'julia',
  '.zig': 'plaintext',
  '.sol': 'plaintext',
};

const LANGUAGE_BY_FILENAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gnumakefile: 'makefile',
  'cmakelists.txt': 'cmake',
  gemfile: 'ruby',
  rakefile: 'ruby',
  podfile: 'ruby',
  'vagrantfile': 'ruby',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.editorconfig': 'ini',
  '.npmrc': 'ini',
  '.prettierrc': 'json',
  '.eslintrc': 'json',
  '.babelrc': 'json',
  'go.mod': 'plaintext',
  'go.sum': 'plaintext',
  'package.json': 'json',
  'tsconfig.json': 'json',
  '.bashrc': 'bash',
  '.zshrc': 'bash',
  '.bash_profile': 'bash',
};

export function languageFromPath(p: string): string | null {
  const name = basename(p).toLowerCase();
  if (LANGUAGE_BY_FILENAME[name]) return LANGUAGE_BY_FILENAME[name];
  if (name.startsWith('dockerfile.')) return 'dockerfile';
  const ext = extname(p);
  return LANGUAGE_BY_EXTENSION[ext] ?? null;
}

/**
 * Parses a GitHub-style remote URL (https or ssh) into owner/name.
 * Works for github.com and GitHub Enterprise hosts.
 */
export function parseRemoteUrl(url: string): GitHubRepoRef | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let m = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)\/(.+?)(?:\.git)?\/?$/i.exec(trimmed);
  if (!m) {
    m = /^(?:[^@]+@)?([^:/]+):(?!\/\/)(.+?)\/(.+?)(?:\.git)?\/?$/.exec(trimmed);
  }
  if (!m) return null;
  const host = m[1].toLowerCase();
  const owner = m[2];
  const name = m[3];
  if (!owner || !name || owner.includes('/') ) return null;
  return { host, owner, name, url: `https://${host}/${owner}/${name}` };
}

export function isGitHubDotCom(ref: GitHubRepoRef | null): boolean {
  return !!ref && (ref.host === 'github.com' || ref.host === 'www.github.com');
}

export function formatRelativeTime(input: string | number | Date, now: number = Date.now()): string {
  const date = input instanceof Date ? input : new Date(input);
  const diffMs = now - date.getTime();
  if (Number.isNaN(diffMs)) return '';
  const seconds = Math.round(diffMs / 1000);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  const years = Math.round(days / 365);
  return `${years} year${years === 1 ? '' : 's'} ago`;
}

export function formatDateTime(input: string | number | Date): string {
  const date = input instanceof Date ? input : new Date(input);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)} ${units[unit]}`;
}

/** Splits text into lines, tolerating CRLF and a trailing newline. */
export function splitLines(text: string): { lines: string[]; eol: '\n' | '\r\n'; trailingNewline: boolean } {
  const eol: '\n' | '\r\n' = /\r\n/.test(text) ? '\r\n' : '\n';
  const trailingNewline = text.endsWith('\n');
  const body = trailingNewline ? text.slice(0, -eol.length) : text;
  const lines = body.length === 0 && trailingNewline ? [''] : body.split(/\r?\n/);
  if (body.length === 0 && !trailingNewline) return { lines: [], eol, trailingNewline };
  return { lines, eol, trailingNewline };
}

export function joinLines(lines: string[], eol: '\n' | '\r\n', trailingNewline: boolean): string {
  const joined = lines.join(eol);
  return trailingNewline ? joined + eol : joined;
}

/** Git co-author trailer parsing. */
export function parseCoAuthors(body: string): { name: string; email: string }[] {
  const out: { name: string; email: string }[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = /^Co-authored-by:\s*(.+?)\s*<([^>]+)>\s*$/i.exec(line.trim());
    if (m) out.push({ name: m[1], email: m[2] });
  }
  return out;
}

export function stripCoAuthorTrailers(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((l) => !/^Co-authored-by:/i.test(l.trim()))
    .join('\n')
    .replace(/\n+$/, '');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function sanitizeBranchName(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[~^:?*[\]\\]/g, '-')
    .replace(/\.\.+/g, '.')
    .replace(/^[-.]+|[-./]+$/g, '')
    .replace(/\/{2,}/g, '/')
    .replace(/@\{/g, '-')
    .replace(/\.lock$/, '');
}

export function isValidBranchName(name: string): boolean {
  if (!name || name === '@' || name.startsWith('-') || name.endsWith('.') || name.endsWith('/')) return false;
  if (/[\s~^:?*[\]\\]/.test(name) || name.includes('..') || name.includes('@{') || name.includes('//')) return false;
  if (name.split('/').some((seg) => seg.startsWith('.') || seg.endsWith('.lock') || seg === '')) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(name)) return false;
  return true;
}

export function compareStrings(a: string, b: string): number {
  return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true });
}

// ---------------------------------------------------------------------------
// GitHub issues
// ---------------------------------------------------------------------------

/**
 * Branch name slug for "Create branch for issue": lowercase, runs of
 * characters outside [a-z0-9] collapsed to a single hyphen, leading/trailing
 * hyphens trimmed, capped at 60 characters total (including the `N-` prefix).
 */
export function issueBranchSlug(number: number, title: string): string {
  const prefix = `${number}-`;
  const maxSlugLen = Math.max(0, 60 - prefix.length);
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxSlugLen)
    .replace(/-+$/g, '');
  return `${prefix}${slug}`;
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>"')\]]+/g;

/**
 * Splits `text` into plain-text and URL segments for a linkified, non-HTML
 * rendering of untrusted GitHub content (issue/comment bodies): the text is
 * never interpreted as Markdown or HTML, only bare URLs become links.
 */
export function linkifyText(text: string): { text: string; url: string | null }[] {
  const parts: { text: string; url: string | null }[] = [];
  let lastIndex = 0;
  for (const m of text.matchAll(URL_PATTERN)) {
    const start = m.index ?? 0;
    if (start > lastIndex) parts.push({ text: text.slice(lastIndex, start), url: null });
    let url = m[0];
    // Trailing punctuation is very likely prose, not part of the URL.
    const trailingMatch = /[.,!?;:]+$/.exec(url);
    if (trailingMatch) url = url.slice(0, -trailingMatch[0].length);
    parts.push({ text: url, url });
    lastIndex = start + url.length;
  }
  if (lastIndex < text.length) parts.push({ text: text.slice(lastIndex), url: null });
  return parts;
}

/** Extracts the other worktree's path from git's "already checked out"/"already used by worktree" error text. */
export function extractWorktreePathFromError(message: string): string | null {
  const m = /is already (?:checked out|used by worktree) at ['"]?([^'"\n]+?)['"]?(?:\r?\n|$)/i.exec(message);
  return m ? m[1].trim() : null;
}

// ---------------------------------------------------------------------------
// History search query syntax: `content:`, `regex:`, `path:`, `author:`,
// `after:`, `before:` and `all:` prefixes, freely mixed with free text. See
// openspec/changes/add-history-content-search/design.md.
// ---------------------------------------------------------------------------

const HISTORY_QUERY_PREFIXES = ['content', 'regex', 'path', 'author', 'after', 'before', 'all'] as const;
type HistoryQueryPrefix = (typeof HISTORY_QUERY_PREFIXES)[number];

/** Splits `text` into whitespace-separated tokens, honoring `"quoted values"` (with `\"` escapes) that may contain spaces. */
function tokenizeHistoryQuery(text: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    while (i < n && /\s/.test(text[i])) i++;
    if (i >= n) break;
    let token = '';
    while (i < n && !/\s/.test(text[i])) {
      if (text[i] === '"') {
        i++;
        while (i < n && text[i] !== '"') {
          if (text[i] === '\\' && text[i + 1] === '"') {
            token += '"';
            i += 2;
            continue;
          }
          token += text[i];
          i++;
        }
        i++; // skip closing quote (or run off the end for an unterminated quote)
      } else {
        token += text[i];
        i++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}

function quoteHistoryQueryValue(value: string): string {
  // A `"` needs quoting even without whitespace: the tokenizer strips an
  // unescaped quote, so `say"hi` would otherwise round-trip to `sayhi`.
  return /[\s"]/.test(value) ? `"${value.replace(/"/g, '\\"')}"` : value;
}

export interface ParsedHistoryQuery {
  query: HistoryQuery;
  /** Remaining text (unrecognized prefixes and plain words), joined with single spaces. */
  freeText: string;
}

/** Parses the History search box's text into a structured `HistoryQuery` plus whatever free text is left over. */
export function parseHistoryQuery(text: string): ParsedHistoryQuery {
  const query: HistoryQuery = { ...EMPTY_HISTORY_QUERY, paths: [] };
  const free: string[] = [];
  for (const token of tokenizeHistoryQuery(text)) {
    const m = /^([A-Za-z]+):([\s\S]*)$/.exec(token);
    if (!m || !(HISTORY_QUERY_PREFIXES as readonly string[]).includes(m[1].toLowerCase())) {
      free.push(token);
      continue;
    }
    const prefix = m[1].toLowerCase() as HistoryQueryPrefix;
    const value = m[2];
    switch (prefix) {
      case 'content':
        if (value) query.content = value;
        break;
      case 'regex':
        if (value) query.diffRegex = value;
        break;
      case 'path':
        if (value) query.paths.push(value);
        break;
      case 'author':
        if (value) query.author = value;
        break;
      case 'after':
        if (value) query.after = value;
        break;
      case 'before':
        if (value) query.before = value;
        break;
      case 'all':
        query.allRefs = true;
        break;
    }
  }
  return { query, freeText: free.join(' ') };
}

/** Inverse of `parseHistoryQuery`: renders a `HistoryQuery` (and optional free text) back to the text-box syntax. */
export function formatHistoryQuery(query: HistoryQuery, freeText = ''): string {
  const parts: string[] = [];
  if (query.content) parts.push(`content:${quoteHistoryQueryValue(query.content)}`);
  if (query.diffRegex) parts.push(`regex:${quoteHistoryQueryValue(query.diffRegex)}`);
  for (const p of query.paths) parts.push(`path:${quoteHistoryQueryValue(p)}`);
  if (query.author) parts.push(`author:${quoteHistoryQueryValue(query.author)}`);
  if (query.after) parts.push(`after:${quoteHistoryQueryValue(query.after)}`);
  if (query.before) parts.push(`before:${quoteHistoryQueryValue(query.before)}`);
  if (query.allRefs) parts.push('all:');
  if (freeText.trim()) parts.push(freeText.trim());
  return parts.join(' ');
}

export function isEmptyHistoryQuery(query: HistoryQuery): boolean {
  return !query.content && !query.diffRegex && query.paths.length === 0 && !query.author && !query.after && !query.before && !query.allRefs;
}

/**
 * Client-side sanity check for a POSIX ERE (git's own regex dialect): only
 * flags unbalanced `(`/`)` and `[`/`]`, since anything subtler is reported by
 * git itself. Returns a friendly message, or null when it looks balanced.
 */
export function checkRegexBrackets(expr: string): string | null {
  let depth = 0;
  let i = 0;
  while (i < expr.length) {
    const c = expr[i];
    if (c === '\\') {
      i += 2;
      continue;
    }
    if (c === '[') {
      // Inside a bracket expression `(`, `)` and `[` are literals, so `[(]` and
      // `[]]` are valid EREs. A `]` is also literal in the first position (after
      // an optional `^`), and `[:class:]`/`[.coll.]`/`[=equiv=]` nest.
      let j = i + 1;
      if (expr[j] === '^') j++;
      if (expr[j] === ']') j++;
      while (j < expr.length && expr[j] !== ']') {
        const kind = expr[j] === '[' ? expr[j + 1] : undefined;
        if (kind === ':' || kind === '.' || kind === '=') {
          const end = expr.indexOf(`${kind}]`, j + 2);
          if (end === -1) return 'Unbalanced brackets in regular expression.';
          j = end + 2;
          continue;
        }
        j++;
      }
      if (j >= expr.length) return 'Unbalanced brackets in regular expression.';
      i = j + 1;
      continue;
    }
    if (c === '(') {
      depth++;
    } else if (c === ')') {
      if (depth === 0) return 'Unbalanced parentheses in regular expression.';
      depth--;
    }
    // A `]` outside a bracket expression is an ordinary literal in POSIX ERE.
    i++;
  }
  if (depth) return 'Unbalanced parentheses in regular expression.';
  return null;
}

/** Maps git's own regex-compile stderr to a friendlier one-line message, or returns it unchanged. */
export function friendlyRegexError(stderr: string): string {
  const line = stderr.split('\n').find((l) => /invalid regex|regex parse error|bad.*regex|unmatched|error compiling/i.test(l)) ?? stderr.split('\n').find((l) => l.trim()) ?? stderr;
  return line.replace(/^fatal:\s*/i, '').trim() || 'Invalid regular expression.';
}

/** Renders an AI diff explanation as Markdown suitable for pasting into a pull request comment. */
export function explanationToMarkdown(explanation: Explanation, target: ExplainTarget): string {
  const sha = target.kind === 'commit' ? target.sha : target.source.kind === 'commit' ? target.source.sha : null;
  const paths = target.kind === 'commit' ? [] : [target.path];
  const parts: string[] = [];
  if (sha) parts.push(`**Commit:** \`${sha}\``);
  if (paths.length) parts.push(`**File:** \`${paths[0]}\``);
  parts.push(`## What changed\n\n${explanation.whatChanged}`);
  if (explanation.why) parts.push(`## Why (inferred)\n\n${explanation.why}`);
  if (explanation.impact) parts.push(`## Impact\n\n${explanation.impact}`);
  if (explanation.watchOutFor.length) parts.push(`## Watch out for\n\n${explanation.watchOutFor.map((w) => `- ${w}`).join('\n')}`);
  if (explanation.truncated) parts.push('_Note: this explanation was produced from a truncated diff._');
  return parts.join('\n\n');
}

/** AI-drafted footer appended to a pull request body only at create time (see the ai-pr-description spec's "Attribution and no automatic submission"). */
export const PR_DRAFT_FOOTER = '_Drafted with AI in GitGood; reviewed before creating._';

/** AI-drafted footer appended to a release body only when it is published to GitHub (see the add-ai-release-notes spec). */
export const RELEASE_NOTES_FOOTER = '_Drafted with AI in GitGood; reviewed before publishing._';

/** Placeholder summary the AI commit splitter inserts for a commit the model left unnamed; the plan dialog keeps Apply disabled until every commit's summary differs from this (see src/main/ai/splitter-core.ts and src/renderer/src/state/split.ts). */
export const SPLIT_SUMMARY_PLACEHOLDER = 'Update files (edit this summary before applying)';

/** Appends `footer` after a blank line, or returns the trimmed body unchanged when `footer` is null (setting off, or the body no longer originates from the draft). */
export function appendDraftFooter(body: string, footer: string | null): string {
  const trimmed = body.trim();
  if (!footer) return trimmed;
  return trimmed ? `${trimmed}\n\n${footer}` : footer;
}

export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T & { cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const wrapped = ((...args: never[]) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn(...args);
    }, ms);
  }) as T & { cancel(): void };
  wrapped.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return wrapped;
}

/** Next-patch suggestion for a semver(-looking) tag (e.g. "v1.2.3" -> "v1.2.4"), or null when the tag is not semver. */
export function suggestNextPatchVersion(tag: string): string | null {
  const m = /^(v)?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(tag.trim());
  if (!m) return null;
  const [, prefix, major, minor, patch] = m;
  return `${prefix ?? ''}${major}.${minor}.${parseInt(patch, 10) + 1}`;
}

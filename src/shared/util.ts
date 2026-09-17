import type { GitHubRepoRef } from './types';

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

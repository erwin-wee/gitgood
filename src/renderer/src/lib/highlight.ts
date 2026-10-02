import hljs from 'highlight.js/lib/core';
import { useEffect, useSyncExternalStore } from 'react';

/** Grammars load on demand (one small chunk each), so the main bundle carries none of them. Keys are the language ids from `languageForPath` (src/shared/util.ts). */
const LANGUAGES: Record<string, () => Promise<{ default: Parameters<typeof hljs.registerLanguage>[1] }>> = {
  bash: () => import('highlight.js/lib/languages/bash'),
  c: () => import('highlight.js/lib/languages/c'),
  clojure: () => import('highlight.js/lib/languages/clojure'),
  cmake: () => import('highlight.js/lib/languages/cmake'),
  cpp: () => import('highlight.js/lib/languages/cpp'),
  csharp: () => import('highlight.js/lib/languages/csharp'),
  css: () => import('highlight.js/lib/languages/css'),
  dart: () => import('highlight.js/lib/languages/dart'),
  diff: () => import('highlight.js/lib/languages/diff'),
  dockerfile: () => import('highlight.js/lib/languages/dockerfile'),
  dos: () => import('highlight.js/lib/languages/dos'),
  elixir: () => import('highlight.js/lib/languages/elixir'),
  erlang: () => import('highlight.js/lib/languages/erlang'),
  fortran: () => import('highlight.js/lib/languages/fortran'),
  go: () => import('highlight.js/lib/languages/go'),
  graphql: () => import('highlight.js/lib/languages/graphql'),
  groovy: () => import('highlight.js/lib/languages/groovy'),
  haskell: () => import('highlight.js/lib/languages/haskell'),
  ini: () => import('highlight.js/lib/languages/ini'),
  java: () => import('highlight.js/lib/languages/java'),
  javascript: () => import('highlight.js/lib/languages/javascript'),
  json: () => import('highlight.js/lib/languages/json'),
  julia: () => import('highlight.js/lib/languages/julia'),
  kotlin: () => import('highlight.js/lib/languages/kotlin'),
  less: () => import('highlight.js/lib/languages/less'),
  lua: () => import('highlight.js/lib/languages/lua'),
  makefile: () => import('highlight.js/lib/languages/makefile'),
  markdown: () => import('highlight.js/lib/languages/markdown'),
  nginx: () => import('highlight.js/lib/languages/nginx'),
  objectivec: () => import('highlight.js/lib/languages/objectivec'),
  perl: () => import('highlight.js/lib/languages/perl'),
  php: () => import('highlight.js/lib/languages/php'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
  protobuf: () => import('highlight.js/lib/languages/protobuf'),
  python: () => import('highlight.js/lib/languages/python'),
  r: () => import('highlight.js/lib/languages/r'),
  ruby: () => import('highlight.js/lib/languages/ruby'),
  rust: () => import('highlight.js/lib/languages/rust'),
  scala: () => import('highlight.js/lib/languages/scala'),
  scss: () => import('highlight.js/lib/languages/scss'),
  sql: () => import('highlight.js/lib/languages/sql'),
  swift: () => import('highlight.js/lib/languages/swift'),
  typescript: () => import('highlight.js/lib/languages/typescript'),
  vbnet: () => import('highlight.js/lib/languages/vbnet'),
  xml: () => import('highlight.js/lib/languages/xml'),
  yaml: () => import('highlight.js/lib/languages/yaml'),
};
hljs.configure({ ignoreUnescapedHTML: true });

const loading = new Set<string>();
const listeners = new Set<() => void>();
let loadedCount = 0;

/** Starts loading `language`'s grammar once; subscribers (see `useLanguageLoaded`) are notified when it is registered. */
function loadLanguage(language: string): void {
  if (loading.has(language) || hljs.getLanguage(language)) return;
  loading.add(language);
  void LANGUAGES[language]()
    .then((m) => {
      hljs.registerLanguage(language, m.default);
      loadedCount++;
      for (const l of listeners) l();
    })
    .catch(() => undefined); // chunk failed to load: the diff simply stays plain text
}

/** True once `language`'s grammar is available; loads it on first use and re-renders the caller when it arrives. Diffs show plain text until then. */
export function useLanguageLoaded(language: string | null): boolean {
  useEffect(() => {
    if (isHighlightable(language)) loadLanguage(language);
  }, [language]);
  useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => loadedCount,
  );
  return language !== null && hljs.getLanguage(language) !== undefined;
}

const MAX_HIGHLIGHT_CHARS = 1_200_000;

export function isHighlightable(language: string | null): language is string {
  return language !== null && Object.hasOwn(LANGUAGES, language);
}

/**
 * Splits highlight.js HTML output into one HTML string per line, re-opening
 * spans that cross line boundaries so each line is self-contained markup.
 */
export function splitHighlightedHtml(html: string): string[] {
  const lines: string[] = [];
  const openTags: string[] = [];
  let current = '';
  let i = 0;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '<') {
      const end = html.indexOf('>', i);
      if (end === -1) {
        current += html.slice(i);
        break;
      }
      const tag = html.slice(i, end + 1);
      if (tag.startsWith('</')) openTags.pop();
      else if (!tag.endsWith('/>')) openTags.push(tag);
      current += tag;
      i = end + 1;
      continue;
    }
    if (ch === '\n') {
      lines.push(current + '</span>'.repeat(openTags.length));
      current = openTags.join('');
      i++;
      continue;
    }
    current += ch;
    i++;
  }
  lines.push(current + '</span>'.repeat(openTags.length));
  return lines;
}

/** Returns per-line HTML for `code`, or null when highlighting is not possible. */
export function highlightToLines(code: string, language: string | null): string[] | null {
  if (!isHighlightable(language) || !hljs.getLanguage(language)) return null;
  if (code.length > MAX_HIGHLIGHT_CHARS) return null;
  try {
    const normalized = code.replace(/\r\n?/g, '\n');
    const result = hljs.highlight(normalized, { language, ignoreIllegals: true });
    const lines = splitHighlightedHtml(result.value);
    // highlight() output has no trailing newline artifact unless the code ended with one.
    if (normalized.endsWith('\n') && lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
    return lines;
  } catch {
    return null;
  }
}

/**
 * Syntax highlighting runs lazily per block of file lines as rows scroll into
 * view, so opening a diff never pays for lines that are not on screen.
 * ponytail: block boundaries can split a multi-line token (a block comment),
 * mis-colouring a few lines at the seam; highlight whole files in a worker if that matters.
 */
const HIGHLIGHT_BLOCK_LINES = 400;
/** Blocks with a longer line than this (minified code) are shown unhighlighted: hljs is superlinear on them. */
const HIGHLIGHT_MAX_LINE_CHARS = 5000;

/** HTML for 1-based `lineNo` of `lines`, highlighting (and caching under `cacheKey`) its block on first use. */
export function highlightBlockLine(cache: Map<string, string[] | null>, cacheKey: string, lines: string[], lineNo: number, language: string | null): string | undefined {
  if (lineNo < 1 || lineNo > lines.length) return undefined;
  if (isHighlightable(language) && !hljs.getLanguage(language)) return undefined; // grammar still loading: plain text for now, and not cached (see useLanguageLoaded)
  const block = Math.floor((lineNo - 1) / HIGHLIGHT_BLOCK_LINES);
  const key = `${cacheKey}:${block}`;
  let html = cache.get(key);
  if (html === undefined) {
    const from = block * HIGHLIGHT_BLOCK_LINES;
    const chunk = lines.slice(from, from + HIGHLIGHT_BLOCK_LINES);
    html = chunk.some((l) => l.length > HIGHLIGHT_MAX_LINE_CHARS) ? null : highlightToLines(chunk.join('\n'), language);
    if (html && html.length !== chunk.length) html = null;
    cache.set(key, html);
  }
  return html ? html[(lineNo - 1) % HIGHLIGHT_BLOCK_LINES] : undefined;
}

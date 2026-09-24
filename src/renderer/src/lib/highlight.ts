import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import c from 'highlight.js/lib/languages/c';
import clojure from 'highlight.js/lib/languages/clojure';
import cmake from 'highlight.js/lib/languages/cmake';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import dart from 'highlight.js/lib/languages/dart';
import diff from 'highlight.js/lib/languages/diff';
import dockerfile from 'highlight.js/lib/languages/dockerfile';
import dos from 'highlight.js/lib/languages/dos';
import elixir from 'highlight.js/lib/languages/elixir';
import erlang from 'highlight.js/lib/languages/erlang';
import fortran from 'highlight.js/lib/languages/fortran';
import go from 'highlight.js/lib/languages/go';
import graphql from 'highlight.js/lib/languages/graphql';
import groovy from 'highlight.js/lib/languages/groovy';
import haskell from 'highlight.js/lib/languages/haskell';
import ini from 'highlight.js/lib/languages/ini';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import julia from 'highlight.js/lib/languages/julia';
import kotlin from 'highlight.js/lib/languages/kotlin';
import less from 'highlight.js/lib/languages/less';
import lua from 'highlight.js/lib/languages/lua';
import makefile from 'highlight.js/lib/languages/makefile';
import markdown from 'highlight.js/lib/languages/markdown';
import nginx from 'highlight.js/lib/languages/nginx';
import objectivec from 'highlight.js/lib/languages/objectivec';
import perl from 'highlight.js/lib/languages/perl';
import php from 'highlight.js/lib/languages/php';
import plaintext from 'highlight.js/lib/languages/plaintext';
import powershell from 'highlight.js/lib/languages/powershell';
import protobuf from 'highlight.js/lib/languages/protobuf';
import python from 'highlight.js/lib/languages/python';
import r from 'highlight.js/lib/languages/r';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import scala from 'highlight.js/lib/languages/scala';
import scss from 'highlight.js/lib/languages/scss';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import vbnet from 'highlight.js/lib/languages/vbnet';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';

const LANGUAGES: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  bash, c, clojure, cmake, cpp, csharp, css, dart, diff, dockerfile, dos, elixir, erlang, fortran, go, graphql, groovy, haskell, ini, java, javascript, json, julia, kotlin, less, lua, makefile, markdown, nginx, objectivec, perl, php, plaintext, powershell, protobuf, python, r, ruby, rust, scala, scss, sql, swift, typescript, vbnet, xml, yaml,
};
for (const [name, def] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, def);
hljs.configure({ ignoreUnescapedHTML: true });

const MAX_HIGHLIGHT_CHARS = 1_200_000;

export function isHighlightable(language: string | null): language is string {
  return language !== null && language !== 'plaintext' && hljs.getLanguage(language) !== undefined;
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
  if (!isHighlightable(language)) return null;
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

/** Highlight a single line in isolation (fallback when full content is unavailable). */
export function highlightLine(text: string, language: string | null): string | null {
  if (!isHighlightable(language)) return null;
  try {
    return hljs.highlight(text, { language, ignoreIllegals: true }).value;
  } catch {
    return null;
  }
}

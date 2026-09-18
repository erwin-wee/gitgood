/**
 * GitHub issue template discovery and parsing.
 *
 * Parsing the YAML front matter of a `.github/ISSUE_TEMPLATE/*.md` file is a
 * pure, dependency-free operation (no `yaml` package is added; only a small
 * subset of front matter is used in practice: `name`, `about`, `title` and
 * `labels` as either a comma list or a `-` list). Discovering which files
 * exist on disk is impure and lives in `discoverIssueTemplates`, which is the
 * only part of this module that touches the filesystem.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IssueTemplate } from '@shared/types';

/** Parses one issue template file's front matter and body. Pure. */
export function parseIssueTemplate(content: string, filename: string): IssueTemplate {
  const fallbackName = filename.replace(/\.md$/i, '');
  const isYaml = /\.ya?ml$/i.test(filename);
  if (isYaml) {
    // GitHub "issue forms" YAML templates are not rendered in-app (see design.md's
    // non-goals); surface just enough to list them and let the user open GitHub instead.
    const nameMatch = /^\s*name:\s*(.+)$/im.exec(content);
    const aboutMatch = /^\s*description:\s*(.+)$/im.exec(content);
    return { name: unquote(nameMatch?.[1]) ?? fallbackName, about: unquote(aboutMatch?.[1]), title: null, labels: [], body: '', external: true, filename };
  }
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  if (!match) return { name: fallbackName, about: null, title: null, labels: [], body: content, external: false, filename };
  const [, frontMatter, rest] = match;
  const lines = frontMatter.split(/\r?\n/);
  let name: string | null = null;
  let about: string | null = null;
  let title: string | null = null;
  let labels: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const value = m[2].trim();
    if (key === 'labels' && value === '') {
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s*-\s*/.test(lines[i + 1])) {
        i++;
        items.push(unquote(lines[i].replace(/^\s*-\s*/, '').trim()) ?? '');
      }
      labels = items.filter(Boolean);
      continue;
    }
    if (key === 'name') name = unquote(value);
    else if (key === 'about') about = unquote(value);
    else if (key === 'title') title = unquote(value);
    else if (key === 'labels') labels = value.split(',').map((s) => unquote(s.trim()) ?? '').filter(Boolean);
  }
  return { name: name ?? fallbackName, about, title, labels, body: rest.replace(/^\r?\n/, ''), external: false, filename };
}

function unquote(value: string | undefined | null): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const m = /^["'](.*)["']$/.exec(trimmed);
  return m ? m[1] : trimmed;
}

/** Reads `.github/ISSUE_TEMPLATE/*` (preferred) or the legacy `.github/ISSUE_TEMPLATE.md`, best-effort. */
export async function discoverIssueTemplates(repoPath: string): Promise<IssueTemplate[]> {
  const dir = join(repoPath, '.github', 'ISSUE_TEMPLATE');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && /\.(md|markdown|ya?ml)$/i.test(e.name) && !/^config\.ya?ml$/i.test(e.name)).map((e) => e.name);
    const templates: IssueTemplate[] = [];
    for (const file of files) {
      try {
        const content = await readFile(join(dir, file), 'utf8');
        templates.push(parseIssueTemplate(content, file));
      } catch {
        /* skip unreadable file */
      }
    }
    return templates;
  } catch {
    // No directory; fall back to the legacy single-file template.
    try {
      const content = await readFile(join(repoPath, '.github', 'ISSUE_TEMPLATE.md'), 'utf8');
      return [parseIssueTemplate(content, 'ISSUE_TEMPLATE.md')];
    } catch {
      return [];
    }
  }
}

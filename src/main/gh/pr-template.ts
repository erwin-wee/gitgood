/**
 * Locates the repository's pull request template, if any (the same
 * candidates GitHub itself looks for), so both the `gh.pr.template` IPC
 * handler (used to pre-fill the Create pull request dialog) and the AI PR
 * draft service (src/main/ai/prDraft.ts) read the same file.
 */
import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CANDIDATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'];

export async function findPullRequestTemplate(repoPath: string): Promise<string | null> {
  for (const c of CANDIDATES) {
    const p = join(repoPath, ...c.split('/'));
    if (existsSync(p)) return readFile(p, 'utf8');
  }
  const dir = join(repoPath, '.github', 'PULL_REQUEST_TEMPLATE');
  if (existsSync(dir)) {
    const files = (await readdir(dir)).filter((f) => /\.md$/i.test(f));
    if (files.length) return readFile(join(dir, files[0]), 'utf8');
  }
  return null;
}

/**
 * Locates the repository's pull request template, if any (the same
 * candidates GitHub itself looks for), so both the `gh.pr.template` IPC
 * handler (used to pre-fill the Create pull request dialog) and the AI PR
 * draft service (src/main/ai/prDraft.ts) read the same file.
 */
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { readRepoFile } from '../repo/paths';

const CANDIDATES = ['.github/pull_request_template.md', '.github/PULL_REQUEST_TEMPLATE.md', 'pull_request_template.md', 'PULL_REQUEST_TEMPLATE.md', 'docs/pull_request_template.md', 'docs/PULL_REQUEST_TEMPLATE.md'];

/** Template text from the first candidate that is a regular file inside the repo (symlinks are skipped, see readRepoFile). */
export async function findPullRequestTemplate(repoPath: string): Promise<string | null> {
  for (const c of CANDIDATES) {
    const buf = await readRepoFile(repoPath, c);
    if (buf) return buf.toString('utf8');
  }
  const files = (await readdir(join(repoPath, '.github', 'PULL_REQUEST_TEMPLATE')).catch(() => [] as string[])).filter((f) => /\.md$/i.test(f));
  if (files.length) return (await readRepoFile(repoPath, `.github/PULL_REQUEST_TEMPLATE/${files[0]}`))?.toString('utf8') ?? null;
  return null;
}

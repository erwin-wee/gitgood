/**
 * omp hook factory (loaded from hooks/pre/ of an installed plugin). Injects a
 * one-line system note when the repository has open GitGood review findings,
 * once per session, mirroring hooks/session-start.sh for Claude Code and
 * Codex. Typed through a local interface so the file has no dependency on a
 * specific omp version.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

interface HookApi {
  on(event: string, handler: (event: unknown, ctx: { cwd?: string } | undefined) => unknown): void;
}

interface ExportFile {
  findings?: { dismissed?: boolean }[];
}

/** The note to inject for `cwd`, or null when there is no export or no open finding. */
export function openFindingsNote(cwd: string): string | null {
  let gitDir: string;
  try {
    gitDir = execFileSync('git', ['rev-parse', '--git-dir'], { cwd, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8').trim();
  } catch {
    return null;
  }
  const file = join(isAbsolute(gitDir) ? gitDir : resolve(cwd, gitDir), 'gitgood', 'review', 'latest.json');
  if (!existsSync(file)) return null;
  try {
    const doc = JSON.parse(readFileSync(file, 'utf8')) as ExportFile;
    const count = (doc.findings ?? []).filter((f) => !f.dismissed).length;
    if (!count) return null;
    return `GitGood has ${count} open AI review finding${count === 1 ? '' : 's'} for this repository in ${file}. Use the gitgood-review skill to fix them and ask GitGood to re-review.`;
  } catch {
    return null;
  }
}

export default function gitgoodReviewHook(pi: HookApi): void {
  let announced = false;
  pi.on('before_agent_start', async (_event, ctx) => {
    if (announced) return undefined;
    const note = openFindingsNote(ctx?.cwd ?? process.cwd());
    if (!note) return undefined;
    announced = true;
    return { message: { customType: 'gitgood-review', content: [{ type: 'text', text: note }], display: 'minimal' } };
  });
}

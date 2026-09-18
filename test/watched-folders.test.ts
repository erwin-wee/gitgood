import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalPath, isInside, normalizePath, samePath } from '../src/main/repo/paths';
import { scanFolder } from '../src/main/repo/scan';
import { folderProblem } from '../src/main/repo/watched-folders';

const onWindows = process.platform === 'win32';
/** chmod 000 does not keep root out, and Windows ignores it altogether. */
const canTestUnreadable = !onWindows && typeof process.getuid === 'function' && process.getuid() !== 0;

describe('normalizePath', () => {
  it('strips a trailing separator but keeps the filesystem root', () => {
    expect(normalizePath(`${sep}a${sep}b${sep}`)).toBe(normalizePath(`${sep}a${sep}b`));
    expect(normalizePath(sep)).toBe(normalizePath(sep));
    expect(normalizePath(`${sep}a${sep}b${sep}${sep}`)).toBe(normalizePath(`${sep}a${sep}b`));
  });

  it('collapses . and .. segments', () => {
    expect(normalizePath(`${sep}a${sep}.${sep}b${sep}c${sep}..`)).toBe(normalizePath(`${sep}a${sep}b`));
  });

  it('folds case only on Windows', () => {
    const upper = normalizePath(`${sep}A${sep}B`);
    const lower = normalizePath(`${sep}a${sep}b`);
    if (onWindows) expect(upper).toBe(lower);
    else expect(upper).not.toBe(lower);
  });

  it.runIf(onWindows)('treats C:\\A\\B and c:\\a\\b\\ as the same path', () => {
    expect(samePath('C:\\A\\B', 'c:\\a\\b\\')).toBe(true);
  });

  it.runIf(!onWindows)('keeps case-differing POSIX paths distinct', () => {
    expect(samePath('/A/B', '/a/b')).toBe(false);
    expect(samePath('/a/b', '/a/b/')).toBe(true);
  });
});

describe('isInside', () => {
  it('counts a folder as inside itself', () => {
    expect(isInside(`${sep}a${sep}b`, `${sep}a${sep}b`)).toBe(true);
    expect(isInside(`${sep}a${sep}b${sep}`, `${sep}a${sep}b`)).toBe(true);
  });

  it('matches a descendant at any depth', () => {
    expect(isInside(`${sep}a`, `${sep}a${sep}b${sep}c`)).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix', () => {
    expect(isInside(`${sep}a${sep}b`, `${sep}a${sep}bc`)).toBe(false);
  });

  it('does not match an ancestor', () => {
    expect(isInside(`${sep}a${sep}b`, `${sep}a`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// scanFolder
// ---------------------------------------------------------------------------

const scanDirs: string[] = [];

function tree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'gg-scan-'));
  scanDirs.push(dir);
  return dir;
}

/** Creates a directory holding a `.git` directory, i.e. an ordinary clone. */
function repo(...segments: string[]): string {
  const dir = join(...segments);
  mkdirSync(join(dir, '.git'), { recursive: true });
  return dir;
}

async function scan(root: string, depth: number): Promise<string[]> {
  const result = await scanFolder(root, { depth });
  return result.repositories.sort();
}

afterEach(() => {
  while (scanDirs.length) {
    const dir = scanDirs.pop()!;
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // A chmod 000 directory has to be made readable again before it can go.
      try {
        chmodSync(join(dir, 'locked'), 0o700);
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort */
      }
    }
  }
});

describe('scanFolder', () => {
  it('finds a repository nested two levels down at depth 3', async () => {
    const root = tree();
    const nested = repo(root, 'erwin-wee', 'gitgood');
    mkdirSync(join(root, 'erwin-wee', 'notes'), { recursive: true });
    expect(await scan(root, 3)).toEqual([nested]);
  });

  it('reports the root itself when the root is a repository', async () => {
    const root = tree();
    mkdirSync(join(root, '.git'));
    expect(await scan(root, 3)).toEqual([root]);
  });

  it('does not reach level 2 at depth 1', async () => {
    const root = tree();
    repo(root, 'erwin-wee', 'gitgood');
    expect(await scan(root, 1)).toEqual([]);
  });

  it('reaches an immediate child at depth 1', async () => {
    const root = tree();
    const direct = repo(root, 'gitgood');
    expect(await scan(root, 1)).toEqual([direct]);
  });

  it('does not descend into a repository, so a submodule is not reported separately', async () => {
    const root = tree();
    const main = repo(root, 'main');
    mkdirSync(join(main, 'vendored'), { recursive: true });
    writeFileSync(join(main, 'vendored', '.git'), 'gitdir: ../.git/modules/vendored');
    expect(await scan(root, 5)).toEqual([main]);
  });

  it('treats a .git file as a repository (linked worktree)', async () => {
    const root = tree();
    const wt = join(root, 'feature');
    mkdirSync(wt, { recursive: true });
    writeFileSync(join(wt, '.git'), 'gitdir: /elsewhere/.git/worktrees/feature');
    expect(await scan(root, 2)).toEqual([wt]);
  });

  it('never reports a bare repository', async () => {
    const root = tree();
    const bare = join(root, 'bare.git');
    mkdirSync(join(bare, 'objects'), { recursive: true });
    mkdirSync(join(bare, 'refs'), { recursive: true });
    writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main');
    expect(await scan(root, 3)).toEqual([]);
  });

  it('skips node_modules, other excluded names and dot-directories', async () => {
    const root = tree();
    repo(root, 'node_modules', 'pkg');
    repo(root, 'vendor', 'lib');
    repo(root, 'target', 'x');
    repo(root, 'dist', 'x');
    repo(root, 'build', 'x');
    repo(root, 'out', 'x');
    repo(root, '.cache', 'x');
    repo(root, '.hidden', 'x');
    const real = repo(root, 'real');
    expect(await scan(root, 4)).toEqual([real]);
  });

  it('does not follow a symlinked directory, including a self-referential one', async () => {
    const root = tree();
    const real = repo(root, 'real');
    symlinkSync(root, join(root, 'self'), 'dir');
    symlinkSync(real, join(root, 'link-to-repo'), 'dir');
    expect(await scan(root, 5)).toEqual([real]);
  });

  it('treats a root with a trailing separator the same as one without', async () => {
    const root = tree();
    const nested = repo(root, 'a', 'b');
    expect(await scan(root + sep, 3)).toEqual([nested]);
    expect(await scan(root + sep + sep, 3)).toEqual([nested]);
  });

  it.runIf(canTestUnreadable)('counts an unreadable directory and carries on', async () => {
    const root = tree();
    const reachable = repo(root, 'reachable');
    const locked = join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    repo(locked, 'hidden-by-permissions');
    chmodSync(locked, 0o000);

    const result = await scanFolder(root, { depth: 4 });
    expect(result.repositories).toEqual([reachable]);
    expect(result.unreadable).toEqual([locked]);
    expect(result.cancelled).toBe(false);

    chmodSync(locked, 0o700);
  });

  it('reports a root that does not exist without throwing, and does not call it unreadable', async () => {
    const result = await scanFolder(join(tmpdir(), 'gg-scan-does-not-exist-12345'), { depth: 3 });
    expect(result.repositories).toEqual([]);
    // ENOENT is "gone", not "could not be read" — the distinction decides
    // whether repositories under it may be dropped.
    expect(result.unreadable).toEqual([]);
    expect(result.cancelled).toBe(false);
  });

  it('calls onFound as it goes', async () => {
    const root = tree();
    repo(root, 'a');
    repo(root, 'b');
    const found: string[] = [];
    const result = await scanFolder(root, { depth: 2, onFound: (p) => found.push(p) });
    expect(found.sort()).toEqual(result.repositories.sort());
    expect(found).toHaveLength(2);
  });

  it('stops walking once aborted and reports cancelled', async () => {
    const root = tree();
    for (const name of ['a', 'b', 'c', 'd', 'e']) repo(root, name);
    const controller = new AbortController();
    const found: string[] = [];
    const result = await scanFolder(root, {
      depth: 2,
      signal: controller.signal,
      onFound: (p) => {
        found.push(p);
        controller.abort();
      },
    });
    expect(result.cancelled).toBe(true);
    expect(found).toHaveLength(1);
    expect(result.repositories).toHaveLength(1);
  });

  it('reports cancelled when the signal is already aborted', async () => {
    const root = tree();
    repo(root, 'a');
    const result = await scanFolder(root, { depth: 2, signal: AbortSignal.abort() });
    expect(result.cancelled).toBe(true);
    expect(result.repositories).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// canonicalPath / folderProblem
// ---------------------------------------------------------------------------

describe('canonicalPath', () => {
  it('resolves a symlinked directory to its physical path', async () => {
    const root = tree();
    const real = join(root, 'real');
    mkdirSync(real, { recursive: true });
    symlinkSync(real, join(root, 'link'), 'dir');
    expect(await canonicalPath(join(root, 'link'))).toBe(await canonicalPath(real));
  });

  it('resolves a symlinked ancestor', async () => {
    const root = tree();
    mkdirSync(join(root, 'real', 'projects'), { recursive: true });
    symlinkSync(join(root, 'real'), join(root, 'link'), 'dir');
    expect(await canonicalPath(join(root, 'link', 'projects'))).toBe(await canonicalPath(join(root, 'real', 'projects')));
  });

  it('falls back to the normalized path when the target does not exist', async () => {
    const missing = join(tmpdir(), 'gg-canonical-missing-98765', 'nope');
    expect(await canonicalPath(missing + sep)).toBe(missing);
  });
});

describe('folderProblem', () => {
  it('reports null for a readable directory', async () => {
    expect(await folderProblem(tree())).toBeNull();
  });

  it('reports missing for a path that does not exist', async () => {
    expect(await folderProblem(join(tmpdir(), 'gg-folder-problem-missing-4242'))).toBe('missing');
  });

  it('reports not-a-directory for a file, and for a path that runs through one', async () => {
    const root = tree();
    const file = join(root, 'a-file');
    writeFileSync(file, 'x');
    expect(await folderProblem(file)).toBe('not-a-directory');
    // ENOTDIR rather than ENOENT: the path exists, it just isn't a folder.
    expect(await folderProblem(join(file, 'child'))).toBe('not-a-directory');
  });
});

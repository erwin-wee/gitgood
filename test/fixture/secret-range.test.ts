import { describe, expect, it } from 'vitest';
import { GitClient } from '../../src/main/git/git';
import { getRangePatch } from '../../src/main/git/diff';
import { createRepo, hasGitSync } from '../helpers/repo';

describe.skipIf(!hasGitSync())('AI range patch privacy', () => {
  it('excludes secrets under Git-quoted paths without dropping ordinary code', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { 'README.md': 'base\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      const paths = ['café/.env', 'space dir/.env.local', ...(process.platform === 'win32' ? [] : ['tab\tdir/.env', 'quote"dir/credentials.json'])];
      repo.commit({ message: 'changes', files: Object.fromEntries([...paths.map((p) => [p, 'DATABASE_PASSWORD=synthetic-private-value\n']), ['café/code.ts', 'export const safe = true;\n']]) });
      const result = await getRangePatch(new GitClient(repo.tools()), repo.path, 'main', 'feature', 120_000);
      expect(result.patch).not.toContain('synthetic-private-value');
      expect(result.patch).toContain('export const safe = true;');
      expect(result.skipped.map((s) => s.split(': ')[0]).sort()).toEqual(paths.sort());
    } finally {
      await repo.dispose();
    }
  });

  it('does not expose the old side of a secret renamed to a permitted filename', async () => {
    const repo = await createRepo({ commits: [{ message: 'base', files: { '.env': 'DATABASE_PASSWORD=synthetic-private-value\n' } }] });
    try {
      repo.git(['checkout', '-b', 'feature']);
      repo.git(['mv', '.env', '.env.example']);
      repo.commit({ message: 'rename' });
      const result = await getRangePatch(new GitClient(repo.tools()), repo.path, 'main', 'feature', 120_000);
      expect(result.patch).toBe('');
      expect(result.skipped.map((s) => s.split(': ')[0])).toEqual(['.env']);
    } finally {
      await repo.dispose();
    }
  });
});

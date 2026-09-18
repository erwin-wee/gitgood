import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ReleaseCommit } from '../src/shared/types';
import {
  buildReleaseNotes,
  collectPrNumbers,
  extractMergePrNumber,
  extractSquashPrNumber,
  insertIntoChangelog,
  MAX_ITEM_CHARS,
  renderReleaseNotesMarkdown,
  suggestNextPatchVersion,
  type ReleaseNotesContext,
} from '../src/main/ai/release-notes-core';
import { getLatestReachableTag } from '../src/main/git/operations';
import { getReleaseDiffStat, getReleaseLog } from '../src/main/git/log';
import { GitClient } from '../src/main/git/git';
import { buildReleaseNotesPrompt, RELEASE_NOTES_SCHEMA, releaseNotesSystemPrompt } from '../src/main/ai/prompts';
import { createRepo, hasGitSync } from './helpers/repo';

function commit(over: Partial<ReleaseCommit> = {}): ReleaseCommit {
  return { sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 'Do something', body: '', author: 'Test', date: '2026-01-01T00:00:00Z', prNumber: null, ...over };
}

function baseCtx(over: Partial<ReleaseNotesContext> = {}): ReleaseNotesContext {
  return { version: '1.2.4', date: '2026-09-17', commits: [], prNumbers: [], prTitles: new Map(), truncated: false, model: 'test-model', ...over };
}

describe('default settings', () => {
  it('defaults releaseNotesAudience to users', () => {
    expect(DEFAULT_SETTINGS.ai.releaseNotesAudience).toBe('users');
  });
});

describe('PR number extraction', () => {
  it('extracts a PR number from a merge-commit subject', () => {
    expect(extractMergePrNumber('Merge pull request #42 from octo/feature')).toBe(42);
  });

  it('returns null for a subject that is not a merge commit', () => {
    expect(extractMergePrNumber('Fix crash on startup')).toBeNull();
  });

  it('extracts a PR number from a squash-merge subject ending in (#N)', () => {
    expect(extractSquashPrNumber('Fix crash on startup (#12)')).toBe(12);
  });

  it('does not match a parenthesized number that is not at the end', () => {
    expect(extractSquashPrNumber('Fix crash (#12) and clean up')).toBeNull();
  });

  it('returns null when there is no PR reference at all', () => {
    expect(extractSquashPrNumber('Improve docs')).toBeNull();
  });

  it('collectPrNumbers merges merge and squash sources, counting each PR once, ascending', () => {
    const numbers = collectPrNumbers(['Merge pull request #12 from octo/a', 'Merge pull request #5 from octo/b'], ['Fix bug (#5)', 'Add feature (#7)']);
    expect(numbers).toEqual([5, 7, 12]);
  });
});

describe('buildReleaseNotes: reference validation', () => {
  it('keeps only the valid reference when one of two cited refs is invalid', () => {
    const commits = [commit({ sha: 'abc1234'.padEnd(40, '0'), shortSha: 'abc1234' })];
    const raw = { sections: [{ title: 'Fixes', items: [{ text: 'Fixed a crash', refs: ['#999', 'abc1234'] }] }] };
    const notes = buildReleaseNotes(raw, baseCtx({ commits, prNumbers: [] }));
    expect(notes.sections).toEqual([{ title: 'Fixes', items: [{ text: 'Fixed a crash', refs: ['abc1234'] }] }]);
  });

  it('accepts a PR number ref written as a bare number or with a leading #', () => {
    const raw = { sections: [{ title: 'Features', items: [{ text: 'Added dark mode', refs: ['12'] }] }] };
    const notes = buildReleaseNotes(raw, baseCtx({ prNumbers: [12] }));
    expect(notes.sections[0].items[0].refs).toEqual(['#12']);
  });

  it('moves an item with no valid reference to the unreferenced list instead of a section', () => {
    const raw = { sections: [{ title: 'Fixes', items: [{ text: 'Fixed something', refs: ['#999'] }] }] };
    const notes = buildReleaseNotes(raw, baseCtx({ prNumbers: [] }));
    expect(notes.sections).toEqual([]);
    expect(notes.unreferenced).toContainEqual({ text: 'Fixed something', ref: null });
  });

  it('drops an item from an unknown section title', () => {
    const raw = { sections: [{ title: 'Chores', items: [{ text: 'Bumped a dependency', refs: ['#1'] }] }] };
    const notes = buildReleaseNotes(raw, baseCtx({ prNumbers: [1] }));
    expect(notes.sections).toEqual([]);
  });

  it('caps an item at MAX_ITEM_CHARS', () => {
    const longText = 'x'.repeat(300);
    const raw = { sections: [{ title: 'Internal', items: [{ text: longText, refs: ['#1'] }] }] };
    const notes = buildReleaseNotes(raw, baseCtx({ prNumbers: [1] }));
    expect(notes.sections[0].items[0].text.length).toBe(MAX_ITEM_CHARS);
  });

  it('merges two raw sections with the same title into one', () => {
    const raw = {
      sections: [
        { title: 'Fixes', items: [{ text: 'Fixed A', refs: ['#1'] }] },
        { title: 'Fixes', items: [{ text: 'Fixed B', refs: ['#2'] }] },
      ],
    };
    const notes = buildReleaseNotes(raw, baseCtx({ prNumbers: [1, 2] }));
    expect(notes.sections).toHaveLength(1);
    expect(notes.sections[0].items).toHaveLength(2);
  });

  it('renders sections in the fixed order regardless of the model output order', () => {
    const raw = {
      sections: [
        { title: 'Internal', items: [{ text: 'Refactored internals', refs: ['#2'] }] },
        { title: 'Breaking changes', items: [{ text: 'Removed old API', refs: ['#1'] }] },
      ],
    };
    const notes = buildReleaseNotes(raw, baseCtx({ prNumbers: [1, 2] }));
    expect(notes.sections.map((s) => s.title)).toEqual(['Breaking changes', 'Internal']);
  });

  it('lists a commit cited by no item, with an Add-able ref', () => {
    const commits = [commit({ sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'Tweak internals' })];
    const notes = buildReleaseNotes({ sections: [] }, baseCtx({ commits }));
    expect(notes.unreferenced).toContainEqual({ text: 'Tweak internals (bbbbbbb)', ref: 'bbbbbbb' });
  });

  it('lists an uncited PR number once, even when it has no fetched title', () => {
    const notes = buildReleaseNotes({ sections: [] }, baseCtx({ prNumbers: [7] }));
    expect(notes.unreferenced).toContainEqual({ text: '#7', ref: '#7' });
  });

  it('does not list a commit twice when its PR is cited by an item and again as a standalone unit', () => {
    const commits = [commit({ sha: 'c'.repeat(40), shortSha: 'ccccccc', subject: 'Add feature (#9)', prNumber: 9 })];
    const raw = { sections: [{ title: 'Features', items: [{ text: 'Added a feature', refs: ['#9'] }] }] };
    const notes = buildReleaseNotes(raw, baseCtx({ commits, prNumbers: [9] }));
    expect(notes.unreferenced).toEqual([]);
  });

  it('marks the result truncated when the context says so', () => {
    const notes = buildReleaseNotes({ sections: [] }, baseCtx({ truncated: true }));
    expect(notes.truncated).toBe(true);
  });
});

describe('renderReleaseNotesMarkdown', () => {
  it('renders the fixed heading, section and bullet format', () => {
    const md = renderReleaseNotesMarkdown('1.2.4', '2026-09-17', [{ title: 'Fixes', items: [{ text: 'Fixed a crash', refs: ['#12', 'abc1234'] }] }]);
    expect(md).toBe('## 1.2.4 (2026-09-17)\n\n### Fixes\n\n- Fixed a crash (#12, abc1234)\n');
  });

  it('falls back to "Unreleased" when no version is given', () => {
    const md = renderReleaseNotesMarkdown('', '2026-09-17', []);
    expect(md.startsWith('## Unreleased (2026-09-17)')).toBe(true);
  });

  it('omits an empty section', () => {
    const md = renderReleaseNotesMarkdown('1.0.0', '2026-01-01', [{ title: 'Fixes', items: [] }]);
    expect(md).not.toContain('### Fixes');
  });
});

describe('insertIntoChangelog', () => {
  it('creates a new file with a top heading when none exists', () => {
    const { content, created } = insertIntoChangelog(null, '## 1.0.0 (2026-01-01)\n\n### Fixes\n\n- Fixed it (#1)\n');
    expect(created).toBe(true);
    expect(content).toBe('# Changelog\n\n## 1.0.0 (2026-01-01)\n\n### Fixes\n\n- Fixed it (#1)\n');
  });

  it('inserts under the existing top heading, keeping earlier content below', () => {
    const existing = '# Changelog\n\n## 0.9.0 (2025-01-01)\n\n### Fixes\n\n- Old fix (#0)\n';
    const { content, created } = insertIntoChangelog(existing, '## 1.0.0 (2026-01-01)\n\n### Fixes\n\n- New fix (#1)\n');
    expect(created).toBe(false);
    const headingIdx = content.indexOf('## 1.0.0');
    const oldIdx = content.indexOf('## 0.9.0');
    expect(headingIdx).toBeGreaterThan(-1);
    expect(oldIdx).toBeGreaterThan(headingIdx);
  });

  it('creates a top heading when the file exists but has none', () => {
    const existing = 'Some free-form notes.\n';
    const { content } = insertIntoChangelog(existing, '## 1.0.0 (2026-01-01)\n\n- Did a thing (#1)\n');
    expect(content.startsWith('# Changelog\n\n## 1.0.0')).toBe(true);
    expect(content).toContain('Some free-form notes.');
  });

  it('preserves CRLF line endings from the existing file', () => {
    const existing = '# Changelog\r\n\r\n## 0.9.0\r\n\r\n- Old\r\n';
    const { content } = insertIntoChangelog(existing, '## 1.0.0 (2026-01-01)\n\n- New (#1)\n');
    expect(content).toContain('\r\n');
    expect(content.replace(/\r\n/g, '\n')).not.toContain('\r');
  });
});

describe('suggestNextPatchVersion', () => {
  it('suggests the next patch for a "vX.Y.Z" tag', () => {
    expect(suggestNextPatchVersion('v1.2.3')).toBe('v1.2.4');
  });

  it('suggests the next patch for a bare "X.Y.Z" tag', () => {
    expect(suggestNextPatchVersion('1.2.3')).toBe('1.2.4');
  });

  it('returns null for a non-semver tag', () => {
    expect(suggestNextPatchVersion('release-42')).toBeNull();
  });
});

describe('RELEASE_NOTES_SCHEMA', () => {
  it('lists exactly the fields a well-formed response has', () => {
    const sample = { sections: [{ title: 'Fixes', items: [{ text: 'Fixed a crash', refs: ['#12'] }] }] };
    expect(Object.keys(sample).sort()).toEqual(Object.keys(RELEASE_NOTES_SCHEMA.properties).sort());
    for (const key of RELEASE_NOTES_SCHEMA.required) expect(sample).toHaveProperty(key);
    expect(RELEASE_NOTES_SCHEMA.properties.sections.items.properties.title.enum).toContain('Fixes');
  });
});

describe('buildReleaseNotesPrompt', () => {
  it('trims a commit body to 400 characters', () => {
    const prompt = buildReleaseNotesPrompt({
      version: '1.0.0',
      audience: 'users',
      fromLabel: 'v0.9.0',
      toLabel: 'HEAD',
      commits: [{ sha: 'a'.repeat(40), subject: 'Fix crash', body: 'x'.repeat(1000), prNumber: null }],
      prs: [],
      diffStat: '1 file changed',
      truncated: false,
    });
    const bodyLine = prompt.split('\n').find((l) => /^x+$/.test(l.trim()));
    expect(bodyLine?.trim().length).toBe(400);
  });

  it('notes truncation in the prompt when the range was gathered as subjects only', () => {
    const prompt = buildReleaseNotesPrompt({ version: '1.0.0', audience: 'users', fromLabel: 'v0.9.0', toLabel: 'HEAD', commits: [], prs: [], diffStat: '', truncated: true });
    expect(prompt).toContain('truncated to subjects only');
  });

  it('mentions no pull request titles were available when none are given', () => {
    const prompt = buildReleaseNotesPrompt({ version: '1.0.0', audience: 'users', fromLabel: 'v0.9.0', toLabel: 'HEAD', commits: [], prs: [], diffStat: '', truncated: false });
    expect(prompt).toContain('No pull request titles were available');
  });
});

describe('releaseNotesSystemPrompt', () => {
  it('adjusts guidance for the developers audience', () => {
    expect(releaseNotesSystemPrompt('developers')).toContain('developer-facing');
    expect(releaseNotesSystemPrompt('users')).toContain('user-visible');
  });
});

describe.skipIf(!hasGitSync())('release range gathering (real git)', () => {
  it('gathers the right commits and detects the latest tag between two tags', async () => {
    const repo = await createRepo({
      commits: [
        { message: 'Initial commit', files: { 'README.md': '# Fixture\n' } },
        { message: 'v0.1.0 baseline', files: { 'src/app.ts': 'export const value = 1;\n' } },
      ],
    });
    const git = new GitClient(repo.tools());
    repo.git(['tag', 'v0.1.0'], repo.path);
    repo.commit({ message: 'Fix crash on startup (#12)', files: { 'src/app.ts': 'export const value = 2;\n' } });
    repo.commit({ message: 'Improve docs', files: { 'README.md': '# Fixture\n\nMore docs.\n' } });
    repo.git(['tag', 'v0.1.1'], repo.path);

    expect(await getLatestReachableTag(git, repo.path)).toBe('v0.1.1');

    const { commits, mergeSubjects, truncated } = await getReleaseLog(git, repo.path, 'v0.1.0', 'v0.1.1');
    expect(truncated).toBe(false);
    expect(mergeSubjects).toEqual([]);
    expect(commits.map((c) => c.subject)).toEqual(['Improve docs', 'Fix crash on startup (#12)']);
    expect(commits.find((c) => c.subject.includes('Fix crash'))?.prNumber).toBe(12);

    const stat = await getReleaseDiffStat(git, repo.path, 'v0.1.0', 'v0.1.1');
    expect(stat).toContain('README.md');

    await repo.dispose();
  });

  it('falls back to gathering from the root when there are no tags', async () => {
    const repo = await createRepo({ commits: [{ message: 'Initial commit', files: { 'a.txt': 'hi\n' } }] });
    const git = new GitClient(repo.tools());
    expect(await getLatestReachableTag(git, repo.path)).toBeNull();
    const { commits } = await getReleaseLog(git, repo.path, null, 'HEAD');
    expect(commits).toHaveLength(1);
    await repo.dispose();
  });
});

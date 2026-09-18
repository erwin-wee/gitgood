import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverIssueTemplates, parseIssueTemplate } from '../src/main/gh/issue-templates';

describe('parseIssueTemplate', () => {
  it('parses name/about/title and a comma-list of labels from front matter', () => {
    const content = ['---', 'name: Bug report', 'about: File a bug report', 'title: "[Bug]: "', 'labels: bug, needs-triage', '---', '', 'Describe the bug.'].join('\n');
    const template = parseIssueTemplate(content, 'bug_report.md');
    expect(template).toEqual({ name: 'Bug report', about: 'File a bug report', title: '[Bug]: ', labels: ['bug', 'needs-triage'], body: 'Describe the bug.', external: false, filename: 'bug_report.md' });
  });

  it('parses a YAML list form of labels', () => {
    const content = ['---', 'name: Feature request', 'labels:', '  - enhancement', '  - "needs-design"', '---', 'Body here'].join('\n');
    const template = parseIssueTemplate(content, 'feature.md');
    expect(template.labels).toEqual(['enhancement', 'needs-design']);
    expect(template.name).toBe('Feature request');
  });

  it('falls back to the filename when there is no front matter', () => {
    const template = parseIssueTemplate('Just a plain template body.', 'plain_template.md');
    expect(template).toEqual({ name: 'plain_template', about: null, title: null, labels: [], body: 'Just a plain template body.', external: false, filename: 'plain_template.md' });
  });

  it('marks a .yml issue-forms template as external and does not treat it as renderable', () => {
    const content = ['name: Bug Report', 'description: File a structured bug report', 'body:', '  - type: input'].join('\n');
    const template = parseIssueTemplate(content, 'bug_report.yml');
    expect(template).toEqual({ name: 'Bug Report', about: 'File a structured bug report', title: null, labels: [], body: '', external: true, filename: 'bug_report.yml' });
  });
});

describe('discoverIssueTemplates', () => {
  let dir: string | undefined;

  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('reads every template under .github/ISSUE_TEMPLATE, skipping config.yml', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-issue-templates-'));
    const templateDir = join(dir, '.github', 'ISSUE_TEMPLATE');
    await mkdir(templateDir, { recursive: true });
    await writeFile(join(templateDir, 'bug_report.md'), '---\nname: Bug report\n---\nBody', 'utf8');
    await writeFile(join(templateDir, 'feature.md'), 'No front matter here', 'utf8');
    await writeFile(join(templateDir, 'config.yml'), 'blank_issues_enabled: false', 'utf8');
    const templates = await discoverIssueTemplates(dir);
    expect(templates.map((t) => t.name).sort()).toEqual(['Bug report', 'feature']);
  });

  it('falls back to the legacy single ISSUE_TEMPLATE.md when the directory does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-issue-templates-legacy-'));
    await mkdir(join(dir, '.github'), { recursive: true });
    await writeFile(join(dir, '.github', 'ISSUE_TEMPLATE.md'), 'Legacy body', 'utf8');
    const templates = await discoverIssueTemplates(dir);
    expect(templates).toEqual([{ name: 'ISSUE_TEMPLATE', about: null, title: null, labels: [], body: 'Legacy body', external: false, filename: 'ISSUE_TEMPLATE.md' }]);
  });

  it('returns an empty list when the repository has no templates', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gg-issue-templates-none-'));
    expect(await discoverIssueTemplates(dir)).toEqual([]);
  });
});

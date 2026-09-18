import { describe, expect, it } from 'vitest';
import {
  capBody,
  collectIssueReferences,
  extractIssueMentions,
  extractTemplateHeadings,
  headingsPresentInOrder,
  normalizePrTitle,
  reconcileLinkedIssues,
  restoreCheckboxes,
  restoreTemplateStructure,
  stripCodeSpans,
  templateCheckboxLabels, downgradeUnallowedClosings } from '../src/main/ai/pr-draft-core';
import { PR_DRAFT_SCHEMA } from '../src/main/ai/prompts';
import { appendDraftFooter } from '../src/shared/util';

describe('PR_DRAFT_SCHEMA', () => {
  it('lists every field a sample well-formed response has, and nothing else', () => {
    const sample = {
      title: 'Add retry to fetch queue',
      body: '## Summary\nAdds a retry.\n',
      linkedIssues: [{ number: 42, keyword: 'closes' }],
      templateSectionsFilled: ['## Summary'],
    };
    expect(Object.keys(sample).sort()).toEqual(Object.keys(PR_DRAFT_SCHEMA.properties).sort());
    for (const key of PR_DRAFT_SCHEMA.required) expect(sample).toHaveProperty(key);
    expect(typeof sample.title).toBe('string');
    expect(typeof sample.body).toBe('string');
    expect(Array.isArray(sample.linkedIssues)).toBe(true);
    for (const issue of sample.linkedIssues) {
      expect(Number.isInteger(issue.number)).toBe(true);
      expect(PR_DRAFT_SCHEMA.properties.linkedIssues.items.properties.keyword.enum).toContain(issue.keyword);
    }
    expect(Array.isArray(sample.templateSectionsFilled)).toBe(true);
  });

  it('accepts an empty draft (no template, no linked issues)', () => {
    const sample = { title: 'Fix flaky test', body: 'Stabilizes the retry timing.', linkedIssues: [] as { number: number; keyword: string }[], templateSectionsFilled: [] as string[] };
    for (const key of PR_DRAFT_SCHEMA.required) expect(sample).toHaveProperty(key);
  });
});

describe('issue reference extraction', () => {
  it('extracts a bare #N reference', () => {
    expect(extractIssueMentions('see #17 for context')).toEqual([{ number: 17, repo: null, closing: false }]);
  });

  it('extracts closing keywords in their various inflections', () => {
    for (const word of ['Fix', 'Fixes', 'Fixed', 'Close', 'Closes', 'Closed', 'Resolve', 'Resolves', 'Resolved']) {
      expect(extractIssueMentions(`${word} #42`)).toEqual([{ number: 42, repo: null, closing: true }]);
    }
  });

  it('extracts owner/repo#N references', () => {
    expect(extractIssueMentions('Fixes erwin-wee/gitgood#99')).toEqual([{ number: 99, repo: 'erwin-wee/gitgood', closing: true }]);
  });

  it('ignores references inside inline and fenced code spans', () => {
    expect(extractIssueMentions('Mentions `#123` inline')).toEqual([]);
    expect(extractIssueMentions('```\nFixes #456\n```\nsee #17')).toEqual([{ number: 17, repo: null, closing: false }]);
  });

  it('strips code spans without eating surrounding text', () => {
    expect(stripCodeSpans('before `code` after')).toBe('before   after');
  });
});

describe('collectIssueReferences', () => {
  it('marks an issue as closing when any commit uses a closing keyword for it', () => {
    const refs = collectIssueReferences(['Fixes #42', 'unrelated change']);
    expect(refs).toEqual([{ number: 42, closing: true }]);
  });

  it('keeps a plain mention plain when no commit closes it', () => {
    const refs = collectIssueReferences(['see #17 for background', 'also touches #17 again']);
    expect(refs).toEqual([{ number: 17, closing: false }]);
  });

  it('includes issues mentioned only in the existing body as non-closing', () => {
    const refs = collectIssueReferences(['unrelated commit'], 'Continues work from #5');
    expect(refs).toEqual([{ number: 5, closing: false }]);
  });

  it('does not let a body mention override a commit that already closes the same issue', () => {
    const refs = collectIssueReferences(['Fixes #5'], 'refs #5');
    expect(refs).toEqual([{ number: 5, closing: true }]);
  });
});

describe('reconcileLinkedIssues', () => {
  const valid = [
    { number: 42, closing: true },
    { number: 17, closing: false },
  ];

  it('drops an issue number the model invented', () => {
    expect(reconcileLinkedIssues([{ number: 999, keyword: 'refs' }], valid)).toEqual([]);
  });

  it('keeps a valid closing reference as closes', () => {
    expect(reconcileLinkedIssues([{ number: 42, keyword: 'closes' }], valid)).toEqual([{ number: 42, keyword: 'closes' }]);
  });

  it('downgrades closes to refs when no commit used a closing keyword', () => {
    expect(reconcileLinkedIssues([{ number: 17, keyword: 'closes' }], valid)).toEqual([{ number: 17, keyword: 'refs' }]);
  });

  it('ignores malformed entries and de-duplicates', () => {
    expect(reconcileLinkedIssues([{ number: 42, keyword: 'closes' }, { number: 42, keyword: 'refs' }, { number: 'nope' }, null], valid)).toEqual([{ number: 42, keyword: 'closes' }]);
  });
});

describe('template heading extraction and preservation', () => {
  const template = '## Summary\n\nDescribe the change.\n\n## Testing\n\nHow was this tested?\n\n## Checklist\n\n- [ ] Tests added\n';

  it('extracts headings in order', () => {
    expect(extractTemplateHeadings(template)).toEqual(['## Summary', '## Testing', '## Checklist']);
  });

  it('reports true when a body contains every heading in order', () => {
    const body = '## Summary\nDid X.\n\n## Testing\nRan the suite.\n\n## Checklist\n- [ ] Tests added\n';
    expect(headingsPresentInOrder(body, extractTemplateHeadings(template))).toBe(true);
  });

  it('reports false when a heading is missing', () => {
    const body = '## Summary\nDid X.\n\n## Checklist\n- [ ] Tests added\n';
    expect(headingsPresentInOrder(body, extractTemplateHeadings(template))).toBe(false);
  });

  it('reports false when headings are out of order', () => {
    const body = '## Testing\nRan the suite.\n\n## Summary\nDid X.\n\n## Checklist\n- [ ] Tests added\n';
    expect(headingsPresentInOrder(body, extractTemplateHeadings(template))).toBe(false);
  });

  it('restores the template structure by placing the draft under the first heading', () => {
    const headings = extractTemplateHeadings(template);
    const rebuilt = restoreTemplateStructure('Just a paragraph, no headings at all.', template);
    expect(headingsPresentInOrder(rebuilt, headings)).toBe(true);
    expect(rebuilt).toContain('Just a paragraph, no headings at all.');
    expect(rebuilt).toContain('- [ ] Tests added');
  });

  it('preserves CRLF line endings from the template when restoring', () => {
    const crlfTemplate = template.replace(/\n/g, '\r\n');
    const rebuilt = restoreTemplateStructure('Draft content.', crlfTemplate);
    expect(rebuilt).toContain('\r\n');
    expect(rebuilt.includes('\n') && !rebuilt.replace(/\r\n/g, '').includes('\n')).toBe(true);
  });
});

describe('checkbox restoration', () => {
  const template = '## Checklist\n\n- [ ] Updated tests in test/foo.test.ts\n- [ ] Updated the docs\n';
  const labels = templateCheckboxLabels(template);

  it('keeps a tick when the label mentions a changed path', () => {
    const body = '## Checklist\n\n- [x] Updated tests in test/foo.test.ts\n- [ ] Updated the docs\n';
    const restored = restoreCheckboxes(body, labels, ['test/foo.test.ts']);
    expect(restored).toContain('- [x] Updated tests in test/foo.test.ts');
  });

  it('un-ticks a checkbox the model checked without a matching changed path', () => {
    const body = '## Checklist\n\n- [x] Updated tests in test/foo.test.ts\n- [x] Updated the docs\n';
    const restored = restoreCheckboxes(body, labels, ['test/foo.test.ts']);
    expect(restored).toContain('- [ ] Updated the docs');
  });

  it('leaves a checkbox not present in the template untouched', () => {
    const body = '- [x] Something the model added on its own\n';
    expect(restoreCheckboxes(body, labels, [])).toBe(body);
  });
});

describe('title normalization', () => {
  it('removes a trailing period', () => {
    expect(normalizePrTitle('Add retry logic.')).toBe('Add retry logic');
  });

  it('collapses to the first line only', () => {
    expect(normalizePrTitle('Add retry logic\nSecond line should be dropped')).toBe('Add retry logic');
  });

  it('truncates to 256 characters but never touches a shorter title', () => {
    const short = 'Add retry logic';
    expect(normalizePrTitle(short)).toBe(short);
    const long = 'A'.repeat(300);
    const normalized = normalizePrTitle(long);
    expect(normalized.length).toBe(256);
  });

  it('trims surrounding whitespace', () => {
    expect(normalizePrTitle('   Add retry logic   ')).toBe('Add retry logic');
  });
});

describe('capBody', () => {
  it('leaves a short body untouched', () => {
    expect(capBody('short')).toBe('short');
  });

  it('caps at 60,000 characters', () => {
    const long = 'x'.repeat(70_000);
    expect(capBody(long).length).toBe(60_000);
  });
});

describe('appendDraftFooter', () => {
  it('returns the trimmed body unchanged when no footer is given', () => {
    expect(appendDraftFooter('  body text  ', null)).toBe('body text');
  });

  it('appends the footer after a blank line', () => {
    expect(appendDraftFooter('body text', '_footer_')).toBe('body text\n\n_footer_');
  });

  it('returns just the footer when the body is empty', () => {
    expect(appendDraftFooter('   ', '_footer_')).toBe('_footer_');
  });
});

describe('downgradeUnallowedClosings', () => {
  it('keeps closing keywords only for issues a commit closed and downgrades the rest', () => {
    const valid = [{ number: 7, closing: true }, { number: 9, closing: false }];
    const body = 'Fixes #7 and closes #9. Also fixes owner/repo#12.\n\n`Fixes #9` stays in code.';
    expect(downgradeUnallowedClosings(body, valid)).toBe('Fixes #7 and refs #9. Also refs owner/repo#12.\n\n`Fixes #9` stays in code.');
  });

  it('leaves plain mentions and non-issue text untouched', () => {
    expect(downgradeUnallowedClosings('See #3; resolved the flake.', [])).toBe('See #3; resolved the flake.');
  });
});

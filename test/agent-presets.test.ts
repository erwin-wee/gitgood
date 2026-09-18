import { describe, expect, it } from 'vitest';
import { AGENT_PRESETS, agentTemplate, escapePathForTemplate, expandAgentCommand, validateAgentTemplate } from '../src/shared/agent-presets';

describe('agent presets', () => {
  it('offers Claude Code, Codex and omp, each with a {file} placeholder inside a quoted prompt', () => {
    expect(AGENT_PRESETS.map((p) => p.id)).toEqual(['claude', 'codex', 'omp']);
    for (const p of AGENT_PRESETS) {
      expect(p.template.startsWith(`${p.binary} "`)).toBe(true);
      expect(p.template).toContain('{file}');
      expect(p.template).toContain('Do not commit');
    }
  });

  it('agentTemplate returns the preset or the custom text', () => {
    expect(agentTemplate({ agentCommand: 'codex', agentCustomCommand: '' })).toBe(AGENT_PRESETS[1].template);
    expect(agentTemplate({ agentCommand: 'custom', agentCustomCommand: 'aider --file {file}' })).toBe('aider --file {file}');
  });

  it('validateAgentTemplate requires {file}', () => {
    expect(validateAgentTemplate('claude "fix {file}"')).toBeNull();
    expect(validateAgentTemplate('claude "fix it"')).toBe('The command must contain {file}');
    expect(validateAgentTemplate('   ')).toBe('Enter the command to run.');
  });

  it('escapes what each shell would expand inside the double-quoted prompt', () => {
    const plain = '/home/dev/my app/.git/gitgood/review/latest.md';
    for (const q of ['posix', 'powershell', 'cmd'] as const) expect(escapePathForTemplate(plain, q)).toBe(plain);
    // POSIX: backslash is the escape character, and $ and backtick expand.
    expect(escapePathForTemplate('/tmp/a"b$c`d\\e', 'posix')).toBe('/tmp/a\\"b\\$c\\`d\\\\e');
    // PowerShell: backtick is the escape character; a backslash is an ordinary path character.
    expect(escapePathForTemplate('C:\\dev\\$work\\a`b\\latest.md', 'powershell')).toBe('C:\\dev\\`$work\\a``b\\latest.md');
    // cmd.exe: no escape character inside quotes; %VAR% is stopped by doubling the percent.
    expect(escapePathForTemplate('C:\\dev\\100%%done\\latest.md'.replace('%%', '%'), 'cmd')).toBe('C:\\dev\\100%%done\\latest.md');
    expect(escapePathForTemplate('C:\\dev\\$work\\latest.md', 'cmd')).toBe('C:\\dev\\$work\\latest.md');
  });

  it('expandAgentCommand replaces every placeholder', () => {
    expect(expandAgentCommand('x {file} y {file}', '/p q', 'posix')).toBe('x /p q y /p q');
    expect(expandAgentCommand(AGENT_PRESETS[0].template, 'C:\\r\\latest.md', 'cmd')).toBe('claude "Read the file C:\\r\\latest.md and fix every finding it lists, following its instructions. Do not commit."');
  });
});

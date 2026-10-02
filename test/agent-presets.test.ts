import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { AGENT_PRESETS, expandAgentCommand, validateAgentTemplate, type CommandQuoting } from '../src/shared/agent-presets';

describe('agent command safety', () => {
  it.each<CommandQuoting>(['posix', 'powershell', 'cmd'])('accepts literal quoted prompts for %s', (quoting) => {
    for (const { template } of AGENT_PRESETS) expect(validateAgentTemplate(template, quoting)).toBeNull();
    expect(validateAgentTemplate('agent "Read {file}" --also "{file}"', quoting)).toBeNull();
    expect(validateAgentTemplate('agent "it\'s {file}"', quoting)).toBeNull();
    for (const bad of ['', 'agent "no path"', 'agent {file}', "agent '{file}'", 'agent "{file}" {file}', 'agent "{file}']) {
      expect(validateAgentTemplate(bad, quoting)).not.toBeNull();
    }
  });

  it.each<[CommandQuoting, string]>([
    ['posix', String.raw`agent \"{file}\"`],
    ['posix', String.raw`agent \{file}`],
    ['powershell', 'agent `"{file}`"'],
    ['cmd', 'agent ^"{file}^"'],
    ['posix', 'agent "$(echo {file})"'],
    ['powershell', 'agent "$(Write-Output {file})"'],
    ['posix', 'agent "`echo {file}`"'],
  ])('refuses ambiguous placeholder scope in %s: %s', (quoting, template) => {
    expect(validateAgentTemplate(template, quoting)).not.toBeNull();
    expect(() => expandAgentCommand(template, '/tmp/name;printf INJECTED;#', quoting)).toThrow();
  });

  it.skipIf(process.platform === 'win32')('hands hostile POSIX filenames to the agent as one unchanged argument', () => {
    const file = '/tmp/repo space;printf INJECTED;#/$HOME/`id`/a"b\\c/latest.md';
    const command = expandAgentCommand('printf \'%s\\n\' "{file}"', file, 'posix');
    expect(execFileSync('/bin/sh', ['-c', command], { encoding: 'utf8' })).toBe(file + '\n');
  });
});

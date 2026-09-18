import { describe, expect, it } from 'vitest';
import { buildWindowsCmdInvocation, cmdEscapeArgument } from '../src/main/exec';

/**
 * What cmd.exe does with `^`: drop it and take the next character literally,
 * without letting it start or end a quoted section. Modelling it here is what
 * makes the Windows command line assertable from any host -- otherwise the only
 * way to see this behaviour is to push to CI.
 */
function cmdUnescape(s: string): string {
  return s.replace(/\^(.)/g, '$1');
}

/** Characters cmd.exe acts on; every one of them must arrive `^`-escaped. */
const META = /[()%!^"<>&|]/;

function unescapedMetaCharsRemain(escaped: string): boolean {
  // Walk the string, skipping any character that is `^`-escaped.
  for (let i = 0; i < escaped.length; i++) {
    if (escaped[i] === '^') {
      i++; // this character is escaped, and so is fine
      continue;
    }
    if (META.test(escaped[i])) return true;
  }
  return false;
}

describe('cmdEscapeArgument', () => {
  it('leaves no metacharacter for cmd.exe to act on', () => {
    for (const arg of ['plain', 'has space', 'a&b', 'a|b', 'a>b', 'a<b', 'p(1)', '100%', 'a^b', 'say"hi', '{"k":"v"}']) {
      expect(unescapedMetaCharsRemain(cmdEscapeArgument(arg)), `${arg} -> ${cmdEscapeArgument(arg)}`).toBe(false);
    }
  });

  it('hands the C runtime a correctly quoted argument once cmd has had its pass', () => {
    // After cmd strips the `^`s, what remains is the C-runtime form: the whole
    // argument quoted, with inner quotes backslash-escaped.
    expect(cmdUnescape(cmdEscapeArgument('a&b'))).toBe('"a&b"');
    expect(cmdUnescape(cmdEscapeArgument('say"hi'))).toBe('"say\\"hi"');
    expect(cmdUnescape(cmdEscapeArgument('ends\\'))).toBe('"ends\\\\"');
  });

  it('survives the JSON blob that broke the claude backend on Windows', () => {
    // The regression: `--json-schema` carries JSON full of quotes. Escaped only
    // for the C runtime, cmd counts those quotes, loses track of quote state and
    // treats a later `&` as a command separator -- "& was unexpected at this time".
    const schema = JSON.stringify({ type: 'object', properties: { q: { type: 'string', description: 'a & b | c' } } });
    const escaped = cmdEscapeArgument(schema);
    expect(unescapedMetaCharsRemain(escaped)).toBe(false);
    expect(cmdUnescape(escaped)).toBe(`"${schema.replace(/"/g, '\\"')}"`);
  });
});

describe('buildWindowsCmdInvocation', () => {
  it('invokes cmd.exe with /d /s /c and an unquoted, fully escaped command', () => {
    const { file, args } = buildWindowsCmdInvocation('C:\\npm\\claude.cmd', ['-p', '--json-schema', '{"a":"b"}'], 'C:\\Windows\\system32\\cmd.exe');
    expect(file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    // Not wrapped in outer quotes: `^` is literal inside a quoted section, so
    // wrapping would disable the escaping. `/s` only strips when the first and
    // last characters are both quotes, which an escaped command never starts with.
    expect(args[3].startsWith('"')).toBe(false);
    expect(unescapedMetaCharsRemain(args[3])).toBe(false);
  });

  it('falls back to cmd.exe when ComSpec is empty', () => {
    // Not `undefined`: that triggers the `= process.env.ComSpec` default, which
    // makes the assertion depend on the host (it is set on Windows, unset on
    // Linux). An empty string exercises the fallback the same way everywhere.
    expect(buildWindowsCmdInvocation('x.cmd', [], '').file).toBe('cmd.exe');
  });
});

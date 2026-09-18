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

/**
 * Simulates cmd.exe's `/S` quote handling: strip the first character if it is
 * a quote, then strip the *last quote character found anywhere in the
 * string* (not necessarily the last character), preserving whatever follows
 * it. This is what desyncs per-argument quoting when the remainder is a
 * sequence of separately quoted segments instead of one wrapped string.
 */
function applySlashS(s: string): string {
  let out = s.startsWith('"') ? s.slice(1) : s;
  const lastQuote = out.lastIndexOf('"');
  if (lastQuote !== -1) out = out.slice(0, lastQuote) + out.slice(lastQuote + 1);
  return out;
}

describe('buildWindowsCmdInvocation', () => {
  it('invokes cmd.exe with /d /s /c and the escaped command wrapped in one outer quote pair', () => {
    const { file, args } = buildWindowsCmdInvocation('C:\\npm\\claude.cmd', ['-p', '--json-schema', '{"a":"b"}'], 'C:\\Windows\\system32\\cmd.exe');
    expect(file).toBe('C:\\Windows\\system32\\cmd.exe');
    expect(args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    const inner = ['C:\\npm\\claude.cmd', '-p', '--json-schema', '{"a":"b"}'].map(cmdEscapeArgument).join(' ');
    // Wrapped so /S's stripping (first char + last quote char in the whole
    // string) removes exactly the wrapper, leaving every per-argument quote
    // pair -- all of them `^`-escaped -- untouched.
    expect(args[3]).toBe(`"${inner}"`);
    expect(applySlashS(args[3])).toBe(inner);
    expect(unescapedMetaCharsRemain(inner)).toBe(false);
  });

  it('falls back to cmd.exe when ComSpec is empty', () => {
    // Not `undefined`: that triggers the `= process.env.ComSpec` default, which
    // makes the assertion depend on the host (it is set on Windows, unset on
    // Linux). An empty string exercises the fallback the same way everywhere.
    expect(buildWindowsCmdInvocation('x.cmd', [], '').file).toBe('cmd.exe');
  });
});

'use strict';
/**
 * Generic stub engine shared by the `gh`/`gh.cmd` and `claude`/`claude.cmd`
 * launchers. The launcher picks a prefix ('GH' or 'CLAUDE'); the engine reads
 * `<prefix>_STUB_SCENARIO` (a JSON file of match rules) and `<prefix>_STUB_LOG`
 * (an ndjson file every invocation is appended to), matches argv against the
 * rules and replays the first match's stdout/stderr/exitCode. Unmatched calls,
 * or calls with no scenario configured, exit 99 loudly so a missing rule never
 * silently passes a test.
 */
const fs = require('fs');

function runStub(prefix) {
  const scenarioPath = process.env[`${prefix}_STUB_SCENARIO`];
  const logPath = process.env[`${prefix}_STUB_LOG`];
  const args = process.argv.slice(2);
  const record = { tool: prefix.toLowerCase(), args, cwd: process.cwd(), at: new Date().toISOString() };

  const appendLog = (entry) => {
    if (logPath) fs.appendFileSync(logPath, `${JSON.stringify(entry)}\n`);
  };

  if (!scenarioPath || !fs.existsSync(scenarioPath)) {
    appendLog({ ...record, matched: false, reason: 'no-scenario' });
    process.stderr.write(`${prefix.toLowerCase()}-stub: no scenario configured (set ${prefix}_STUB_SCENARIO)\n`);
    process.exitCode = 99;
    return;
  }

  let scenario;
  try {
    scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
  } catch (err) {
    appendLog({ ...record, matched: false, reason: 'bad-scenario' });
    process.stderr.write(`${prefix.toLowerCase()}-stub: could not parse scenario JSON: ${err.message}\n`);
    process.exitCode = 99;
    return;
  }

  const rules = Array.isArray(scenario) ? scenario : scenario.rules || [];
  const joined = args.join(' ');

  const matches = (rule) => {
    const m = rule.match;
    if (m === undefined) return true;
    if (typeof m === 'string') return joined.includes(m);
    if (Array.isArray(m)) return m.every((frag) => joined.includes(frag));
    if (m && typeof m === 'object' && m.regex) return new RegExp(m.regex).test(joined);
    return false;
  };

  const rule = rules.find(matches);
  if (!rule) {
    appendLog({ ...record, matched: false });
    process.stderr.write(`${prefix.toLowerCase()}-stub: no rule matched for: ${joined}\n`);
    process.exitCode = 99;
    return;
  }

  appendLog({ ...record, matched: true, rule: rule.name || joined });

  const finish = () => {
    let stdout = rule.stdout;
    if (rule.stdoutFromStdin) {
      try {
        stdout = fs.readFileSync(0, 'utf8');
      } catch {
        stdout = '';
      }
    }
    if (stdout !== undefined) {
      process.stdout.write(typeof stdout === 'string' ? stdout : JSON.stringify(stdout));
    }
    if (rule.stderr) process.stderr.write(rule.stderr);
    process.exitCode = rule.exitCode !== undefined ? rule.exitCode : 0;
  };

  if (rule.delayMs) setTimeout(finish, rule.delayMs);
  else finish();
}

module.exports = { runStub };

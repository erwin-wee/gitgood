/**
 * Terminal coding agents GitGood can hand review findings to, and the command
 * template that launches each one. Shared between the main process (which
 * expands and launches) and the renderer (which shows exactly what will run).
 * The template's `{file}` placeholder is replaced by the absolute path of the
 * exported `latest.md`; the presets keep it inside a double-quoted prompt so
 * paths with spaces work on every platform.
 */
import type { AiSettings } from './types';

export const FILE_PLACEHOLDER = '{file}';

export type AgentCommandId = AiSettings['agentCommand'];

export interface AgentPreset {
  id: Exclude<AgentCommandId, 'custom'>;
  label: string;
  /** Executable name, used to hint the user when it is missing. */
  binary: string;
  template: string;
}

const PROMPT = `Read the file {file} and fix every finding it lists, following its instructions. Do not commit.`;

export const AGENT_PRESETS: readonly AgentPreset[] = [
  { id: 'claude', label: 'Claude Code', binary: 'claude', template: `claude "${PROMPT}"` },
  { id: 'codex', label: 'Codex', binary: 'codex', template: `codex "${PROMPT}"` },
  { id: 'omp', label: 'omp', binary: 'omp', template: `omp "${PROMPT}"` },
];

/** The template that will run for these settings (custom text for `custom`, preset text otherwise). */
export function agentTemplate(settings: Pick<AiSettings, 'agentCommand' | 'agentCustomCommand'>): string {
  if (settings.agentCommand === 'custom') return settings.agentCustomCommand;
  return AGENT_PRESETS.find((p) => p.id === settings.agentCommand)?.template ?? AGENT_PRESETS[0].template;
}

/** Whether every `{file}` sits inside a double-quoted string. The path is escaped for double quotes only (see escapePathForTemplate), so bare or single-quoted placeholders would let a path containing spaces, `$` or quotes change what runs. */
function placeholdersQuoted(template: string): boolean {
  let quote: string | null = null;
  for (let i = 0; i < template.length; i++) {
    if (template.startsWith(FILE_PLACEHOLDER, i)) {
      if (quote !== '"') return false;
      i += FILE_PLACEHOLDER.length - 1;
      continue;
    }
    const c = template[i];
    if (quote === '"' && c === '\\') i++;
    else if (c === quote) quote = null;
    else if (quote === null && (c === '"' || c === "'")) quote = c;
  }
  return true;
}

/** Null when the template is usable, otherwise the message to show inline. */
export function validateAgentTemplate(template: string): string | null {
  if (!template.trim()) return 'Enter the command to run.';
  if (!template.includes(FILE_PLACEHOLDER)) return `The command must contain ${FILE_PLACEHOLDER}`;
  if (!placeholdersQuoted(template)) return `Write every ${FILE_PLACEHOLDER} inside double quotes, e.g. agent "Read ${FILE_PLACEHOLDER}" (unquoted or single-quoted paths are not escaped safely).`;
  return null;
}

/**
 * Which shell will parse the expanded command, and therefore how the file
 * path substituted into it must be escaped. Chosen per terminal rather than
 * per platform: Windows Terminal and Command Prompt parse with cmd.exe,
 * PowerShell with its own rules, and Git Bash with POSIX rules.
 */
export type CommandQuoting = 'posix' | 'powershell' | 'cmd';

/**
 * Escapes a path for insertion inside the double-quoted argument the presets
 * put `{file}` in. Every shell expands something different inside double
 * quotes: POSIX shells expand `$` and backticks (and treat `\` as an escape),
 * PowerShell expands `$` and uses a backtick as its escape character, and
 * cmd.exe expands `%VAR%`. All of `$`, backtick and `%` are legal in paths.
 */
export function escapePathForTemplate(file: string, quoting: CommandQuoting): string {
  if (quoting === 'posix') return file.replace(/[\\"$`]/g, (c) => `\\${c}`);
  if (quoting === 'powershell') return file.replace(/[`$"]/g, (c) => `\`${c}`);
  // cmd.exe has no escape character inside quotes; doubling a percent sign is
  // the documented way to stop `%VAR%` expansion in a command line.
  return file.replace(/%/g, '%%');
}

export function expandAgentCommand(template: string, file: string, quoting: CommandQuoting): string {
  return template.split(FILE_PLACEHOLDER).join(escapePathForTemplate(file, quoting));
}

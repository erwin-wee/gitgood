/**
 * Pure helpers for settings export/import and gist sync: the allowlist that
 * decides what ever leaves the machine, validation of an imported file
 * against that allowlist, merge/replace patch building and the import
 * preview counts, plus the gist-sync "which side is newer" comparison. No
 * Electron or Node imports (path separators are handled with plain string
 * replacement) so this can be unit tested and reasoned about in isolation.
 */
import type {
  AiSettings,
  AppSettings,
  GitHubRepoRef,
  ImportPreview,
  ImportPreviewSection,
  PortableAiSettings,
  PortableIntegrations,
  PortablePreferences,
  PortableRepository,
  RepositoryInfo,
  SettingsExport,
  SettingsSection,
  SettingsSyncStateName,
} from '@shared/types';
import { DEFAULT_SETTINGS } from '@shared/types';

export const SETTINGS_EXPORT_SCHEMA = 1;
export const GIST_DESCRIPTION = 'GitGood settings';
export const GIST_FILENAME = 'gitgood-settings.json';

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

/** Every key of PortablePreferences (excluding `ai`, built separately). Checked against the type so a field can never be added here without also updating PortablePreferences (and vice versa). */
const PREFERENCE_KEYS = {
  theme: true,
  confirmDiscardChanges: true,
  confirmDiscardChangesPermanently: true,
  confirmDiscardStash: true,
  confirmForcePush: true,
  confirmRepositoryRemoval: true,
  confirmUndoCommit: true,
  confirmCheckoutCommit: true,
  confirmCloseIssue: true,
  confirmMarkAllNotificationsRead: true,
  pullBehavior: true,
  uncommittedChangesStrategy: true,
  autoFetchIntervalMinutes: true,
  diffViewMode: true,
  diffHideWhitespace: true,
  diffShowIntraline: true,
  diffWrapLines: true,
  diffFontSize: true,
  diffSyntaxHighlighting: true,
  showCommitLengthWarning: true,
  repositoryIndicators: true,
  notifyPullRequestReviews: true,
  notifyPullRequestChecks: true,
  defaultCloneDirectory: true,
  defaultWorktreeDirectory: true,
  blameIgnoreWhitespace: true,
  staleBranchDays: true,
  healthLargeFileThresholdBytes: true,
  showUnpushedWorkIndicator: true,
  historyVerifySignatures: true,
  notificationsEnabled: true,
  notificationsPollIntervalMinutes: true,
  notifyMentions: true,
  notifyReviewRequests: true,
  ai: true,
} satisfies Record<keyof PortablePreferences, true>;

const AI_PREFERENCE_KEYS = {
  provider: true,
  model: true,
  effort: true,
  autoStageAfterResolve: true,
  reviewStrictness: true,
  reviewMaxFiles: true,
  reviewPostFooter: true,
} satisfies Record<keyof PortableAiSettings, true>;

const INTEGRATION_KEYS = {
  externalEditor: true,
  customEditorPath: true,
  shell: true,
  customShellPath: true,
} satisfies Record<keyof PortableIntegrations, true>;

const PREFERENCE_KEY_LIST = Object.keys(PREFERENCE_KEYS) as (keyof PortablePreferences)[];
const AI_PREFERENCE_KEY_LIST = Object.keys(AI_PREFERENCE_KEYS) as (keyof PortableAiSettings)[];
const INTEGRATION_KEY_LIST = Object.keys(INTEGRATION_KEYS) as (keyof PortableIntegrations)[];

const BOOLEAN_PREFERENCE_KEYS = new Set<keyof PortablePreferences>([
  'confirmDiscardChanges',
  'confirmDiscardChangesPermanently',
  'confirmDiscardStash',
  'confirmForcePush',
  'confirmRepositoryRemoval',
  'confirmUndoCommit',
  'confirmCheckoutCommit',
  'confirmCloseIssue',
  'confirmMarkAllNotificationsRead',
  'diffHideWhitespace',
  'diffShowIntraline',
  'diffWrapLines',
  'diffSyntaxHighlighting',
  'showCommitLengthWarning',
  'repositoryIndicators',
  'notifyPullRequestReviews',
  'notifyPullRequestChecks',
  'blameIgnoreWhitespace',
  'showUnpushedWorkIndicator',
  'historyVerifySignatures',
  'notificationsEnabled',
  'notifyMentions',
  'notifyReviewRequests',
]);
const NUMBER_PREFERENCE_KEYS = new Set<keyof PortablePreferences>(['autoFetchIntervalMinutes', 'diffFontSize', 'staleBranchDays', 'healthLargeFileThresholdBytes', 'notificationsPollIntervalMinutes']);
const STRING_PREFERENCE_KEYS = new Set<keyof PortablePreferences>(['defaultCloneDirectory', 'defaultWorktreeDirectory']);
const ENUM_PREFERENCE_KEYS: Partial<Record<keyof PortablePreferences, readonly string[]>> = {
  theme: ['system', 'light', 'dark'],
  pullBehavior: ['git-config', 'merge', 'rebase'],
  uncommittedChangesStrategy: ['ask', 'stash', 'move'],
  diffViewMode: ['unified', 'split'],
};
const AI_ENUM_KEYS: Partial<Record<keyof PortableAiSettings, readonly string[]>> = {
  provider: ['anthropic', 'claude-cli', 'disabled'],
  effort: ['low', 'medium', 'high', 'xhigh', 'max'],
  reviewStrictness: ['strict', 'balanced', 'thorough'],
};
const AI_STRING_KEYS = new Set<keyof PortableAiSettings>(['model']);
const AI_BOOLEAN_KEYS = new Set<keyof PortableAiSettings>(['autoStageAfterResolve', 'reviewPostFooter']);
const AI_NUMBER_KEYS = new Set<keyof PortableAiSettings>(['reviewMaxFiles']);

export function buildPortablePreferences(settings: AppSettings): PortablePreferences {
  const out: Record<string, unknown> = {};
  for (const key of PREFERENCE_KEY_LIST) {
    if (key === 'ai') continue;
    out[key] = settings[key as keyof AppSettings];
  }
  const ai: Record<string, unknown> = {};
  for (const key of AI_PREFERENCE_KEY_LIST) ai[key] = settings.ai[key];
  out.ai = ai;
  return out as unknown as PortablePreferences;
}

export function buildPortableIntegrations(settings: AppSettings): PortableIntegrations {
  const out: Record<string, unknown> = {};
  for (const key of INTEGRATION_KEY_LIST) out[key] = settings[key as keyof AppSettings];
  return out as unknown as PortableIntegrations;
}

/** Normalises Windows path separators for export; import keeps whatever it is given (see design.md). */
export function normalizeExportPath(path: string): string {
  return path.replace(/\\/g, '/');
}

export function buildPortableRepositories(repos: RepositoryInfo[]): PortableRepository[] {
  return repos.filter((r) => !r.worktreeOf && !r.parentRepoId).map((r) => ({ path: normalizeExportPath(r.path), alias: r.alias, github: r.github }));
}

export interface BuildExportOptions {
  sections: SettingsSection[];
  settings: AppSettings;
  repositories: RepositoryInfo[];
  appVersion: string;
  platform: string;
  now?: string;
}

export function buildSettingsExport(opts: BuildExportOptions): SettingsExport {
  const out: SettingsExport = { schema: SETTINGS_EXPORT_SCHEMA, app: 'gitgood', version: opts.appVersion, exportedAt: opts.now ?? new Date().toISOString(), platform: opts.platform };
  if (opts.sections.includes('preferences')) out.preferences = buildPortablePreferences(opts.settings);
  if (opts.sections.includes('repositories')) out.repositories = buildPortableRepositories(opts.repositories);
  if (opts.sections.includes('integrations')) out.integrations = buildPortableIntegrations(opts.settings);
  return out;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function validateAi(raw: unknown): { value: Partial<PortableAiSettings>; warnings: string[] } {
  const warnings: string[] = [];
  const value: Partial<PortableAiSettings> = {};
  if (!raw || typeof raw !== 'object') return { value, warnings };
  const obj = raw as Record<string, unknown>;
  const known = new Set<string>(AI_PREFERENCE_KEY_LIST);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      warnings.push(`preferences.ai.${key}: unknown field, ignored`);
      continue;
    }
    const v = obj[key];
    const k = key as keyof PortableAiSettings;
    if (AI_ENUM_KEYS[k]) {
      if (typeof v === 'string' && AI_ENUM_KEYS[k]!.includes(v)) (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.ai.${key}: unexpected value, ignored`);
    } else if (AI_STRING_KEYS.has(k)) {
      if (typeof v === 'string') (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.ai.${key}: expected a string, ignored`);
    } else if (AI_BOOLEAN_KEYS.has(k)) {
      if (typeof v === 'boolean') (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.ai.${key}: expected a boolean, ignored`);
    } else if (AI_NUMBER_KEYS.has(k)) {
      if (typeof v === 'number' && Number.isFinite(v)) (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.ai.${key}: expected a number, ignored`);
    }
  }
  return { value, warnings };
}

function validatePreferences(raw: unknown): { value: Partial<PortablePreferences>; warnings: string[] } {
  const warnings: string[] = [];
  const value: Partial<PortablePreferences> = {};
  if (!raw || typeof raw !== 'object') {
    warnings.push('preferences: expected an object, ignored');
    return { value, warnings };
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set<string>(PREFERENCE_KEY_LIST);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      warnings.push(`preferences.${key}: unknown field, ignored`);
      continue;
    }
    const v = obj[key];
    const k = key as keyof PortablePreferences;
    if (k === 'ai') {
      const { value: aiValue, warnings: aiWarnings } = validateAi(v);
      if (Object.keys(aiValue).length) value.ai = aiValue as PortableAiSettings;
      warnings.push(...aiWarnings);
      continue;
    }
    if (BOOLEAN_PREFERENCE_KEYS.has(k)) {
      if (typeof v === 'boolean') (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.${key}: expected a boolean, ignored`);
    } else if (NUMBER_PREFERENCE_KEYS.has(k)) {
      if (typeof v === 'number' && Number.isFinite(v)) (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.${key}: expected a number, ignored`);
    } else if (STRING_PREFERENCE_KEYS.has(k)) {
      if (typeof v === 'string') (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.${key}: expected a string, ignored`);
    } else if (ENUM_PREFERENCE_KEYS[k]) {
      if (typeof v === 'string' && ENUM_PREFERENCE_KEYS[k]!.includes(v)) (value as Record<string, unknown>)[k] = v;
      else warnings.push(`preferences.${key}: unexpected value, ignored`);
    }
  }
  return { value, warnings };
}

function validateIntegrations(raw: unknown): { value: Partial<PortableIntegrations>; warnings: string[] } {
  const warnings: string[] = [];
  const value: Partial<PortableIntegrations> = {};
  if (!raw || typeof raw !== 'object') {
    warnings.push('integrations: expected an object, ignored');
    return { value, warnings };
  }
  const obj = raw as Record<string, unknown>;
  const known = new Set<string>(INTEGRATION_KEY_LIST);
  for (const key of Object.keys(obj)) {
    if (!known.has(key)) {
      warnings.push(`integrations.${key}: unknown field, ignored`);
      continue;
    }
    const v = obj[key];
    if (v === null || typeof v === 'string') (value as Record<string, unknown>)[key] = v;
    else warnings.push(`integrations.${key}: expected a string or null, ignored`);
  }
  return { value, warnings };
}

function isGitHubRepoRef(v: unknown): v is GitHubRepoRef {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  return typeof o.host === 'string' && typeof o.owner === 'string' && typeof o.name === 'string' && typeof o.url === 'string';
}

function validateRepositories(raw: unknown[]): { value: PortableRepository[]; warnings: string[] } {
  const warnings: string[] = [];
  const value: PortableRepository[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== 'object' || typeof (entry as Record<string, unknown>).path !== 'string' || !(entry as Record<string, unknown>).path) {
      warnings.push(`repositories[${i}]: missing a path, skipped`);
      return;
    }
    const o = entry as Record<string, unknown>;
    const alias = typeof o.alias === 'string' ? o.alias : null;
    const github = isGitHubRepoRef(o.github) ? o.github : null;
    if (o.github !== undefined && o.github !== null && !github) warnings.push(`repositories[${i}].github: malformed, ignored`);
    value.push({ path: o.path as string, alias, github });
  });
  return { value, warnings };
}

export type ValidateSettingsExportResult = { ok: true; data: SettingsExport; warnings: string[] } | { ok: false; error: string };

/**
 * Validates a parsed JSON value as a GitGood settings export. Envelope
 * fields (schema/app/version/exportedAt/platform) and section shapes
 * (`repositories` must be an array, `preferences`/`integrations` objects)
 * are validated strictly and refuse the whole import on failure. Fields
 * inside a section are validated individually and dropped with a warning
 * rather than refusing the import, so a partial or hand-edited file (e.g.
 * one that only changes the theme) still imports the fields it got right.
 */
export function validateSettingsExport(raw: unknown): ValidateSettingsExportResult {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'This file is not a GitGood settings export.' };
  const obj = raw as Record<string, unknown>;
  const badFields: string[] = [];
  if (obj.app !== 'gitgood') badFields.push('app');
  if (typeof obj.schema !== 'number') badFields.push('schema');
  if (typeof obj.version !== 'string') badFields.push('version');
  if (typeof obj.exportedAt !== 'string') badFields.push('exportedAt');
  if (typeof obj.platform !== 'string') badFields.push('platform');
  if (badFields.length) return { ok: false, error: `This file is not a valid GitGood settings export (invalid: ${badFields.join(', ')}).` };
  if ((obj.schema as number) > SETTINGS_EXPORT_SCHEMA) return { ok: false, error: 'This file was exported by a newer version of GitGood. Update GitGood to import it.' };

  const warnings: string[] = [];
  const data: SettingsExport = { schema: SETTINGS_EXPORT_SCHEMA, app: 'gitgood', version: obj.version as string, exportedAt: obj.exportedAt as string, platform: obj.platform as string };

  if (obj.preferences !== undefined) {
    const { value, warnings: w } = validatePreferences(obj.preferences);
    data.preferences = value;
    warnings.push(...w);
  }
  if (obj.integrations !== undefined) {
    const { value, warnings: w } = validateIntegrations(obj.integrations);
    data.integrations = value;
    warnings.push(...w);
  }
  if (obj.repositories !== undefined) {
    if (!Array.isArray(obj.repositories)) return { ok: false, error: 'This file is not a valid GitGood settings export (invalid: repositories).' };
    const { value, warnings: w } = validateRepositories(obj.repositories);
    data.repositories = value;
    warnings.push(...w);
  }

  const knownTop = new Set(['schema', 'app', 'version', 'exportedAt', 'platform', 'preferences', 'repositories', 'integrations']);
  for (const key of Object.keys(obj)) if (!knownTop.has(key)) warnings.push(`${key}: unknown top-level field, ignored`);

  return { ok: true, data, warnings };
}

// ---------------------------------------------------------------------------
// Merge / replace patch building
// ---------------------------------------------------------------------------

const DEFAULT_PORTABLE_PREFERENCES = buildPortablePreferences(DEFAULT_SETTINGS);
const DEFAULT_PORTABLE_INTEGRATIONS = buildPortableIntegrations(DEFAULT_SETTINGS);

/**
 * Builds the AppSettings patch for importing `incoming` preferences.
 * Merge only overlays fields present in `incoming` (others keep their
 * current value); Replace starts every portable preference field from
 * DEFAULT_SETTINGS and then overlays `incoming` on top, so fields omitted
 * from the file return to defaults. Either way, fields outside the
 * allowlist (gitPath, ghPath, ai.hasApiKey, ai.claudeCliPath, …) are left
 * untouched because they are never part of `incoming`.
 */
export function buildPreferencesPatch(current: AppSettings, incoming: Partial<PortablePreferences>, mode: 'merge' | 'replace'): Partial<AppSettings> {
  const base = mode === 'replace' ? DEFAULT_PORTABLE_PREFERENCES : buildPortablePreferences(current);
  const { ai: baseAi, ...baseRest } = base;
  const { ai: incomingAi, ...incomingRest } = incoming;
  const patch: Partial<AppSettings> = { ...baseRest, ...incomingRest };
  patch.ai = { ...current.ai, ...baseAi, ...(incomingAi ?? {}) } as AiSettings;
  return patch;
}

export interface IntegrationsPatchResult {
  patch: Partial<AppSettings>;
  warnings: string[];
}

/**
 * Same merge/replace shape as buildPreferencesPatch, but also skips
 * `custom*Path` fields (filesystem paths) when the file's platform differs
 * from this machine's, per the "other-platform tool path" requirement.
 */
export function buildIntegrationsPatch(current: AppSettings, incoming: Partial<PortableIntegrations>, mode: 'merge' | 'replace', filePlatform: string, thisPlatform: string): IntegrationsPatchResult {
  const warnings: string[] = [];
  const filtered: Partial<PortableIntegrations> = { ...incoming };
  if (filePlatform !== thisPlatform) {
    for (const key of ['customEditorPath', 'customShellPath'] as const) {
      if (filtered[key]) {
        warnings.push(`integrations.${key}: skipped (exported on ${filePlatform}, this machine is ${thisPlatform})`);
        delete filtered[key];
      }
    }
  }
  const base = mode === 'replace' ? DEFAULT_PORTABLE_INTEGRATIONS : buildPortableIntegrations(current);
  const patch: Partial<AppSettings> = { ...base, ...filtered };
  return { patch, warnings };
}

// ---------------------------------------------------------------------------
// Repository import
// ---------------------------------------------------------------------------

function normalizePathForCompare(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

function sameGithubRef(a: GitHubRepoRef | null, b: GitHubRepoRef | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.host === b.host && a.owner === b.owner && a.name === b.name && a.url === b.url;
}

export interface RepositoryImportEntry {
  path: string;
  alias: string | null;
  github: GitHubRepoRef | null;
  existing: RepositoryInfo | null;
  changed: boolean;
}

export interface RepositoryImportPlan {
  entries: RepositoryImportEntry[];
  adds: number;
  changes: number;
  skipped: number;
}

/** Repository import is always additive (never removes a repository not present in the file): see design deviation notes. */
export function planRepositoryImport(current: RepositoryInfo[], incoming: PortableRepository[]): RepositoryImportPlan {
  const byPath = new Map(current.filter((r) => !r.worktreeOf && !r.parentRepoId).map((r) => [normalizePathForCompare(r.path), r]));
  let adds = 0;
  let changes = 0;
  let skipped = 0;
  const entries: RepositoryImportEntry[] = [];
  for (const repo of incoming) {
    if (!repo.path || !repo.path.trim()) {
      skipped++;
      continue;
    }
    const existing = byPath.get(normalizePathForCompare(repo.path)) ?? null;
    if (!existing) {
      adds++;
      entries.push({ path: repo.path, alias: repo.alias, github: repo.github, existing: null, changed: true });
      continue;
    }
    const changed = existing.alias !== repo.alias || !sameGithubRef(existing.github, repo.github);
    if (changed) changes++;
    else skipped++;
    entries.push({ path: repo.path, alias: repo.alias, github: repo.github, existing, changed });
  }
  return { entries, adds, changes, skipped };
}

export function applyRepositoryImport(current: RepositoryInfo[], incoming: PortableRepository[], idFor: (path: string) => string, pathExists: (path: string) => boolean): RepositoryInfo[] {
  const plan = planRepositoryImport(current, incoming);
  let next = current;
  for (const entry of plan.entries) {
    if (entry.existing) {
      if (!entry.changed) continue;
      const id = entry.existing.id;
      next = next.map((r) => (r.id === id ? { ...r, alias: entry.alias, github: entry.github } : r));
    } else {
      const name = entry.path.split('/').filter(Boolean).pop() || entry.path;
      next = [...next, { id: idFor(entry.path), path: entry.path, name, alias: entry.alias, missing: !pathExists(entry.path), github: entry.github, lastOpened: 0, indicator: null, worktreeOf: null, parentRepoId: null }];
    }
  }
  return next;
}

// ---------------------------------------------------------------------------
// Import preview
// ---------------------------------------------------------------------------

export interface ImportPreviewInputs {
  file: SettingsExport;
  currentSettings: AppSettings;
  currentRepositories: RepositoryInfo[];
  pathExists: (path: string) => boolean;
  filePlatform: string;
  thisPlatform: string;
  /** Warnings already collected while validating the file. */
  validationWarnings: string[];
}

function countPreferenceChanges(current: AppSettings, incoming: Partial<PortablePreferences>): number {
  let changes = 0;
  for (const key of Object.keys(incoming) as (keyof PortablePreferences)[]) {
    if (key === 'ai') {
      const incomingAi = incoming.ai;
      if (incomingAi) for (const ak of Object.keys(incomingAi) as (keyof PortableAiSettings)[]) if (current.ai[ak] !== incomingAi[ak]) changes++;
      continue;
    }
    if ((current as unknown as Record<string, unknown>)[key] !== (incoming as Record<string, unknown>)[key]) changes++;
  }
  return changes;
}

function countIntegrationChanges(current: AppSettings, incoming: Partial<PortableIntegrations>): number {
  let changes = 0;
  for (const key of Object.keys(incoming) as (keyof PortableIntegrations)[]) if ((current as unknown as Record<string, unknown>)[key] !== (incoming as Record<string, unknown>)[key]) changes++;
  return changes;
}

export function buildImportPreview(inputs: ImportPreviewInputs): ImportPreview {
  const sections: ImportPreviewSection[] = [];
  const missingRepositories: string[] = [];
  const warnings = [...inputs.validationWarnings];

  if (inputs.file.preferences) {
    sections.push({ name: 'preferences', adds: 0, changes: countPreferenceChanges(inputs.currentSettings, inputs.file.preferences), skipped: 0 });
  }
  if (inputs.file.integrations) {
    const { warnings: skipWarnings } = buildIntegrationsPatch(inputs.currentSettings, inputs.file.integrations, 'merge', inputs.filePlatform, inputs.thisPlatform);
    warnings.push(...skipWarnings);
    const filtered = { ...inputs.file.integrations };
    if (inputs.filePlatform !== inputs.thisPlatform) {
      delete filtered.customEditorPath;
      delete filtered.customShellPath;
    }
    sections.push({ name: 'integrations', adds: 0, changes: countIntegrationChanges(inputs.currentSettings, filtered), skipped: skipWarnings.length });
  }
  if (inputs.file.repositories) {
    const plan = planRepositoryImport(inputs.currentRepositories, inputs.file.repositories);
    sections.push({ name: 'repositories', adds: plan.adds, changes: plan.changes, skipped: plan.skipped });
    for (const repo of inputs.file.repositories) if (repo.path && !inputs.pathExists(repo.path)) missingRepositories.push(repo.path);
  }

  return { sections, missingRepositories, warnings };
}

// ---------------------------------------------------------------------------
// Gist sync state
// ---------------------------------------------------------------------------

/** djb2 hash rendered as hex; stable across processes without a crypto dependency (mirrors the one in ai/review-core.ts, kept local so this module has zero dependencies). */
export function stableHash(text: string): string {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) >>> 0;
  let h2 = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h2 ^= text.charCodeAt(i);
    h2 = Math.imul(h2, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export interface ResolveSyncStateInput {
  gistFound: boolean;
  localHash: string;
  /** null when the remote content could not be read (distinct from an empty file). */
  remoteHash: string | null;
  /** Hash recorded the last time this machine successfully uploaded or downloaded. */
  lastHash: string | null;
}

/**
 * "Which side is newer", compared by content hash rather than timestamps
 * (exact, and avoids relying on clock sync between machines): a side is
 * "changed" when its hash no longer matches the hash recorded at the last
 * successful sync. Never merges silently; the caller always presents the
 * comparison and lets the user choose upload or download.
 */
export function resolveSyncState(input: ResolveSyncStateInput): SettingsSyncStateName {
  if (!input.gistFound) return 'gist-missing';
  if (input.remoteHash === null) return 'diverged';
  const localChanged = input.localHash !== input.lastHash;
  const remoteChanged = input.remoteHash !== input.lastHash;
  if (!localChanged && !remoteChanged) return 'up-to-date';
  if (localChanged && !remoteChanged) return 'local-newer';
  if (!localChanged && remoteChanged) return 'remote-newer';
  return 'diverged';
}

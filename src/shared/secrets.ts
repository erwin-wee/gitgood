/** Order matters only in that every pattern is applied; they do not overlap. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***'],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, 'gho_***'],
  [/\bghu_[A-Za-z0-9]{20,}\b/g, 'ghu_***'],
  [/\bghs_[A-Za-z0-9]{20,}\b/g, 'ghs_***'],
  [/\bghr_[A-Za-z0-9]{20,}\b/g, 'ghr_***'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, 'sk-ant-***'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g, 'sk-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [/\bANTHROPIC_API_KEY=\S+/g, 'ANTHROPIC_API_KEY=***'],
  // URL userinfo, any scheme: https://user:pass@host, ssh://user:pass@host, ...
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/g, '$1***:***@'],
];

/** Masks known secret shapes (GitHub tokens, bearer tokens, URL userinfo, Anthropic/OpenAI API keys, AWS access key ids). Pure string transform; never throws. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

/** `.npmrc` / `.pypirc` only matter when they carry credentials. */
const CREDENTIAL_ASSIGNMENT = /(?:_auth(?:Token)?|_password|password|token|secret)\s*[=:]/i;

/**
 * Why a file must never be uploaded to an AI provider, or null when it may be.
 * Deliberately short and obvious: env files (not `.env.example`-style
 * templates), private keys/certificates, SSH identities (not `.pub`), `.netrc`,
 * `credentials*.json`, and `.npmrc`/`.pypirc` that hold credentials. For those
 * two, `content` (the file or its diff text) decides; without it they are
 * treated as holding credentials.
 */
export function secretFileReason(path: string, content?: string): string | null {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if ((base === '.env' || base.startsWith('.env.')) && !/\.(example|sample|template|dist)$/.test(base)) return 'environment file (may contain secrets)';
  if (/\.(pem|key|p12|pfx)$/.test(base)) return 'private key or certificate';
  if (/^id_(rsa|ed25519)/.test(base) && !base.endsWith('.pub')) return 'SSH private key';
  if (base === '.netrc') return 'credentials file';
  if (/^credentials.*\.json$/.test(base)) return 'credentials file';
  if ((base === '.npmrc' || base === '.pypirc') && (content === undefined || CREDENTIAL_ASSIGNMENT.test(content))) return 'registry config with credentials';
  return null;
}

/**
 * Removes the per-file blocks of secret-shaped files (see `secretFileReason`) from a git patch.
 * `skipped` lists what was removed as `path: reason`, for showing to the user.
 */
export function dropSecretFilePatches(patch: string): { patch: string; skipped: string[] } {
  const skipped: string[] = [];
  const kept = patch.split(/(?=^diff --git )/m).filter((block) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(block);
    const reason = m && secretFileReason(m[2], block);
    if (reason) skipped.push(`${m[2]}: ${reason}`);
    return !reason;
  });
  return { patch: kept.join(''), skipped };
}

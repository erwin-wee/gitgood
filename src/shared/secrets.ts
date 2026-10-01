/** Order matters only in that every pattern is applied; they do not overlap. */
const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bghp_[A-Za-z0-9]{20,}\b/g, 'ghp_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, 'github_pat_***'],
  [/\bgho_[A-Za-z0-9]{20,}\b/g, 'gho_***'],
  [/\bghu_[A-Za-z0-9]{20,}\b/g, 'ghu_***'],
  [/\bghs_[A-Za-z0-9]{20,}\b/g, 'ghs_***'],
  [/\bghr_[A-Za-z0-9]{20,}\b/g, 'ghr_***'],
  [/\bsk-ant-[A-Za-z0-9_-]{10,}\b/g, 'sk-ant-***'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [/\bANTHROPIC_API_KEY=\S+/g, 'ANTHROPIC_API_KEY=***'],
  // URL userinfo, any scheme: https://user:pass@host, ssh://user:pass@host, ...
  [/([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s:@]+@/g, '$1***:***@'],
];

/** Masks known secret shapes (GitHub tokens, bearer tokens, URL userinfo, Anthropic API keys). Pure string transform; never throws. */
export function scrubSecrets(text: string): string {
  let out = text;
  for (const [re, replacement] of SECRET_PATTERNS) out = out.replace(re, replacement);
  return out;
}

import type { ConflictBlock, InProgressOperation } from '@shared/types';

export const RESOLUTION_SCHEMA = {
  type: 'object',
  properties: {
    resolutions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: 'The conflict block number exactly as given.' },
          resolved: { type: 'string', description: 'The complete replacement for the conflict block: raw file lines only, no conflict markers.' },
          rationale: { type: 'string', description: 'One sentence explaining how both sides were reconciled.' },
          confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
        },
        required: ['id', 'resolved', 'rationale', 'confidence'],
        additionalProperties: false,
      },
    },
  },
  required: ['resolutions'],
  additionalProperties: false,
} as const;

export const COMMIT_MESSAGE_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Imperative commit summary, at most 72 characters, no trailing period.' },
    description: { type: 'string', description: 'Optional body explaining what and why. Empty string when the summary suffices.' },
  },
  required: ['summary', 'description'],
  additionalProperties: false,
} as const;

export const RESOLVE_SYSTEM_PROMPT = `You are an expert software engineer resolving Git merge conflicts for a developer who will review the result in a diff viewer before committing.

You receive one file's conflict blocks, each with surrounding context, plus what each side of the merge was trying to do. For every block, produce the final text that replaces the entire block (everything from the <<<<<<< line through the >>>>>>> line, inclusive).

Guidelines:
- Integrate the intent of both sides. When both sides changed the same lines for different purposes, combine them so both purposes are served. When both made the same change in slightly different ways, keep one coherent version. Never silently drop a change unless one side clearly supersedes the other (for example a deletion of code that the other side merely reformatted).
- Use the base version, when provided, to understand what each side changed relative to the common ancestor.
- Keep the resolved code consistent with the surrounding context: imports, variable names, brace balance, indentation style, and trailing commas.
- Preserve the file's indentation and style exactly. Output raw lines only: no conflict markers, no code fences, no comments explaining the merge.
- Return only the replacement for the block itself, without the context lines that surround it.
- An empty string is a valid resolution when the correct result is to remove the code.
- Set confidence to "low" when the correct result depends on information you do not have, and say what is uncertain in the rationale. Keep every rationale to one sentence.`;

export const COMMIT_MESSAGE_SYSTEM_PROMPT = `You write Git commit messages for a developer reviewing their staged changes in a desktop Git client.
Write a summary line in the imperative mood (for example "Add retry to fetch queue"), at most 72 characters, without a trailing period.
Add a description only when the change needs explanation beyond the summary: describe the intent and any notable decisions in plain sentences, wrapped at about 72 characters. Do not list every file.`;

export interface ResolvePromptInput {
  filePath: string;
  language: string | null;
  operation: InProgressOperation;
  currentBranch: string | null;
  oursLabel: string;
  theirsLabel: string;
  oursCommits: string[];
  theirsCommits: string[];
  lines: string[];
  blocks: ConflictBlock[];
  hasBase: boolean;
}

function describeOperation(op: InProgressOperation, currentBranch: string | null, oursLabel: string, theirsLabel: string): string {
  switch (op.kind) {
    case 'merge':
      return `Merging "${op.targetName ?? op.targetSha?.slice(0, 7) ?? theirsLabel}" into "${currentBranch ?? oursLabel}". "Ours" is ${currentBranch ?? 'the current branch'}; "theirs" is the branch being merged in.`;
    case 'rebase':
      return `Rebasing "${op.headName ?? theirsLabel}" onto "${op.ontoName ?? op.onto?.slice(0, 7) ?? oursLabel}"${op.current && op.total ? ` (commit ${op.current} of ${op.total})` : ''}. Note the inverted labels during a rebase: "ours" is the upstream branch being rebased onto, "theirs" is the commit from "${op.headName ?? 'the rebased branch'}" being replayed.`;
    case 'cherry-pick':
      return `Cherry-picking commit ${op.targetSha?.slice(0, 7) ?? ''} onto "${currentBranch ?? oursLabel}". "Ours" is the current branch; "theirs" is the cherry-picked commit.`;
    case 'revert':
      return `Reverting commit ${op.targetSha?.slice(0, 7) ?? ''} on "${currentBranch ?? oursLabel}". "Theirs" represents the state the revert wants to restore.`;
    default:
      return `Resolving conflicts on "${currentBranch ?? oursLabel}".`;
  }
}

const CONTEXT_LINES = 40;

export function buildResolvePrompt(input: ResolvePromptInput): string {
  const parts: string[] = [];
  parts.push(`File: ${input.filePath}${input.language ? ` (${input.language})` : ''}`);
  parts.push(describeOperation(input.operation, input.currentBranch, input.oursLabel, input.theirsLabel));
  if (input.oursCommits.length) parts.push(`Recent commits on the "ours" side touching this file:\n${input.oursCommits.map((c) => `- ${c}`).join('\n')}`);
  if (input.theirsCommits.length) parts.push(`Recent commits on the "theirs" side touching this file:\n${input.theirsCommits.map((c) => `- ${c}`).join('\n')}`);
  parts.push(`There ${input.blocks.length === 1 ? 'is 1 conflict block' : `are ${input.blocks.length} conflict blocks`}. Line numbers are 1-based positions in the current file.`);

  input.blocks.forEach((block, idx) => {
    const prevEnd = idx > 0 ? input.blocks[idx - 1].end : 0;
    const nextStart = idx + 1 < input.blocks.length ? input.blocks[idx + 1].start : input.lines.length;
    const beforeStart = Math.max(prevEnd, block.start - CONTEXT_LINES);
    const afterEnd = Math.min(nextStart, block.end + CONTEXT_LINES);
    const before = input.lines.slice(beforeStart, block.start);
    const after = input.lines.slice(block.end, afterEnd);
    const section: string[] = [];
    section.push(`### Conflict ${block.id} (lines ${block.start + 1}-${block.end})`);
    if (before.length) section.push(`Context before (unchanged, do not include in the resolution):\n${before.join('\n')}`);
    section.push(`<<<<<<< OURS (${block.oursLabel})\n${block.ours.join('\n')}`);
    if (block.base) section.push(`||||||| BASE (common ancestor)\n${block.base.join('\n')}`);
    section.push(`=======\n${block.theirs.join('\n')}\n>>>>>>> THEIRS (${block.theirsLabel})`);
    if (after.length) section.push(`Context after (unchanged, do not include in the resolution):\n${after.join('\n')}`);
    parts.push(section.join('\n'));
  });
  parts.push(`Return a resolution for every conflict id from ${input.blocks[0]?.id ?? 0} to ${input.blocks[input.blocks.length - 1]?.id ?? 0}.`);
  return parts.join('\n\n');
}

export function buildCommitMessagePrompt(stat: string, patch: string, truncated: boolean, branch: string | null): string {
  return [
    branch ? `Branch: ${branch}` : null,
    `Change summary:\n${stat.trim() || '(no stat available)'}`,
    `Diff${truncated ? ' (truncated; the summary above covers all files)' : ''}:\n${patch}`,
    'Write the commit message for these changes.',
  ]
    .filter(Boolean)
    .join('\n\n');
}

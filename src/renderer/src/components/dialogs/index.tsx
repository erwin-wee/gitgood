import React from 'react';
import { useAppStore } from '../../state/store';
import { CommandPalette } from '../CommandPalette';
import { CherryPickDialog, CompareDialog, DeleteBranchDialog, MergeDialog, NewBranchDialog, RenameBranchDialog, UncommittedChangesDialog } from './BranchDialogs';
import { ConfirmDialog, DiscardDialog, DiscardLinesDialog, ErrorDialog, RewordDialog, SigningFailedDialog, SquashDialog, TagDialog } from './CommitDialogs';
import { ConflictsDialog } from './ConflictsDialog';
import { CreatePullRequestDialog, ForcePushDialog, PullRequestDetailsDialog, SignInDialog } from './GitHubDialogs';
import { BulkDeleteBranchesDialog } from './HealthDialogs';
import { FileAtCommitDialog } from './HistoryDialogs';
import { IssuesDialog, NewIssueDialog } from './IssueDialogs';
import { LfsDialog } from './LfsDialogs';
import { AddRepoDialog, CloneDialog, NewRepoDialog, PublishDialog, RemoveRepoDialog, RepoSettingsDialog } from './RepoDialogs';
import { TidyBranchDialog } from './RebaseDialogs';
import { ReleaseNotesDialog } from './ReleaseNotesDialog';
import { ResolutionPopoverDialog } from './ResolutionPopover';
import { SplitPlanDialog } from './SplitDialogs';
import { TrustRepoCheckDialog } from './TrustRepoCheckDialog';
import { PostReviewDialog, PrecommitReviewGateDialog, ReviewPreflightDialog } from './ReviewDialogs';
import { AboutDialog, SettingsDialog, ShortcutsDialog, UpdateNotesDialog } from './SettingsDialog';
import { ExportSettingsDialog, ImportSettingsDialog } from './SettingsSyncDialogs';
import { BranchFromStashDialog, StashSelectedFilesDialog } from './StashDialogs';
import { SubmodulesDialog } from './SubmoduleDialogs';
import { AddWorktreeDialog, LockWorktreeDialog, PruneWorktreesDialog, RemoveWorktreeDialog, WorktreesDialog } from './WorktreeDialogs';

export function Dialogs(): React.JSX.Element | null {
  const dialog = useAppStore((s) => s.dialog);
  if (!dialog) return null;
  switch (dialog.kind) {
    case 'clone':
      return <CloneDialog initialUrl={dialog.url} />;
    case 'new-repo':
      return <NewRepoDialog />;
    case 'add-repo':
      return <AddRepoDialog />;
    case 'remove-repo':
      return <RemoveRepoDialog repo={dialog.repo} />;
    case 'publish':
      return <PublishDialog />;
    case 'repo-settings':
      return <RepoSettingsDialog tab={dialog.tab} />;
    case 'new-branch':
      return <NewBranchDialog startPoint={dialog.startPoint} startPointLabel={dialog.startPointLabel} initialName={dialog.initialName} />;
    case 'rename-branch':
      return <RenameBranchDialog branch={dialog.branch} />;
    case 'delete-branch':
      return <DeleteBranchDialog branch={dialog.branch} />;
    case 'merge':
      return <MergeDialog squash={dialog.squash} preselect={dialog.preselect} />;
    case 'rebase':
      return <MergeDialog squash={false} rebase preselect={dialog.preselect} />;
    case 'compare':
      return <CompareDialog />;
    case 'cherry-pick':
      return <CherryPickDialog shas={dialog.shas} />;
    case 'uncommitted-changes':
      return <UncommittedChangesDialog targetLabel={dialog.targetLabel} proceed={dialog.proceed} />;
    case 'discard':
      return <DiscardDialog paths={dialog.paths} all={dialog.all} />;
    case 'discard-lines':
      return <DiscardLinesDialog path={dialog.path} patch={dialog.patch} count={dialog.count} />;
    case 'confirm':
      return <ConfirmDialog title={dialog.title} message={dialog.message} confirmLabel={dialog.confirmLabel} danger={dialog.danger} onConfirm={dialog.onConfirm} checkbox={dialog.checkbox} />;
    case 'error':
      return <ErrorDialog title={dialog.title} error={dialog.error} retry={dialog.retry} />;
    case 'squash':
      return <SquashDialog shas={dialog.shas} targetSha={dialog.targetSha} />;
    case 'reword':
      return <RewordDialog commit={dialog.commit} />;
    case 'tag':
      return <TagDialog sha={dialog.sha} />;
    case 'sign-in':
      return <SignInDialog />;
    case 'force-push':
      return <ForcePushDialog />;
    case 'create-pr':
      return <CreatePullRequestDialog autoDraft={dialog.autoDraft} />;
    case 'pr-details':
      return <PullRequestDetailsDialog pr={dialog.pr} />;
    case 'conflicts':
      return <ConflictsDialog />;
    case 'settings':
      return <SettingsDialog tab={dialog.tab} />;
    case 'about':
      return <AboutDialog />;
    case 'shortcuts':
      return <ShortcutsDialog />;
    case 'review-preflight':
      return <ReviewPreflightDialog target={dialog.target} />;
    case 'review-post':
      return <PostReviewDialog />;
    case 'precommit-review-gate':
      return <PrecommitReviewGateDialog run={dialog.run} onCommitAnyway={dialog.onCommitAnyway} />;
    case 'branch-from-stash':
      return <BranchFromStashDialog stash={dialog.stash} />;
    case 'stash-selected-files':
      return <StashSelectedFilesDialog paths={dialog.paths} />;
    case 'worktrees':
      return <WorktreesDialog />;
    case 'add-worktree':
      return <AddWorktreeDialog startBranch={dialog.startBranch} />;
    case 'remove-worktree':
      return <RemoveWorktreeDialog worktree={dialog.worktree} />;
    case 'lock-worktree':
      return <LockWorktreeDialog worktree={dialog.worktree} />;
    case 'prune-worktrees':
      return <PruneWorktreesDialog worktrees={dialog.worktrees} />;
    case 'file-at-commit':
      return <FileAtCommitDialog path={dialog.path} sha={dialog.sha} />;
    case 'submodules':
      return <SubmodulesDialog />;
    case 'lfs':
      return <LfsDialog />;
    case 'bulk-delete-branches':
      return <BulkDeleteBranchesDialog branches={dialog.branches} />;
    case 'signing-failed':
      return <SigningFailedDialog error={dialog.error} onRetry={dialog.onRetry} onUnsigned={dialog.onUnsigned} />;
    case 'issues':
      return <IssuesDialog number={dialog.number} />;
    case 'new-issue':
      return <NewIssueDialog owner={dialog.owner ?? null} />;
    case 'export-settings':
      return <ExportSettingsDialog />;
    case 'import-settings':
      return <ImportSettingsDialog />;
    case 'update-notes':
      return <UpdateNotesDialog version={dialog.version} notes={dialog.notes} url={dialog.url} />;
    case 'release-notes':
      return <ReleaseNotesDialog fromTag={dialog.fromTag} />;
    case 'split-plan':
      return <SplitPlanDialog />;
    case 'tidy-branch':
      return <TidyBranchDialog />;
    case 'trust-repo-check':
      return <TrustRepoCheckDialog repoPath={dialog.repoPath} command={dialog.command} onDecision={dialog.onDecision} />;
    case 'resolution-popover':
      return <ResolutionPopoverDialog path={dialog.path} blockId={dialog.blockId} />;
    case 'command-palette':
      return <CommandPalette />;
    case 'stash-conflict':
    case 'edit-commit-message':
      return null;
  }
}

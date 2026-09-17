import React from 'react';
import { useAppStore } from '../../state/store';
import { CherryPickDialog, CompareDialog, DeleteBranchDialog, MergeDialog, NewBranchDialog, RenameBranchDialog, UncommittedChangesDialog } from './BranchDialogs';
import { ConfirmDialog, DiscardDialog, DiscardLinesDialog, ErrorDialog, RewordDialog, SquashDialog, TagDialog } from './CommitDialogs';
import { ConflictsDialog } from './ConflictsDialog';
import { CreatePullRequestDialog, ForcePushDialog, PullRequestDetailsDialog, SignInDialog } from './GitHubDialogs';
import { AddRepoDialog, CloneDialog, NewRepoDialog, PublishDialog, RemoveRepoDialog, RepoSettingsDialog } from './RepoDialogs';
import { AboutDialog, SettingsDialog, ShortcutsDialog } from './SettingsDialog';

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
      return <NewBranchDialog startPoint={dialog.startPoint} startPointLabel={dialog.startPointLabel} />;
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
      return <CreatePullRequestDialog />;
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
    case 'stash-conflict':
    case 'edit-commit-message':
      return null;
  }
}

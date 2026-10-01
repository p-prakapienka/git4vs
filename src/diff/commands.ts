import * as vscode from 'vscode';
import * as path from 'path';
import { BuiltInGitApi, makeRepoContext, pickRepository } from '../git/gitApi';
import { CommitInfo, Porcelain } from '../git/porcelain';
import { encodeRevisionUri, refLabel } from './revisionProvider';
import { ChangelistManager } from '../changelists/manager';
import { ChangelistNode } from '../changelists/treeView';

const HISTORY_PAGE = 200;

/** Repo-relative, forward-slashed path for a file URI. */
export function relPath(root: vscode.Uri, file: vscode.Uri): string {
  return path.relative(root.fsPath, file.fsPath).split(path.sep).join('/');
}

async function openDiff(
  left: vscode.Uri,
  right: vscode.Uri,
  title: string,
): Promise<void> {
  const preview = !vscode.workspace
    .getConfiguration('ideaGit')
    .get<boolean>('diff.openSideBySide', true);
  await vscode.commands.executeCommand('vscode.diff', left, right, title, {
    preview,
  });
}

function activeFileUri(explicit?: vscode.Uri): vscode.Uri | undefined {
  if (explicit) return explicit;
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.scheme === 'file' ? editor.document.uri : undefined;
}

function commitPickItems(commits: CommitInfo[]): Array<vscode.QuickPickItem & { commit: CommitInfo }> {
  return commits.map((c) => ({
    label: `$(git-commit) ${c.subject || '(no subject)'}`,
    description: c.shortHash,
    detail: `${c.authorName} · ${c.authorDate.toLocaleString()}${
      c.refs.length ? ` · ${c.refs.join(', ')}` : ''
    }`,
    commit: c,
  }));
}

/** Compare the file in the editor against a revision picked from its history. */
export async function compareWithRevision(
  api: BuiltInGitApi,
  explicit?: vscode.Uri,
): Promise<void> {
  const file = activeFileUri(explicit);
  if (!file) {
    vscode.window.showInformationMessage('Open a file to compare it with a revision.');
    return;
  }

  const repository = await pickRepository(api, file);
  if (!repository) return;

  const repo = makeRepoContext(api, repository);
  const porcelain = new Porcelain(repo.git);
  const rel = relPath(repo.root, file);

  const commits = await porcelain.log({ maxCount: HISTORY_PAGE, path: rel });
  if (commits.length === 0) {
    vscode.window.showInformationMessage(`No history found for ${rel}.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(commitPickItems(commits), {
    title: `Compare ${path.basename(rel)} with revision`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  await openDiff(
    encodeRevisionUri(repo.root.fsPath, picked.commit.hash, rel),
    file,
    `${path.basename(rel)} (${picked.commit.shortHash} ↔ working tree)`,
  );
}

export async function compareWithBranch(
  api: BuiltInGitApi,
  explicit?: vscode.Uri,
): Promise<void> {
  const file = activeFileUri(explicit);
  if (!file) return;

  const repository = await pickRepository(api, file);
  if (!repository) return;

  const repo = makeRepoContext(api, repository);
  const porcelain = new Porcelain(repo.git);
  const rel = relPath(repo.root, file);

  const branches = await porcelain.listBranches();
  const branch = await vscode.window.showQuickPick(branches, {
    title: `Compare ${path.basename(rel)} with branch`,
  });
  if (!branch) return;

  await openDiff(
    encodeRevisionUri(repo.root.fsPath, branch, rel),
    file,
    `${path.basename(rel)} (${branch} ↔ working tree)`,
  );
}

/** Pick two revisions and diff the file between them. */
export async function compareBetweenRevisions(
  api: BuiltInGitApi,
  explicit?: vscode.Uri,
): Promise<void> {
  const file = activeFileUri(explicit);
  if (!file) return;

  const repository = await pickRepository(api, file);
  if (!repository) return;

  const repo = makeRepoContext(api, repository);
  const porcelain = new Porcelain(repo.git);
  const rel = relPath(repo.root, file);
  const commits = await porcelain.log({ maxCount: HISTORY_PAGE, path: rel });
  if (commits.length < 2) {
    vscode.window.showInformationMessage(`${rel} has fewer than two revisions.`);
    return;
  }

  const items = commitPickItems(commits);
  const from = await vscode.window.showQuickPick(items, {
    title: `Compare ${path.basename(rel)}: pick the OLDER revision (1/2)`,
    matchOnDescription: true,
  });
  if (!from) return;

  const to = await vscode.window.showQuickPick(
    items.filter((i) => i.commit.hash !== from.commit.hash),
    { title: `Compare ${path.basename(rel)}: pick the NEWER revision (2/2)`, matchOnDescription: true },
  );
  if (!to) return;

  await openDiff(
    encodeRevisionUri(repo.root.fsPath, from.commit.hash, rel),
    encodeRevisionUri(repo.root.fsPath, to.commit.hash, rel),
    `${path.basename(rel)} (${from.commit.shortHash} ↔ ${to.commit.shortHash})`,
  );
}

/** Open the working-tree-vs-HEAD diff for one changelist entry. */
export async function openChange(node: ChangelistNode): Promise<void> {
  if (node.kind !== 'file') return;
  const file = vscode.Uri.joinPath(node.root, node.entry.path);

  if (node.entry.status === 'untracked') {
    await vscode.window.showTextDocument(file, { preview: true });
    return;
  }

  await openDiff(
    encodeRevisionUri(node.root.fsPath, 'HEAD', node.entry.path),
    file,
    `${path.basename(node.entry.path)} (HEAD ↔ working tree)`,
  );
}

/**
 * Walk a whole changelist file by file, the way IDEA's changelist diff does.
 *
 * VS Code has no multi-file diff container that an extension can populate
 * directly, so the closest honest equivalent is a picker over the list that
 * opens each file's diff -- the files stay in the editor tab bar as you go.
 */
export async function diffChangelist(manager: ChangelistManager, listId: string): Promise<void> {
  const list = manager.getList(listId);
  if (!list || list.entries.length === 0) {
    vscode.window.showInformationMessage('That changelist has no changes.');
    return;
  }

  if (list.entries.length === 1) {
    await openChange({
      kind: 'file',
      managerKey: manager.repo.root.fsPath,
      listId,
      entry: list.entries[0],
      root: manager.repo.root,
    });
    return;
  }

  const picked = await vscode.window.showQuickPick(
    list.entries.map((entry) => ({
      label: path.basename(entry.path),
      description: path.dirname(entry.path),
      detail: entry.status,
      entry,
    })),
    { title: `${list.name} — ${list.entries.length} files`, canPickMany: true },
  );
  if (!picked) return;

  for (const item of picked) {
    await openChange({
      kind: 'file',
      managerKey: manager.repo.root.fsPath,
      listId,
      entry: item.entry,
      root: manager.repo.root,
    });
  }
}

/** IDEA's "Show History": list a file's commits, open a diff for the chosen one. */
export async function showFileHistory(
  api: BuiltInGitApi,
  explicit?: vscode.Uri,
): Promise<void> {
  const file = activeFileUri(explicit);
  if (!file) return;

  const repository = await pickRepository(api, file);
  if (!repository) return;

  const repo = makeRepoContext(api, repository);
  const porcelain = new Porcelain(repo.git);
  const rel = relPath(repo.root, file);
  const commits = await porcelain.log({ maxCount: HISTORY_PAGE, path: rel });

  if (commits.length === 0) {
    vscode.window.showInformationMessage(`No history found for ${rel}.`);
    return;
  }

  const picked = await vscode.window.showQuickPick(commitPickItems(commits), {
    title: `History of ${path.basename(rel)}`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!picked) return;

  const commit = picked.commit;
  const parent = commit.parents[0];

  // A root commit has no parent to diff against, so show the file as added.
  const left = parent
    ? encodeRevisionUri(repo.root.fsPath, parent, rel)
    : encodeRevisionUri(repo.root.fsPath, '4b825dc642cb6eb9a060e54bf8d69288fbee4904', rel);

  await openDiff(
    left,
    encodeRevisionUri(repo.root.fsPath, commit.hash, rel),
    `${path.basename(rel)} @ ${refLabel(commit.hash)} — ${commit.subject}`,
  );
}

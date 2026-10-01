import * as vscode from 'vscode';
import { BuiltInGitApi, makeRepoContext, pickRepository } from './git/gitApi';
import { ChangelistManager } from './changelists/manager';
import { ChangelistNode } from './changelists/treeView';
import { DEFAULT_CHANGELIST_ID } from './changelists/model';
import { GraphIntegration } from './integration/gitGraphPlus';
import { relPath } from './diff/commands';

export interface CommandDeps {
  api: BuiltInGitApi;
  managers: Map<string, ChangelistManager>;
  graph: GraphIntegration;
  output: vscode.OutputChannel;
}

function managerFor(deps: CommandDeps, node?: ChangelistNode): ChangelistManager | undefined {
  if (node) return deps.managers.get(node.managerKey);
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (uri) {
    const repo = deps.api.getRepository(uri);
    if (repo) return deps.managers.get(repo.rootUri.fsPath);
  }
  return [...deps.managers.values()][0];
}

export async function createChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  const manager = managerFor(deps, node);
  if (!manager) return;

  const name = await vscode.window.showInputBox({
    title: 'New Changelist',
    prompt: 'Name for the new changelist',
    validateInput: (value) =>
      value.trim().length === 0 ? 'A changelist needs a name.' : undefined,
  });
  if (!name) return;

  const id = await manager.createList(name.trim());
  const makeActive = await vscode.window.showQuickPick(['Yes', 'No'], {
    title: `Make "${name.trim()}" the active changelist?`,
  });
  if (makeActive === 'Yes') await manager.setActive(id);
}

export async function renameChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  if (node?.kind !== 'list') return;
  const manager = deps.managers.get(node.managerKey);
  if (!manager) return;

  const name = await vscode.window.showInputBox({
    title: 'Rename Changelist',
    value: node.list.name,
    validateInput: (v) => (v.trim().length === 0 ? 'A changelist needs a name.' : undefined),
  });
  if (!name) return;
  await manager.renameList(node.list.id, name.trim());
}

export async function deleteChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  if (node?.kind !== 'list') return;
  const manager = deps.managers.get(node.managerKey);
  if (!manager) return;

  if (node.list.id === DEFAULT_CHANGELIST_ID) {
    vscode.window.showWarningMessage('The default changelist cannot be deleted.');
    return;
  }

  const count = node.list.entries.length;
  const confirm = await vscode.window.showWarningMessage(
    count > 0
      ? `Delete "${node.list.name}"? Its ${count} file${count === 1 ? '' : 's'} move back to the default changelist — no changes are lost.`
      : `Delete "${node.list.name}"?`,
    { modal: true },
    'Delete',
  );
  if (confirm !== 'Delete') return;

  await manager.deleteList(node.list.id);
}

export async function setActiveChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  if (node?.kind !== 'list') return;
  await deps.managers.get(node.managerKey)?.setActive(node.list.id);
}

export async function moveToChangelist(
  deps: CommandDeps,
  arg?: ChangelistNode | vscode.SourceControlResourceState,
): Promise<void> {
  let manager: ChangelistManager | undefined;
  let paths: string[] = [];

  if (arg && 'kind' in arg && arg.kind === 'file') {
    manager = deps.managers.get(arg.managerKey);
    paths = [arg.entry.path];
  } else {
    const uri =
      arg && 'resourceUri' in arg
        ? (arg as vscode.SourceControlResourceState).resourceUri
        : vscode.window.activeTextEditor?.document.uri;
    if (!uri) return;
    const repository = await pickRepository(deps.api, uri);
    if (!repository) return;
    manager = deps.managers.get(repository.rootUri.fsPath);
    paths = [relPath(repository.rootUri, uri)];
  }

  if (!manager || paths.length === 0) return;

  const items = manager.lists.map((l) => ({
    label: l.name,
    description: l.isActive ? 'active' : undefined,
    id: l.id,
  }));
  const NEW_LIST = '$(new-folder) New changelist…';

  const picked = await vscode.window.showQuickPick(
    [...items, { label: NEW_LIST, description: undefined, id: '__new__' }],
    { title: `Move ${paths.length === 1 ? paths[0] : `${paths.length} files`} to…` },
  );
  if (!picked) return;

  let targetId = picked.id;
  if (targetId === '__new__') {
    const name = await vscode.window.showInputBox({ title: 'New Changelist', prompt: 'Name' });
    if (!name) return;
    targetId = await manager.createList(name.trim());
  }

  await manager.movePaths(paths, targetId);
}

export async function commitChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  const manager = managerFor(deps, node);
  if (!manager) return;

  let listId = node?.kind === 'list' ? node.list.id : undefined;
  if (!listId) {
    const nonEmpty = manager.lists.filter((l) => l.entries.length > 0);
    if (nonEmpty.length === 0) {
      vscode.window.showInformationMessage('Nothing to commit.');
      return;
    }
    if (nonEmpty.length === 1) {
      listId = nonEmpty[0].id;
    } else {
      const picked = await vscode.window.showQuickPick(
        nonEmpty.map((l) => ({
          label: l.name,
          description: `${l.entries.length} files${l.isActive ? ' · active' : ''}`,
          id: l.id,
        })),
        { title: 'Commit which changelist?' },
      );
      if (!picked) return;
      listId = picked.id;
    }
  }

  const list = manager.getList(listId);
  if (!list) return;

  const message = await vscode.window.showInputBox({
    title: `Commit ${list.entries.length} file${list.entries.length === 1 ? '' : 's'} from "${list.name}"`,
    prompt: 'Commit message',
    value: list.comment ?? '',
    validateInput: (v) => (v.trim().length === 0 ? 'A commit needs a message.' : undefined),
  });
  if (!message) return;

  await withProgress(`Committing "${list.name}"`, deps, async () => {
    await manager.commitList(listId!, message.trim());
    vscode.window.showInformationMessage(
      `Committed ${list.entries.length} file${list.entries.length === 1 ? '' : 's'} from "${list.name}".`,
    );
  });
}

export async function rollbackChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  if (node?.kind !== 'list') return;
  const manager = deps.managers.get(node.managerKey);
  if (!manager) return;

  const count = node.list.entries.length;
  if (count === 0) return;

  const confirm = await vscode.window.showWarningMessage(
    `Discard all changes in "${node.list.name}"? ${count} file${count === 1 ? '' : 's'} will be reverted. This cannot be undone from VS Code.`,
    { modal: true },
    'Discard changes',
  );
  if (confirm !== 'Discard changes') return;

  await withProgress(`Rolling back "${node.list.name}"`, deps, () =>
    manager.rollbackList(node.list.id),
  );
}

export async function shelveChangelist(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  if (node?.kind !== 'list') return;
  const manager = deps.managers.get(node.managerKey);
  if (!manager || node.list.entries.length === 0) return;

  await withProgress(`Shelving "${node.list.name}"`, deps, async () => {
    await manager.shelveList(node.list.id);
    vscode.window.showInformationMessage(
      `Shelved "${node.list.name}" — restore it with IDEA Git: Unshelve.`,
    );
  });
}

export async function unshelve(deps: CommandDeps, node?: ChangelistNode): Promise<void> {
  const manager = managerFor(deps, node);
  if (!manager) return;

  const shelves = await manager.listShelves();
  if (shelves.length === 0) {
    vscode.window.showInformationMessage('Nothing is shelved.');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    shelves.map((s) => ({ label: s.name, description: s.ref, ref: s.ref })),
    { title: 'Unshelve' },
  );
  if (!picked) return;

  const mode = await vscode.window.showQuickPick(
    [
      { label: 'Unshelve and remove', description: 'git stash pop', pop: true },
      { label: 'Unshelve and keep', description: 'git stash apply', pop: false },
    ],
    { title: `Unshelve "${picked.label}"` },
  );
  if (!mode) return;

  await withProgress('Unshelving', deps, () => manager.unshelve(picked.ref, mode.pop));
}

export async function updateProject(deps: CommandDeps): Promise<void> {
  const repository = await pickRepository(deps.api);
  if (!repository) return;
  const repo = makeRepoContext(deps.api, repository);

  await withProgress('Updating project', deps, async () => {
    await repo.git.run(['pull', '--rebase', '--autostash']);
    vscode.window.showInformationMessage('Project updated.');
  });
}

export async function push(deps: CommandDeps): Promise<void> {
  const repository = await pickRepository(deps.api);
  if (!repository) return;
  const repo = makeRepoContext(deps.api, repository);
  const branch = repository.state.HEAD?.name;

  await withProgress(`Pushing ${branch ?? 'HEAD'}`, deps, async () => {
    try {
      await repo.git.run(['push']);
    } catch (err) {
      // No upstream is the common first-push case; offer to set it rather
      // than making the user drop to a terminal.
      const message = err instanceof Error ? err.message : String(err);
      if (!/no upstream|set-upstream/i.test(message) || !branch) throw err;

      const setUpstream = await vscode.window.showWarningMessage(
        `"${branch}" has no upstream branch.`,
        'Push and set upstream',
      );
      if (setUpstream) {
        await repo.git.run(['push', '--set-upstream', 'origin', branch]);
      } else {
        return;
      }
    }
    vscode.window.showInformationMessage(`Pushed ${branch ?? 'HEAD'}.`);
  });
}

async function withProgress(
  title: string,
  deps: CommandDeps,
  work: () => Promise<void>,
): Promise<void> {
  try {
    await vscode.window.withProgress(
      { location: vscode.ProgressLocation.SourceControl, title },
      work,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.output.appendLine(`[${new Date().toISOString()}] ${title} failed: ${message}`);
    const show = 'Show log';
    const choice = await vscode.window.showErrorMessage(`${title} failed: ${firstLine(message)}`, show);
    if (choice === show) deps.output.show();
  }
}

function firstLine(message: string): string {
  const line = message.split('\n').find((l) => l.trim().length > 0) ?? message;
  return line.length > 200 ? `${line.slice(0, 200)}…` : line;
}

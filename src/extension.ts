import * as vscode from 'vscode';
import { BuiltInRepository, getBuiltInGitApi, makeRepoContext } from './git/gitApi';
import { ChangelistManager } from './changelists/manager';
import { ChangelistNode, ChangelistTreeProvider } from './changelists/treeView';
import { RevisionContentProvider, REVISION_SCHEME } from './diff/revisionProvider';
import { GraphIntegration } from './integration/gitGraphPlus';
import * as diff from './diff/commands';
import * as cmd from './commands';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('IDEA Git');
  context.subscriptions.push(output);

  const api = await getBuiltInGitApi();
  if (!api) {
    output.appendLine('The built-in Git extension is unavailable; IDEA Git is inactive.');
    return;
  }

  const managers = new Map<string, ChangelistManager>();
  const tree = new ChangelistTreeProvider(managers);
  const graph = new GraphIntegration();
  const deps: cmd.CommandDeps = { api, managers, graph, output };

  const revisions = new RevisionContentProvider(api.git.path || 'git');
  context.subscriptions.push(
    revisions,
    vscode.workspace.registerTextDocumentContentProvider(REVISION_SCHEME, revisions),
  );

  const view = vscode.window.createTreeView<ChangelistNode>('ideaGit.changelists', {
    treeDataProvider: tree,
    dragAndDropController: tree,
    canSelectMany: true,
    showCollapseAll: true,
  });
  context.subscriptions.push(view, tree);

  const addRepository = async (repository: BuiltInRepository): Promise<void> => {
    const key = repository.rootUri.fsPath;
    if (managers.has(key)) return;
    try {
      const manager = await ChangelistManager.create(makeRepoContext(api, repository));
      managers.set(key, manager);
      // Deliberately NOT pushed onto context.subscriptions: repositories open
      // and close many times in a long session, and that array is never pruned.
      // removeRepository disposes it; disposeAll covers deactivation.
      tree.watch(key, manager);
    } catch (err) {
      output.appendLine(
        `Failed to attach to ${key}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const removeRepository = (repository: BuiltInRepository): void => {
    const key = repository.rootUri.fsPath;
    managers.get(key)?.dispose();
    managers.delete(key);
    tree.unwatch(key);
  };

  context.subscriptions.push(
    api.onDidOpenRepository((r) => void addRepository(r)),
    api.onDidCloseRepository((r) => removeRepository(r)),
  );
  await Promise.all(api.repositories.map(addRepository));

  register(context, {
    'ideaGit.changelist.create': (n?: ChangelistNode) => cmd.createChangelist(deps, n),
    'ideaGit.changelist.rename': (n?: ChangelistNode) => cmd.renameChangelist(deps, n),
    'ideaGit.changelist.delete': (n?: ChangelistNode) => cmd.deleteChangelist(deps, n),
    'ideaGit.changelist.setActive': (n?: ChangelistNode) => cmd.setActiveChangelist(deps, n),
    'ideaGit.changelist.moveTo': (n?: ChangelistNode) => cmd.moveToChangelist(deps, n),
    'ideaGit.changelist.commit': (n?: ChangelistNode) => cmd.commitChangelist(deps, n),
    'ideaGit.changelist.rollback': (n?: ChangelistNode) => cmd.rollbackChangelist(deps, n),
    'ideaGit.changelist.shelve': (n?: ChangelistNode) => cmd.shelveChangelist(deps, n),
    'ideaGit.changelist.unshelve': (n?: ChangelistNode) => cmd.unshelve(deps, n),
    'ideaGit.changelist.refresh': async () => {
      await Promise.all([...managers.values()].map((m) => m.refresh()));
    },

    'ideaGit.diff.openChange': (n: ChangelistNode) => diff.openChange(n),
    // These are contributed to the tree view, the editor title menu AND the
    // command palette, so the argument may be a ChangelistNode, a Uri, or
    // nothing at all. Normalise before use -- passing a node straight through
    // as a Uri throws deep inside path.relative.
    'ideaGit.diff.withRevision': (a?: DiffArg) => diff.compareWithRevision(api, toUri(a)),
    'ideaGit.diff.withBranch': (a?: DiffArg) => diff.compareWithBranch(api, toUri(a)),
    'ideaGit.diff.betweenRevisions': (a?: DiffArg) =>
      diff.compareBetweenRevisions(api, toUri(a)),
    'ideaGit.diff.fileHistory': (a?: DiffArg) => diff.showFileHistory(api, toUri(a)),
    'ideaGit.diff.changelist': (n?: ChangelistNode) => {
      if (n?.kind !== 'list') return Promise.resolve();
      const manager = managers.get(n.managerKey);
      return manager ? diff.diffChangelist(manager, n.list.id) : Promise.resolve();
    },

    'ideaGit.vcs.update': () => cmd.updateProject(deps),
    'ideaGit.vcs.push': () => cmd.push(deps),
    'ideaGit.vcs.openGraph': () => graph.openGraph(),
  });

  context.subscriptions.push({
    dispose: () => {
      managers.forEach((m) => m.dispose());
      managers.clear();
    },
  });

  output.appendLine(
    `IDEA Git active. Repositories: ${api.repositories.length}. ` +
      `Graph delegate: ${graph.installedGraphExtension ?? 'built-in'}.`,
  );
}

type DiffArg = vscode.Uri | ChangelistNode;

function toUri(arg?: DiffArg): vscode.Uri | undefined {
  if (!arg) return undefined;
  if (arg instanceof vscode.Uri) return arg;
  if ('kind' in arg && arg.kind === 'file') {
    return vscode.Uri.joinPath(arg.root, arg.entry.path);
  }
  return undefined;
}

export function deactivate(): void {
  // Managers and views are disposed through context.subscriptions.
}

function register(
  context: vscode.ExtensionContext,
  handlers: Record<string, (...args: never[]) => unknown>,
): void {
  for (const [id, handler] of Object.entries(handlers)) {
    context.subscriptions.push(
      vscode.commands.registerCommand(id, handler as (...args: unknown[]) => unknown),
    );
  }
}

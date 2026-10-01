import * as vscode from 'vscode';
import * as path from 'path';
import { WorkingTreeEntry } from '../git/porcelain';
import { ChangelistManager, ChangelistView } from './manager';
import { DEFAULT_CHANGELIST_ID } from './model';

export type ChangelistNode =
  | { kind: 'list'; managerKey: string; list: ChangelistView }
  | { kind: 'file'; managerKey: string; listId: string; entry: WorkingTreeEntry; root: vscode.Uri }
  | { kind: 'repo'; managerKey: string; label: string };

const STATUS_LETTER: Record<WorkingTreeEntry['status'], string> = {
  modified: 'M',
  added: 'A',
  deleted: 'D',
  renamed: 'R',
  untracked: 'U',
  conflicted: 'C',
  typechange: 'T',
};

// Colours follow the built-in SCM view so the two panels do not disagree
// about what "modified" looks like.
const STATUS_COLOR: Record<WorkingTreeEntry['status'], string> = {
  modified: 'gitDecoration.modifiedResourceForeground',
  added: 'gitDecoration.addedResourceForeground',
  deleted: 'gitDecoration.deletedResourceForeground',
  renamed: 'gitDecoration.renamedResourceForeground',
  untracked: 'gitDecoration.untrackedResourceForeground',
  conflicted: 'gitDecoration.conflictingResourceForeground',
  typechange: 'gitDecoration.modifiedResourceForeground',
};

export class ChangelistTreeProvider
  implements vscode.TreeDataProvider<ChangelistNode>, vscode.TreeDragAndDropController<ChangelistNode>
{
  readonly dropMimeTypes = ['application/vnd.code.tree.ideagit.changelists'];
  readonly dragMimeTypes = ['application/vnd.code.tree.ideagit.changelists'];

  private readonly _onDidChangeTreeData = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private readonly subscriptions = new Map<string, vscode.Disposable>();

  constructor(private readonly managers: Map<string, ChangelistManager>) {}

  refresh(): void {
    this._onDidChangeTreeData.fire();
  }

  watch(key: string, manager: ChangelistManager): void {
    this.subscriptions.get(key)?.dispose();
    this.subscriptions.set(key, manager.onDidChange(() => this.refresh()));
    this.refresh();
  }

  unwatch(key: string): void {
    this.subscriptions.get(key)?.dispose();
    this.subscriptions.delete(key);
    this.refresh();
  }

  dispose(): void {
    this.subscriptions.forEach((s) => s.dispose());
    this._onDidChangeTreeData.dispose();
  }

  getChildren(node?: ChangelistNode): ChangelistNode[] {
    const keys = [...this.managers.keys()];

    if (!node) {
      // A single repository is shown flat; multiple repositories get a level
      // of grouping so identical file names stay distinguishable.
      if (keys.length === 1) {
        return this.listNodes(keys[0]);
      }
      return keys.map((managerKey) => ({
        kind: 'repo' as const,
        managerKey,
        label: path.basename(managerKey),
      }));
    }

    if (node.kind === 'repo') return this.listNodes(node.managerKey);

    if (node.kind === 'list') {
      const manager = this.managers.get(node.managerKey);
      if (!manager) return [];
      return node.list.entries.map((entry) => ({
        kind: 'file' as const,
        managerKey: node.managerKey,
        listId: node.list.id,
        entry,
        root: manager.repo.root,
      }));
    }

    return [];
  }

  private listNodes(managerKey: string): ChangelistNode[] {
    const manager = this.managers.get(managerKey);
    if (!manager) return [];
    return manager.lists.map((list) => ({ kind: 'list' as const, managerKey, list }));
  }

  getTreeItem(node: ChangelistNode): vscode.TreeItem {
    if (node.kind === 'repo') {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.contextValue = 'repo';
      item.iconPath = new vscode.ThemeIcon('repo');
      return item;
    }

    if (node.kind === 'list') {
      const { list } = node;
      const item = new vscode.TreeItem(
        list.name,
        list.entries.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.None,
      );
      item.id = `${node.managerKey}::${list.id}`;
      item.description = `${list.entries.length} file${list.entries.length === 1 ? '' : 's'}`;
      item.contextValue =
        list.id === DEFAULT_CHANGELIST_ID ? 'changelist.default' : 'changelist.custom';
      item.iconPath = new vscode.ThemeIcon(list.isActive ? 'circle-filled' : 'circle-outline');
      item.tooltip = new vscode.MarkdownString(
        [
          `**${list.name}**${list.isActive ? ' — active' : ''}`,
          list.comment ? `\n\n${list.comment}` : '',
          list.snapshot ? `\n\nSnapshot: \`${list.snapshot.slice(0, 10)}\`` : '',
        ].join(''),
      );
      return item;
    }

    const { entry, root } = node;
    const uri = vscode.Uri.joinPath(root, entry.path);
    const item = new vscode.TreeItem(uri, vscode.TreeItemCollapsibleState.None);
    item.id = `${node.managerKey}::${node.listId}::${entry.path}`;
    item.label = path.basename(entry.path);
    item.description = path.dirname(entry.path) === '.' ? '' : path.dirname(entry.path);
    item.contextValue = 'changelistFile';
    item.resourceUri = uri;
    item.iconPath = new vscode.ThemeIcon(
      'circle-filled',
      new vscode.ThemeColor(STATUS_COLOR[entry.status]),
    );
    item.tooltip = `${entry.path} — ${entry.status}${
      entry.origPath ? ` (was ${entry.origPath})` : ''
    }`;
    // Clicking a file opens the same diff IDEA opens: working tree vs HEAD.
    item.command = {
      command: 'ideaGit.diff.openChange',
      title: 'Open Change',
      arguments: [node],
    };
    return item;
  }

  /** Drag a file (or several) onto another changelist to reassign it. */
  handleDrag(
    source: readonly ChangelistNode[],
    dataTransfer: vscode.DataTransfer,
  ): void {
    const files = source.filter((n) => n.kind === 'file');
    if (files.length === 0) return;
    dataTransfer.set(
      this.dragMimeTypes[0],
      new vscode.DataTransferItem(
        files.map((n) => ({
          managerKey: n.managerKey,
          path: (n as Extract<ChangelistNode, { kind: 'file' }>).entry.path,
        })),
      ),
    );
  }

  async handleDrop(
    target: ChangelistNode | undefined,
    dataTransfer: vscode.DataTransfer,
  ): Promise<void> {
    if (!target) return;
    const targetListId =
      target.kind === 'list' ? target.list.id : target.kind === 'file' ? target.listId : undefined;
    if (!targetListId) return;

    const item = dataTransfer.get(this.dropMimeTypes[0]);
    if (!item) return;

    const payload = item.value as Array<{ managerKey: string; path: string }>;
    // Only move files that belong to the same repository as the drop target;
    // a path from another repo is meaningless in this list.
    const sameRepo = payload.filter((p) => p.managerKey === target.managerKey);
    if (sameRepo.length === 0) return;

    const manager = this.managers.get(target.managerKey);
    await manager?.movePaths(sameRepo.map((p) => p.path), targetListId);
  }
}

export function statusLetter(status: WorkingTreeEntry['status']): string {
  return STATUS_LETTER[status];
}

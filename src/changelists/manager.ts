import * as vscode from 'vscode';
import { RepoContext } from '../git/gitApi';
import { Porcelain, WorkingTreeEntry } from '../git/porcelain';
import { ChangelistStore } from './store';
import { commitEntries, rollbackEntries } from './operations';
import {
  Changelist,
  ChangelistState,
  DEFAULT_CHANGELIST_ID,
  movePaths,
  newChangelistId,
  reconcile,
} from './model';

export interface ChangelistView extends Changelist {
  isActive: boolean;
  entries: WorkingTreeEntry[];
}

/**
 * Owns the changelist state for one repository.
 *
 * Refreshes are serialised through a single promise chain: git status and the
 * state file are read together, and two overlapping refreshes could otherwise
 * write reconciled state derived from different snapshots of the tree.
 */
export class ChangelistManager implements vscode.Disposable {
  private state: ChangelistState | undefined;
  private entriesByPath = new Map<string, WorkingTreeEntry>();
  private queue: Promise<unknown> = Promise.resolve();
  private snapshotTimer: NodeJS.Timeout | undefined;
  private readonly porcelain: Porcelain;
  private readonly disposables: vscode.Disposable[] = [];

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private constructor(
    readonly repo: RepoContext,
    private readonly store: ChangelistStore,
    private readonly gitDir: string,
  ) {
    this.porcelain = new Porcelain(repo.git);
    this.disposables.push(
      // refresh() can reject (index.lock contention, repo removed underneath
      // us); an unhandled rejection here would surface as a crash notification.
      repo.repository.state.onDidChange(() => {
        this.refresh().catch(() => undefined);
      }),
      this._onDidChange,
    );
    this.scheduleSnapshots();
  }

  static async create(repo: RepoContext): Promise<ChangelistManager> {
    const store = await ChangelistStore.create(repo.git);
    const gitDir = await repo.git.text(['rev-parse', '--absolute-git-dir']);
    const manager = new ChangelistManager(repo, store, gitDir);
    await manager.refresh();
    return manager;
  }

  dispose(): void {
    if (this.snapshotTimer) clearInterval(this.snapshotTimer);
    this.disposables.forEach((d) => d.dispose());
  }

  get lists(): ChangelistView[] {
    if (!this.state) return [];
    return this.state.lists.map((l) => ({
      ...l,
      isActive: l.id === this.state!.activeId,
      entries: l.paths
        .map((p) => this.entriesByPath.get(p))
        .filter((e): e is WorkingTreeEntry => e !== undefined),
    }));
  }

  get activeId(): string {
    return this.state?.activeId ?? DEFAULT_CHANGELIST_ID;
  }

  /** Serialise every state mutation onto one chain. */
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    // Swallow rejections on the chain itself so one failure cannot poison
    // every later operation; callers still see their own rejection.
    this.queue = run.catch(() => undefined);
    return run;
  }

  async refresh(): Promise<void> {
    await this.enqueue(async () => {
      const [entries, loaded] = await Promise.all([
        this.porcelain.status(),
        this.state ? Promise.resolve(this.state) : this.store.load(),
      ]);

      this.entriesByPath = new Map(entries.map((e) => [e.path, e]));
      const autoAssign = vscode.workspace
        .getConfiguration('ideaGit')
        .get<boolean>('changelists.autoAssignToActive', true);

      this.state = reconcile(loaded, [...this.entriesByPath.keys()], autoAssign);
      await this.store.save(this.state);
    });
    this._onDidChange.fire();
  }

  async createList(name: string, comment?: string): Promise<string> {
    return this.enqueue(async () => {
      const state = this.state ?? (await this.store.load());
      const id = newChangelistId(name, state.lists.map((l) => l.id));
      this.state = {
        ...state,
        lists: [...state.lists, { id, name, comment, paths: [] }],
      };
      await this.store.save(this.state);
      this._onDidChange.fire();
      return id;
    });
  }

  async renameList(id: string, name: string): Promise<void> {
    await this.mutate((state) => ({
      ...state,
      lists: state.lists.map((l) => (l.id === id ? { ...l, name } : l)),
    }));
  }

  async deleteList(id: string): Promise<void> {
    if (id === DEFAULT_CHANGELIST_ID) {
      throw new Error('The default changelist cannot be deleted.');
    }
    await this.mutate((state) => {
      const target = state.lists.find((l) => l.id === id);
      const orphans = target?.paths ?? [];
      const lists = state.lists
        .filter((l) => l.id !== id)
        .map((l) =>
          l.id === DEFAULT_CHANGELIST_ID
            ? { ...l, paths: [...new Set([...l.paths, ...orphans])].sort() }
            : l,
        );
      return {
        ...state,
        lists,
        activeId: state.activeId === id ? DEFAULT_CHANGELIST_ID : state.activeId,
      };
    });
    await this.store.deleteRef(id);
  }

  async setActive(id: string): Promise<void> {
    await this.mutate((state) =>
      state.lists.some((l) => l.id === id) ? { ...state, activeId: id } : state,
    );
  }

  async movePaths(paths: string[], targetId: string): Promise<void> {
    await this.mutate((state) => movePaths(state, paths, targetId));
    await this.snapshotNow();
  }

  private async mutate(
    fn: (state: ChangelistState) => ChangelistState,
  ): Promise<void> {
    await this.enqueue(async () => {
      const state = this.state ?? (await this.store.load());
      this.state = fn(state);
      await this.store.save(this.state);
    });
    this._onDidChange.fire();
  }

  /** Write git-object snapshots for every list. Safe to call often. */
  async snapshotNow(): Promise<void> {
    await this.enqueue(async () => {
      if (!this.state) return;
      try {
        this.state = await this.store.snapshotAll(this.state);
        await this.store.save(this.state);
      } catch {
        // Snapshots are a recovery aid, never a precondition for the UI.
        // A failure here (mid-rebase, detached HEAD, locked index) must not
        // surface as an error toast on every timer tick.
      }
    });
  }

  private scheduleSnapshots(): void {
    const interval = vscode.workspace
      .getConfiguration('ideaGit')
      .get<number>('changelists.persistIntervalMs', 4000);
    if (interval > 0) {
      this.snapshotTimer = setInterval(() => {
        this.snapshotNow().catch(() => undefined);
      }, interval);
    }
  }

  getList(id: string): ChangelistView | undefined {
    return this.lists.find((l) => l.id === id);
  }

  /**
   * Commit exactly one changelist. See operations.commitEntries for why this
   * builds the commit in a temporary index rather than staging into the real
   * one.
   */
  async commitList(id: string, message: string, amend = false): Promise<void> {
    const list = this.getList(id);
    if (!list || list.entries.length === 0) {
      throw new Error('That changelist has no changes to commit.');
    }

    await commitEntries(this.repo.git, {
      entries: list.entries,
      message,
      amend,
      gitDir: this.gitDir,
    });

    await this.store.deleteRef(id);
    await this.refresh();
  }

  async rollbackList(id: string): Promise<void> {
    const list = this.getList(id);
    if (!list || list.entries.length === 0) return;
    await rollbackEntries(this.repo.git, list.entries);
    await this.refresh();
  }

  async shelveList(id: string): Promise<void> {
    const list = this.getList(id);
    if (!list) return;
    await this.store.shelve(list);
    await this.refresh();
  }

  listShelves() {
    return this.store.listShelves();
  }

  async unshelve(ref: string, pop: boolean): Promise<void> {
    await this.store.unshelve(ref, pop);
    await this.refresh();
  }

  listSnapshotRefs() {
    return this.store.listSnapshotRefs();
  }
}

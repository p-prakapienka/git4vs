import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRunner } from '../git/cli';
import { Porcelain } from '../git/porcelain';
import { literal } from './operations';
import {
  Changelist,
  ChangelistState,
  emptyState,
  normalizeState,
  refSlug,
} from './model';

export const REF_NAMESPACE = 'refs/idea-git/changelists';
export const SHELF_PREFIX = 'idea-git-shelf:';

/**
 * Persistence for changelists.
 *
 * Two layers, deliberately:
 *
 *  - Assignments (which file is in which list) live in a JSON file inside
 *    .git/. They are pure metadata, worthless to anyone else, and must never
 *    reach a commit -- .git is the one directory guaranteed not to be tracked.
 *
 *  - Content is snapshotted into real git commit objects under
 *    refs/idea-git/changelists/<id>. A ref anchors the objects against gc, so
 *    a snapshot survives branch switches, resets, reboots and a deleted
 *    metadata file. Crucially this uses a temporary index, so the working tree
 *    is never touched -- unlike `git stash push`, which would yank an inactive
 *    list's files out from under the editor.
 *
 * Shelving is the separate, explicit operation that *does* use a real stash
 * entry, because there the point is to remove the changes from the tree.
 */
export class ChangelistStore {
  private readonly porcelain: Porcelain;

  constructor(
    private readonly git: GitRunner,
    private readonly gitDir: string,
  ) {
    this.porcelain = new Porcelain(git);
  }

  static async create(git: GitRunner): Promise<ChangelistStore> {
    const gitDir = await git.text(['rev-parse', '--absolute-git-dir']);
    return new ChangelistStore(git, gitDir);
  }

  private get stateFile(): string {
    return path.join(this.gitDir, 'idea-git', 'changelists.json');
  }

  async load(): Promise<ChangelistState> {
    try {
      const raw = await fs.readFile(this.stateFile, 'utf8');
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return emptyState();
      // A corrupt file must not brick the view; snapshots under refs/ are the
      // real safety net, so start clean and let reconcile repopulate.
      return emptyState();
    }
  }

  async save(state: ChangelistState): Promise<void> {
    const file = this.stateFile;
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Write-then-rename so a crash mid-write cannot truncate the file.
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(state, null, 2), 'utf8');
    await fs.rename(tmp, file);
  }

  /**
   * Snapshot one changelist's current content into a commit object and point
   * refs/idea-git/changelists/<id> at it. Returns the commit hash, or
   * undefined when the list is empty.
   *
   * The working tree and the real index are untouched: all staging happens in
   * a throwaway index file selected via GIT_INDEX_FILE.
   */
  async snapshot(list: Changelist): Promise<string | undefined> {
    if (list.paths.length === 0) {
      await this.deleteRef(list.id);
      return undefined;
    }

    const hasHead = await this.porcelain.hasHead();
    const tmpIndex = path.join(
      await fs.mkdtemp(path.join(os.tmpdir(), 'idea-git-')),
      'index',
    );
    const env = { GIT_INDEX_FILE: tmpIndex };

    try {
      if (hasHead) {
        await this.git.run(['read-tree', 'HEAD'], { env });
      } else {
        await this.git.run(['read-tree', '--empty'], { env });
      }

      // --add covers new files, --remove records deletions, and --force-remove
      // is unnecessary because --remove already drops paths missing on disk.
      await this.git.run(
        ['update-index', '--add', '--remove', '--', ...list.paths],
        { env },
      );

      const tree = await this.git.text(['write-tree'], { env });
      const parents = hasHead ? ['-p', 'HEAD'] : [];
      const message =
        `idea-git snapshot: ${list.name}\n\n` +
        `changelist-id: ${list.id}\n` +
        `files: ${list.paths.length}\n`;

      const commit = await this.git.text(
        ['commit-tree', tree, ...parents],
        { env, stdin: message },
      );

      await this.git.run([
        'update-ref',
        `${REF_NAMESPACE}/${refSlug(list.id)}`,
        commit,
      ]);
      return commit;
    } finally {
      await fs.rm(path.dirname(tmpIndex), { recursive: true, force: true });
    }
  }

  async snapshotAll(state: ChangelistState): Promise<ChangelistState> {
    const lists: Changelist[] = [];
    for (const list of state.lists) {
      const snapshot = await this.snapshot(list);
      lists.push({ ...list, snapshot });
    }
    return { ...state, lists };
  }

  async deleteRef(id: string): Promise<void> {
    const ref = `${REF_NAMESPACE}/${refSlug(id)}`;
    // -d without an expected value is fine here: nothing else writes this ref.
    await this.git.run(['update-ref', '-d', ref], { okExitCodes: [0, 1, 128] });
  }

  /** All snapshot refs that currently exist, for recovery UI. */
  async listSnapshotRefs(): Promise<Array<{ ref: string; hash: string; subject: string }>> {
    const out = await this.git.text([
      'for-each-ref',
      '--format=%(refname)\t%(objectname)\t%(contents:subject)',
      REF_NAMESPACE,
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, hash, subject] = line.split('\t');
        return { ref, hash, subject: subject ?? '' };
      });
  }

  /**
   * Shelve a changelist: move its files out of the working tree into a real
   * stash entry, tagged so it can be found again.
   */
  async shelve(list: Changelist): Promise<void> {
    if (list.paths.length === 0) return;
    await this.git.run([
      'stash',
      'push',
      '--include-untracked',
      '-m',
      `${SHELF_PREFIX}${list.name}`,
      '--',
      // Literal pathspecs: a filename containing a glob character must not
      // drag its neighbours into the stash.
      ...list.paths.map(literal),
    ]);
  }

  async listShelves(): Promise<Array<{ ref: string; name: string }>> {
    const out = await this.git.text([
      'stash',
      'list',
      '--format=%gd\t%gs',
    ]);
    return out
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [ref, subject] = line.split('\t');
        const idx = (subject ?? '').indexOf(SHELF_PREFIX);
        return {
          ref,
          name:
            idx >= 0
              ? subject.slice(idx + SHELF_PREFIX.length).trim()
              : (subject ?? ref),
        };
      });
  }

  async unshelve(stashRef: string, pop: boolean): Promise<void> {
    await this.git.run(['stash', pop ? 'pop' : 'apply', stashRef]);
  }
}

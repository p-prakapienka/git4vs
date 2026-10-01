import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitRunner } from '../git/cli';
import { Porcelain, WorkingTreeEntry } from '../git/porcelain';

/**
 * The git operations behind the destructive changelist commands.
 *
 * Kept free of any vscode import so they can be exercised against a real
 * repository in tests -- committing the wrong set of files, or reverting a
 * file that was not in the list, is unrecoverable for the user, so these
 * sequences are the part that must be proven rather than reasoned about.
 */

/**
 * Disable pathspec pattern matching for a path.
 *
 * git reports literal filenames in `status` but consumes them as *globs*.
 * Without this, a changelist containing a file literally named `note*.md`
 * would make `git add`/`restore`/`clean` also match `notes.md` -- silently
 * committing, reverting or DELETING files from other changelists. The
 * `:(literal)` magic prefix is understood everywhere a pathspec is accepted.
 */
export function literal(p: string): string {
  return `:(literal)${p}`;
}

/** Every path an entry touches: a rename needs both of its names. */
export function pathsOf(entries: readonly WorkingTreeEntry[]): string[] {
  const out = new Set<string>();
  for (const e of entries) {
    out.add(e.path);
    if (e.origPath) out.add(e.origPath);
  }
  return [...out];
}

export type RepoOperationState =
  | 'clean'
  | 'merging'
  | 'rebasing'
  | 'cherry-picking'
  | 'reverting'
  | 'bisecting';

/**
 * Detect an in-progress multi-step git operation.
 *
 * Committing part of the tree in the middle of one of these is destructive in
 * a way the user cannot easily undo: `git commit` during a merge would build a
 * merge commit whose tree omits the other side, and during a rebase it commits
 * onto the detached rebase head, where `git rebase --abort` then throws the
 * commit away along with the work in it.
 */
export async function repoOperationState(
  git: GitRunner,
  gitDir: string,
): Promise<RepoOperationState> {
  const exists = async (rel: string): Promise<boolean> =>
    fs.access(path.join(gitDir, rel)).then(
      () => true,
      () => false,
    );

  if (await exists('MERGE_HEAD')) return 'merging';
  if ((await exists('rebase-merge')) || (await exists('rebase-apply'))) return 'rebasing';
  if (await exists('CHERRY_PICK_HEAD')) return 'cherry-picking';
  if (await exists('REVERT_HEAD')) return 'reverting';
  if (await exists('BISECT_LOG')) return 'bisecting';
  return 'clean';
}

export class RepoBusyError extends Error {
  constructor(readonly state: RepoOperationState) {
    super(
      `This repository is in the middle of a ${state.replace(/ing$/, '')} operation. ` +
        `Finish or abort it first — committing part of the tree now would be unsafe.`,
    );
    this.name = 'RepoBusyError';
  }
}

export interface CommitOptions {
  entries: readonly WorkingTreeEntry[];
  message: string;
  amend?: boolean;
  gitDir: string;
}

export interface CommitOutcome {
  committed: string[];
  hash: string;
}

/**
 * Commit exactly the given entries and nothing else.
 *
 * The commit is assembled in a TEMPORARY index (GIT_INDEX_FILE) seeded from
 * HEAD. That is what makes it safe:
 *
 *  - Whatever the user had staged by hand is never touched, so it cannot leak
 *    into this commit and, just as importantly, is not thrown away to keep it
 *    out. An earlier version ran `git reset` first; that destroyed index-only
 *    content and wiped MERGE_HEAD mid-merge.
 *  - `update-index` takes LITERAL paths, so glob characters in a filename
 *    cannot pull in neighbours.
 *  - It is still a real `git commit`, so hooks, signing and commit templates
 *    all behave normally.
 *
 * Afterwards the real index is refreshed for exactly the committed paths, so
 * the files show as clean rather than as a spurious reverse-diff.
 */
export async function commitEntries(
  git: GitRunner,
  { entries, message, amend = false, gitDir }: CommitOptions,
): Promise<CommitOutcome> {
  if (entries.length === 0) {
    throw new Error('Refusing to commit an empty changelist.');
  }

  const busy = await repoOperationState(git, gitDir);
  if (busy !== 'clean') throw new RepoBusyError(busy);

  const porcelain = new Porcelain(git);
  const hasHead = await porcelain.hasHead();
  const paths = pathsOf(entries);

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-git-commit-'));
  const tmpIndex = path.join(scratch, 'index');
  const env = { GIT_INDEX_FILE: tmpIndex };

  try {
    const base = amend && hasHead ? 'HEAD^' : 'HEAD';
    if (hasHead) {
      // For --amend, seed from the commit being replaced so the amended tree
      // keeps that commit's other files.
      const seed = amend ? await porcelain.revParse(base) : 'HEAD';
      await git.run(['read-tree', seed ?? 'HEAD'], { env });
    } else {
      await git.run(['read-tree', '--empty'], { env });
    }

    await git.run(['update-index', '--add', '--remove', '--', ...paths], { env });

    const tree = await git.text(['write-tree'], { env });
    const headTree = hasHead ? await porcelain.revParse(`${base}^{tree}`) : undefined;
    if (!amend && headTree === tree) {
      throw new Error('Nothing to commit: those files match HEAD already.');
    }

    const args = ['commit', '-m', message];
    if (amend) args.push('--amend');
    await git.run(args, { env });

    const hash = await git.text(['rev-parse', 'HEAD']);

    // Bring the real index in line for the committed paths only. Without this
    // the files would read as "staged reversal + unstaged modification".
    await git.run(['update-index', '--add', '--remove', '--', ...paths]);

    return { committed: paths, hash };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Revert the working tree for the given entries.
 *
 * Tracked and untracked paths need different commands, `git clean` is bounded
 * to the exact untracked paths in the list -- never a bare `clean -fd` -- and
 * every path goes through `:(literal)` so a filename containing `*` or `[`
 * cannot take unrelated files down with it.
 */
export async function rollbackEntries(
  git: GitRunner,
  entries: readonly WorkingTreeEntry[],
): Promise<{ reverted: string[]; deleted: string[] }> {
  if (entries.length === 0) return { reverted: [], deleted: [] };

  const porcelain = new Porcelain(git);
  const hasHead = await porcelain.hasHead();

  const untracked = entries.filter((e) => e.status === 'untracked').map((e) => e.path);
  // A rename is reverted by restoring BOTH names: the new one disappears and
  // the original comes back. Restoring only the new name would leave neither
  // file on disk.
  const tracked = pathsOf(entries.filter((e) => e.status !== 'untracked'));

  if (tracked.length > 0) {
    if (hasHead) {
      await git.run(['restore', '--staged', '--worktree', '--', ...tracked.map(literal)]);
    } else {
      // No commit exists yet, so there is no HEAD content to restore to:
      // "revert" for a newly added file means unstage it and remove it.
      await git.run(['rm', '--cached', '--force', '--quiet', '--', ...tracked.map(literal)], {
        okExitCodes: [0, 128],
      });
      await Promise.all(
        tracked.map((p) => fs.rm(path.join(git.root, p), { force: true })),
      );
    }
  }

  if (untracked.length > 0) {
    await git.run(['clean', '-f', '--', ...untracked.map(literal)]);
  }

  return { reverted: tracked, deleted: untracked };
}

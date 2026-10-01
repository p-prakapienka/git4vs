import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, describe, beforeEach, after } from 'node:test';

import { GitRunner } from '../src/git/cli';
import { Porcelain, WorkingTreeEntry } from '../src/git/porcelain';
import {
  commitEntries,
  literal,
  pathsOf,
  repoOperationState,
  rollbackEntries,
  RepoBusyError,
} from '../src/changelists/operations';

const repos: string[] = [];

interface Ctx {
  repo: string;
  git: GitRunner;
  porcelain: Porcelain;
  gitDir: string;
}

async function freshRepo(files = ['a.txt', 'b.txt', 'c.txt']): Promise<Ctx> {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git4vs-ops-'));
  repos.push(repo);
  const git = new GitRunner(repo);
  await git.run(['init', '--initial-branch=main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test']);
  for (const f of files) {
    await fs.writeFile(path.join(repo, f), `${f} v1\n`, 'utf8');
  }
  await git.run(['add', '-A']);
  await git.run(['commit', '-m', 'initial']);
  return { repo, git, porcelain: new Porcelain(git), gitDir: path.join(repo, '.git') };
}

/** Pick the status entries for the given paths, as a changelist would hold. */
async function entriesFor(ctx: Ctx, paths: string[]): Promise<WorkingTreeEntry[]> {
  const all = await ctx.porcelain.status();
  return all.filter((e) => paths.includes(e.path) || (e.origPath && paths.includes(e.origPath)));
}

const exists = (p: string) => fs.access(p).then(() => true, () => false);

after(async () => {
  await Promise.all(repos.map((r) => fs.rm(r, { recursive: true, force: true })));
});

describe('pathspec safety', () => {
  test('literal() disables glob expansion', () => {
    assert.equal(literal('note*.md'), ':(literal)note*.md');
  });

  test('committing a glob-named file does NOT sweep in its neighbours', async () => {
    const ctx = await freshRepo(['note*.md', 'notes.md', 'noteX.md']);
    for (const f of ['note*.md', 'notes.md', 'noteX.md']) {
      await fs.writeFile(path.join(ctx.repo, f), 'v2\n');
    }

    const entries = await entriesFor(ctx, ['note*.md']);
    assert.equal(entries.length, 1);
    await commitEntries(ctx.git, { entries, message: 'glob', gitDir: ctx.gitDir });

    const committed = await ctx.git.nulLines(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']);
    assert.deepEqual(committed, ['note*.md'], 'only the literal file may be committed');

    const stillDirty = (await ctx.porcelain.status()).map((e) => e.path).sort();
    assert.deepEqual(stillDirty, ['noteX.md', 'notes.md']);
  });

  test('rolling back a glob-named file does NOT revert its neighbours', async () => {
    const ctx = await freshRepo(['a[1].txt', 'a1.txt']);
    await fs.writeFile(path.join(ctx.repo, 'a[1].txt'), 'CHANGED\n');
    await fs.writeFile(path.join(ctx.repo, 'a1.txt'), 'CHANGED\n');

    await rollbackEntries(ctx.git, await entriesFor(ctx, ['a[1].txt']));

    assert.equal(await fs.readFile(path.join(ctx.repo, 'a[1].txt'), 'utf8'), 'a[1].txt v1\n');
    assert.equal(
      await fs.readFile(path.join(ctx.repo, 'a1.txt'), 'utf8'),
      'CHANGED\n',
      'the neighbour must keep its uncommitted change',
    );
  });

  test('clean never deletes untracked files outside the list', async () => {
    const ctx = await freshRepo();
    await fs.writeFile(path.join(ctx.repo, 'tmp*.log'), 'in list\n');
    await fs.writeFile(path.join(ctx.repo, 'tmpX.log'), 'NOT in list\n');

    await rollbackEntries(ctx.git, await entriesFor(ctx, ['tmp*.log']));

    assert.equal(await exists(path.join(ctx.repo, 'tmp*.log')), false);
    assert.equal(
      await exists(path.join(ctx.repo, 'tmpX.log')),
      true,
      'unrelated untracked file must survive',
    );
  });

  test('a leading-colon filename does not blow up as pathspec magic', async () => {
    const ctx = await freshRepo([':colon.txt', 'plain.txt']);
    await fs.writeFile(path.join(ctx.repo, ':colon.txt'), 'v2\n');

    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, [':colon.txt']),
      message: 'colon',
      gitDir: ctx.gitDir,
    });

    const committed = await ctx.git.nulLines(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']);
    assert.deepEqual(committed, [':colon.txt']);
  });
});

describe('commitEntries', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await freshRepo();
  });

  test('commits only the listed paths', async () => {
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'a v2\n');
    await fs.writeFile(path.join(ctx.repo, 'b.txt'), 'b v2\n');

    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, ['a.txt']),
      message: 'only a',
      gitDir: ctx.gitDir,
    });

    assert.deepEqual(
      await ctx.git.nulLines(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']),
      ['a.txt'],
    );
    assert.deepEqual((await ctx.porcelain.status()).map((e) => e.path), ['b.txt']);
  });

  test("leaves the user's separately staged work staged and uncommitted", async () => {
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'a v2\n');
    await fs.writeFile(path.join(ctx.repo, 'b.txt'), 'b v2\n');
    await ctx.git.run(['add', 'b.txt']);

    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, ['a.txt']),
      message: 'only a',
      gitDir: ctx.gitDir,
    });

    assert.deepEqual(
      await ctx.git.nulLines(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']),
      ['a.txt'],
      'b.txt must not be in the commit',
    );
    assert.deepEqual(
      await ctx.git.nulLines(['diff', '--cached', '--name-only', '-z']),
      ['b.txt'],
      "the user's staging must be left exactly as it was",
    );
  });

  test('preserves index-only content that differs from the worktree', async () => {
    await fs.writeFile(path.join(ctx.repo, 'b.txt'), 'staged version\n');
    await ctx.git.run(['add', 'b.txt']);
    await fs.writeFile(path.join(ctx.repo, 'b.txt'), 'worktree version\n');
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'a v2\n');

    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, ['a.txt']),
      message: 'only a',
      gitDir: ctx.gitDir,
    });

    const stagedBlob = await ctx.git.text(['show', ':b.txt']);
    assert.equal(stagedBlob, 'staged version', 'index-only content must not be destroyed');
  });

  test('committed files end up clean, not showing a phantom reverse diff', async () => {
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'a v2\n');
    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, ['a.txt']),
      message: 'a',
      gitDir: ctx.gitDir,
    });
    const status = await ctx.porcelain.status();
    assert.deepEqual(status.filter((e) => e.path === 'a.txt'), []);
  });

  test('commits a rename as a rename, not as an add leaving a stray delete', async () => {
    await ctx.git.run(['mv', 'a.txt', 'renamed.txt']);

    const entries = await entriesFor(ctx, ['renamed.txt']);
    assert.equal(entries[0].origPath, 'a.txt');

    await commitEntries(ctx.git, { entries, message: 'rename', gitDir: ctx.gitDir });

    // With rename detection on, `diff --name-only` collapses this to the
    // destination alone; --no-renames shows that both sides were recorded.
    const committed = await ctx.git.nulLines([
      'diff', '--name-only', '--no-renames', '-z', 'HEAD~1', 'HEAD',
    ]);
    assert.deepEqual(committed.sort(), ['a.txt', 'renamed.txt']);
    assert.equal(await ctx.porcelain.showFile('HEAD', 'a.txt'), undefined, 'old name gone');
    assert.equal(await ctx.porcelain.showFile('HEAD', 'renamed.txt'), 'a.txt v1\n');
    assert.deepEqual(await ctx.porcelain.status(), [], 'no leftover delete');
  });

  test('includes deletions and new files', async () => {
    await fs.rm(path.join(ctx.repo, 'a.txt'));
    await fs.writeFile(path.join(ctx.repo, 'new.txt'), 'brand new\n');

    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, ['a.txt', 'new.txt']),
      message: 'add and remove',
      gitDir: ctx.gitDir,
    });

    assert.equal(await ctx.porcelain.showFile('HEAD', 'a.txt'), undefined);
    assert.equal(await ctx.porcelain.showFile('HEAD', 'new.txt'), 'brand new\n');
  });

  test('handles shell metacharacters in filenames', async () => {
    const tricky = 'weird name; echo pwned.txt';
    await fs.writeFile(path.join(ctx.repo, tricky), 'safe\n');
    await commitEntries(ctx.git, {
      entries: await entriesFor(ctx, [tricky]),
      message: 'tricky',
      gitDir: ctx.gitDir,
    });
    assert.deepEqual(
      await ctx.git.nulLines(['diff', '--name-only', '-z', 'HEAD~1', 'HEAD']),
      [tricky],
    );
  });

  test('refuses an empty changelist', async () => {
    await assert.rejects(
      () => commitEntries(ctx.git, { entries: [], message: 'x', gitDir: ctx.gitDir }),
      /empty changelist/i,
    );
  });

  test('a failed commit changes nothing at all', async () => {
    await fs.writeFile(path.join(ctx.repo, 'b.txt'), 'staged\n');
    await ctx.git.run(['add', 'b.txt']);
    const headBefore = await ctx.git.text(['rev-parse', 'HEAD']);
    const stagedBefore = await ctx.git.nulLines(['diff', '--cached', '--name-only', '-z']);

    // a.txt is in the list but has no change -> nothing to commit.
    const clean: WorkingTreeEntry[] = [
      { path: 'a.txt', status: 'modified', staged: false, unstaged: true },
    ];
    await assert.rejects(
      () => commitEntries(ctx.git, { entries: clean, message: 'no-op', gitDir: ctx.gitDir }),
      /nothing to commit/i,
    );

    assert.equal(await ctx.git.text(['rev-parse', 'HEAD']), headBefore);
    assert.deepEqual(
      await ctx.git.nulLines(['diff', '--cached', '--name-only', '-z']),
      stagedBefore,
      "the user's staging must survive a failed commit",
    );
  });

  test('works in a repository with no commits yet', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git4vs-unborn-'));
    repos.push(repo);
    const git = new GitRunner(repo);
    await git.run(['init', '--initial-branch=main']);
    await git.run(['config', 'user.email', 't@e.com']);
    await git.run(['config', 'user.name', 'T']);
    await fs.writeFile(path.join(repo, 'first.txt'), 'hello\n');

    const p = new Porcelain(git);
    const entries = await p.status();
    await commitEntries(git, {
      entries,
      message: 'first commit',
      gitDir: path.join(repo, '.git'),
    });

    assert.equal(await p.showFile('HEAD', 'first.txt'), 'hello\n');
  });
});

describe('in-progress operations are refused', () => {
  test('refuses to commit during a conflicted merge, leaving MERGE_HEAD intact', async () => {
    const ctx = await freshRepo();
    await ctx.git.run(['checkout', '-q', '-b', 'side']);
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'side\n');
    await ctx.git.run(['commit', '-qam', 'side change']);
    await ctx.git.run(['checkout', '-q', 'main']);
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'main\n');
    await ctx.git.run(['commit', '-qam', 'main change']);

    await ctx.git.run(['merge', 'side'], { okExitCodes: [0, 1] });
    assert.equal(await repoOperationState(ctx.git, ctx.gitDir), 'merging');

    await fs.writeFile(path.join(ctx.repo, 'b.txt'), 'unrelated\n');
    await assert.rejects(
      () =>
        commitEntries(ctx.git, {
          entries: [{ path: 'b.txt', status: 'modified', staged: false, unstaged: true }],
          message: 'sneaky',
          gitDir: ctx.gitDir,
        }),
      (err: Error) => err instanceof RepoBusyError && /merg/i.test(err.message),
    );

    // The merge is still abortable -- nothing was clobbered.
    assert.equal(await exists(path.join(ctx.gitDir, 'MERGE_HEAD')), true);
    await ctx.git.run(['merge', '--abort']);
  });

  test('refuses to commit during a rebase', async () => {
    const ctx = await freshRepo();
    await ctx.git.run(['checkout', '-q', '-b', 'side']);
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'side\n');
    await ctx.git.run(['commit', '-qam', 'side']);
    await ctx.git.run(['checkout', '-q', 'main']);
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'main\n');
    await ctx.git.run(['commit', '-qam', 'main']);
    await ctx.git.run(['checkout', '-q', 'side']);

    await ctx.git.run(['rebase', 'main'], { okExitCodes: [0, 1, 128] });
    assert.equal(await repoOperationState(ctx.git, ctx.gitDir), 'rebasing');

    await assert.rejects(
      () =>
        commitEntries(ctx.git, {
          entries: [{ path: 'b.txt', status: 'modified', staged: false, unstaged: true }],
          message: 'sneaky',
          gitDir: ctx.gitDir,
        }),
      RepoBusyError,
    );

    await ctx.git.run(['rebase', '--abort'], { okExitCodes: [0, 1, 128] });
  });

  test('reports clean for an ordinary repository', async () => {
    const ctx = await freshRepo();
    assert.equal(await repoOperationState(ctx.git, ctx.gitDir), 'clean');
  });
});

describe('rollbackEntries', () => {
  let ctx: Ctx;
  beforeEach(async () => {
    ctx = await freshRepo();
  });

  test('reverts tracked files and deletes only the listed untracked ones', async () => {
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'CHANGED\n');
    await fs.writeFile(path.join(ctx.repo, 'mine.txt'), 'delete me\n');
    await fs.writeFile(path.join(ctx.repo, 'keep.txt'), 'keep me\n');

    const result = await rollbackEntries(ctx.git, await entriesFor(ctx, ['a.txt', 'mine.txt']));

    assert.deepEqual(result.reverted, ['a.txt']);
    assert.deepEqual(result.deleted, ['mine.txt']);
    assert.equal(await fs.readFile(path.join(ctx.repo, 'a.txt'), 'utf8'), 'a.txt v1\n');
    assert.equal(await exists(path.join(ctx.repo, 'mine.txt')), false);
    assert.equal(await fs.readFile(path.join(ctx.repo, 'keep.txt'), 'utf8'), 'keep me\n');
  });

  test('reverting a rename restores the original file', async () => {
    await ctx.git.run(['mv', 'a.txt', 'renamed.txt']);
    await rollbackEntries(ctx.git, await entriesFor(ctx, ['renamed.txt']));

    assert.equal(
      await fs.readFile(path.join(ctx.repo, 'a.txt'), 'utf8'),
      'a.txt v1\n',
      'the original name must come back with its content',
    );
    assert.equal(await exists(path.join(ctx.repo, 'renamed.txt')), false);
    assert.deepEqual(await ctx.porcelain.status(), [], 'tree must be clean again');
  });

  test('unstages as well as reverting', async () => {
    await fs.writeFile(path.join(ctx.repo, 'a.txt'), 'CHANGED\n');
    await ctx.git.run(['add', 'a.txt']);
    await rollbackEntries(ctx.git, await entriesFor(ctx, ['a.txt']));

    assert.deepEqual(await ctx.git.nulLines(['diff', '--cached', '--name-only', '-z']), []);
    assert.equal(await fs.readFile(path.join(ctx.repo, 'a.txt'), 'utf8'), 'a.txt v1\n');
  });

  test('works in a repository with no commits yet', async () => {
    const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'git4vs-unborn-rb-'));
    repos.push(repo);
    const git = new GitRunner(repo);
    await git.run(['init', '--initial-branch=main']);
    await git.run(['config', 'user.email', 't@e.com']);
    await git.run(['config', 'user.name', 'T']);
    await fs.writeFile(path.join(repo, 'f.txt'), 'x\n');
    await git.run(['add', 'f.txt']);

    const entries = await new Porcelain(git).status();
    await rollbackEntries(git, entries);

    assert.equal(await exists(path.join(repo, 'f.txt')), false);
  });

  test('is a no-op for an empty list', async () => {
    const before = await ctx.porcelain.status();
    assert.deepEqual(await rollbackEntries(ctx.git, []), { reverted: [], deleted: [] });
    assert.deepEqual(await ctx.porcelain.status(), before);
  });
});

describe('pathsOf', () => {
  test('includes both names of a rename and de-duplicates', () => {
    const entries: WorkingTreeEntry[] = [
      { path: 'new.txt', origPath: 'old.txt', status: 'renamed', staged: true, unstaged: false },
      { path: 'new.txt', status: 'modified', staged: false, unstaged: true },
    ];
    assert.deepEqual(pathsOf(entries).sort(), ['new.txt', 'old.txt']);
  });
});

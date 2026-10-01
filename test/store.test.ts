import { strict as assert } from 'assert';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, describe, before, after } from 'node:test';

import { GitRunner } from '../src/git/cli';
import { Porcelain } from '../src/git/porcelain';
import { ChangelistStore, REF_NAMESPACE } from '../src/changelists/store';
import {
  DEFAULT_CHANGELIST_ID,
  movePaths,
  newChangelistId,
  normalizeState,
  reconcile,
  emptyState,
} from '../src/changelists/model';

let repo: string;
let git: GitRunner;
let porcelain: Porcelain;

async function write(rel: string, content: string): Promise<void> {
  const full = path.join(repo, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

before(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'idea-git-test-'));
  git = new GitRunner(repo);
  porcelain = new Porcelain(git);
  await git.run(['init', '--initial-branch=main']);
  await git.run(['config', 'user.email', 'test@example.com']);
  await git.run(['config', 'user.name', 'Test']);
  await write('README.md', 'hello\n');
  await write('src/app.ts', 'export const a = 1;\n');
  await git.run(['add', '-A']);
  await git.run(['commit', '-m', 'initial']);
});

after(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('GitRunner', () => {
  test('passes arguments without shell interpretation', async () => {
    const weird = 'a file; rm -rf $HOME.txt';
    await write(weird, 'safe\n');
    await git.run(['add', '--', weird]);
    const staged = await git.nulLines(['diff', '--cached', '--name-only', '-z']);
    assert.ok(staged.includes(weird), `expected ${weird} in ${JSON.stringify(staged)}`);
    await git.run(['reset', '--', weird]);
    await fs.rm(path.join(repo, weird));
  });

  test('reports non-zero exit codes as errors unless allowed', async () => {
    await assert.rejects(() => git.run(['rev-parse', '--verify', 'nope']));
    const res = await git.run(['rev-parse', '--verify', '--quiet', 'nope'], {
      okExitCodes: [0, 1],
    });
    assert.equal(res.exitCode, 1);
  });
});

describe('Porcelain.status', () => {
  test('classifies modified, added, untracked and renamed entries', async () => {
    await write('README.md', 'hello world\n');
    await write('newfile.txt', 'new\n');
    await git.run(['mv', 'src/app.ts', 'src/renamed.ts']);

    const entries = await porcelain.status();
    const byPath = new Map(entries.map((e) => [e.path, e]));

    assert.equal(byPath.get('README.md')?.status, 'modified');
    assert.equal(byPath.get('newfile.txt')?.status, 'untracked');

    const renamed = byPath.get('src/renamed.ts');
    assert.ok(renamed, 'renamed entry missing');
    assert.equal(renamed!.status, 'renamed');
    assert.equal(renamed!.origPath, 'src/app.ts');

    // restore
    await git.run(['mv', 'src/renamed.ts', 'src/app.ts']);
    await git.run(['checkout', '--', 'README.md']);
    await fs.rm(path.join(repo, 'newfile.txt'));
  });

  test('handles paths containing spaces', async () => {
    await write('a dir/with spaces.txt', 'x\n');
    const entries = await porcelain.status();
    const found = entries.find((e) => e.path === 'a dir/with spaces.txt');
    assert.ok(found, `not found in ${JSON.stringify(entries.map((e) => e.path))}`);
    assert.equal(found!.status, 'untracked');
    await fs.rm(path.join(repo, 'a dir/with spaces.txt'));
  });
});

describe('ChangelistStore snapshots', () => {
  test('snapshot creates a ref without touching the working tree', async () => {
    await write('README.md', 'snapshot me\n');
    await write('src/app.ts', 'export const a = 2;\n');

    const store = await ChangelistStore.create(git);
    const beforeStatus = await porcelain.status();

    const hash = await store.snapshot({
      id: 'feature-x',
      name: 'Feature X',
      paths: ['README.md'],
    });

    assert.ok(hash && /^[0-9a-f]{40}$/.test(hash), `bad hash: ${hash}`);

    // Working tree is unchanged: same status before and after.
    const afterStatus = await porcelain.status();
    assert.deepEqual(
      afterStatus.map((e) => `${e.path}:${e.status}`).sort(),
      beforeStatus.map((e) => `${e.path}:${e.status}`).sort(),
    );

    // The real index is untouched too.
    const stagedAfter = await git.nulLines(['diff', '--cached', '--name-only', '-z']);
    assert.deepEqual(stagedAfter, []);

    // The ref exists and its tree holds the snapshotted content.
    const refHash = await porcelain.revParse(`${REF_NAMESPACE}/feature-x`);
    assert.equal(refHash, hash);
    const content = await porcelain.showFile(hash!, 'README.md');
    assert.equal(content, 'snapshot me\n');

    // A file NOT in the list keeps its HEAD content in the snapshot.
    const untouched = await porcelain.showFile(hash!, 'src/app.ts');
    assert.equal(untouched, 'export const a = 1;\n');
  });

  test('snapshot records deletions', async () => {
    await write('doomed.txt', 'bye\n');
    await git.run(['add', 'doomed.txt']);
    await git.run(['commit', '-m', 'add doomed']);
    await fs.rm(path.join(repo, 'doomed.txt'));

    const store = await ChangelistStore.create(git);
    const hash = await store.snapshot({
      id: 'deletions',
      name: 'Deletions',
      paths: ['doomed.txt'],
    });

    const content = await porcelain.showFile(hash!, 'doomed.txt');
    assert.equal(content, undefined, 'deleted file should be absent from snapshot tree');

    await git.run(['checkout', '--', 'doomed.txt']);
  });

  test('empty changelist deletes its ref', async () => {
    const store = await ChangelistStore.create(git);
    await store.snapshot({ id: 'transient', name: 'T', paths: ['README.md'] });
    assert.ok(await porcelain.revParse(`${REF_NAMESPACE}/transient`));

    await store.snapshot({ id: 'transient', name: 'T', paths: [] });
    assert.equal(await porcelain.revParse(`${REF_NAMESPACE}/transient`), undefined);
  });

  test('state round-trips through disk', async () => {
    const store = await ChangelistStore.create(git);
    const state = {
      ...emptyState(),
      activeId: 'feature-x',
      lists: [
        { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: ['src/app.ts'] },
        { id: 'feature-x', name: 'Feature X', paths: ['README.md'] },
      ],
    };
    await store.save(state);
    const loaded = await store.load();
    assert.equal(loaded.activeId, 'feature-x');
    assert.deepEqual(loaded.lists.map((l) => l.id), [DEFAULT_CHANGELIST_ID, 'feature-x']);
  });

  test('state file lives inside .git and is therefore never committed', async () => {
    const store = await ChangelistStore.create(git);
    await store.save(emptyState());
    const tracked = await porcelain.status();
    assert.ok(
      !tracked.some((e) => e.path.includes('idea-git')),
      'changelist metadata must not appear as a working tree change',
    );
  });
});

describe('shelving', () => {
  test('shelve removes files from the tree and is findable again', async () => {
    await write('shelf-me.txt', 'shelved content\n');
    const store = await ChangelistStore.create(git);

    await store.shelve({ id: 'wip', name: 'WIP', paths: ['shelf-me.txt'] });

    assert.equal(
      await fs
        .access(path.join(repo, 'shelf-me.txt'))
        .then(() => true)
        .catch(() => false),
      false,
      'shelved file should be gone from the working tree',
    );

    const shelves = await store.listShelves();
    const mine = shelves.find((s) => s.name === 'WIP');
    assert.ok(mine, `WIP shelf not found in ${JSON.stringify(shelves)}`);

    await store.unshelve(mine!.ref, true);
    const restored = await fs.readFile(path.join(repo, 'shelf-me.txt'), 'utf8');
    assert.equal(restored, 'shelved content\n');
    await fs.rm(path.join(repo, 'shelf-me.txt'));
  });
});

describe('model', () => {
  test('normalizeState repairs duplicates and a missing default list', () => {
    const state = normalizeState({
      version: 1,
      activeId: 'ghost',
      lists: [
        { id: 'a', name: 'A', paths: ['x.ts', 'y.ts'] },
        { id: 'a', name: 'dup', paths: ['z.ts'] },
        { id: 'b', name: 'B', paths: ['x.ts', 'w.ts'] },
      ],
    });

    assert.equal(state.activeId, DEFAULT_CHANGELIST_ID);
    assert.ok(state.lists.some((l) => l.id === DEFAULT_CHANGELIST_ID));
    assert.equal(state.lists.filter((l) => l.id === 'a').length, 1);

    const b = state.lists.find((l) => l.id === 'b')!;
    assert.deepEqual(b.paths, ['w.ts'], 'x.ts already claimed by list a');
  });

  test('normalizeState survives garbage input', () => {
    for (const junk of [null, undefined, 42, 'nope', [], { lists: 'no' }]) {
      const s = normalizeState(junk);
      assert.equal(s.lists.length, 1);
      assert.equal(s.activeId, DEFAULT_CHANGELIST_ID);
    }
  });

  test('reconcile drops vanished paths and assigns new ones to the active list', () => {
    const state = {
      ...emptyState(),
      activeId: 'feat',
      lists: [
        { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: ['gone.ts', 'kept.ts'] },
        { id: 'feat', name: 'Feature', paths: [] },
      ],
    };

    const next = reconcile(state, ['kept.ts', 'brand-new.ts'], true);
    const def = next.lists.find((l) => l.id === DEFAULT_CHANGELIST_ID)!;
    const feat = next.lists.find((l) => l.id === 'feat')!;

    assert.deepEqual(def.paths, ['kept.ts']);
    assert.deepEqual(feat.paths, ['brand-new.ts']);
  });

  test('reconcile leaves new paths unassigned when auto-assign is off', () => {
    const next = reconcile(emptyState(), ['a.ts'], false);
    assert.deepEqual(next.lists[0].paths, []);
  });

  test('movePaths transfers ownership exactly once', () => {
    const state = {
      ...emptyState(),
      lists: [
        { id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: ['a.ts', 'b.ts'] },
        { id: 'feat', name: 'Feature', paths: ['c.ts'] },
      ],
    };
    const next = movePaths(state, ['a.ts'], 'feat');
    assert.deepEqual(next.lists[0].paths, ['b.ts']);
    assert.deepEqual(next.lists[1].paths, ['a.ts', 'c.ts']);
  });

  test('newChangelistId avoids collisions and produces ref-safe slugs', () => {
    assert.equal(newChangelistId('My Feature', []), 'my-feature');
    assert.equal(newChangelistId('My Feature', ['my-feature']), 'my-feature-2');
    assert.equal(newChangelistId('weird/~^:name', []), 'weird-name');
    assert.equal(newChangelistId('...', []), 'unnamed');
    assert.equal(newChangelistId('my.lock', []), 'my-lock');
    assert.equal(newChangelistId('  spaced  out ', []), 'spaced-out');
  });
});

# HANDOVER — `idea-git` VS Code extension

**For whoever picks this up next (human or assistant). Read this before touching code.**

Everything here is self-contained; you do not need the originating conversation.
State as of 2026-10-01: builds clean, typechecks clean, 40/40 tests pass,
packaged as `idea-git-0.1.0.vsix`.

---

## 1. Who this is for and what was actually asked

Paviel (software developer, Sedex — Kotlin backend services, internal tooling)
is migrating from IntelliJ IDEA to VS Code and finds VS Code's git integration
poor. The opening request was literally:

> "git4idea is an open source plugin and we can port it to vs code — can you
> implement this?"

**That request was reframed, with his agreement.** A literal port is not
feasible: `git4idea` is ~200k lines of Kotlin/Java welded to IntelliJ platform
APIs (the VCS abstraction, the DVCS framework, the UI toolkit, the change-list
model, background task infrastructure). Most of a "port" would be reimplementing
IntelliJ's plumbing, not anything git-related.

When asked which git4idea workflows he actually missed, he said:

> "Git tree, right click to rebase reset diff buttons to commit push update etc
> just the basic functions, different window changelists"

and chose **"survey first, then build"**. Later, after the survey, he asked to
**"build on top of existing ones but add the missing functions including diff
window"**, and picked **git-stash-backed** changelist storage (see §4.1 — this
was implemented in spirit, not literally, and he was told why).

**Licensing:** `git4idea` is Apache-2.0, so copying code would be permitted with
attribution. **No git4idea code was copied.** Behaviour was reimplemented
against the `git` CLI. This extension is also Apache-2.0.

---

## 2. The survey result — the single most important decision

The survey is why this project is small. Do not undo it.

| git4idea feature | Already solved by | Verdict |
|---|---|---|
| Commit graph, coloured branch rails | **Git Graph+** (`the0807.git-graph-plus`), Apache-2.0, actively maintained (v0.7.3, Jun 2026), TS+Svelte, written from scratch | don't rebuild |
| Right-click rebase / reset / cherry-pick / revert / interactive rebase (drag-to-reorder) | **Git Graph+** | don't rebuild |
| Branch / remote / tag / stash / worktree trees | **Git Graph+** | don't rebuild |
| Staging, hunk-level staging, 3-way merge editor | **built-in `vscode.git`** | don't rebuild |
| **Changelists** | nothing credible — [`Arkady-Dymkov/changelists`](https://github.com/Arkady-Dymkov/changelists) is 1 commit / 0 stars; GitLens [declined since 2021](https://github.com/eamodio/vscode-gitlens/issues/1333); VS Code core has an [open request](https://github.com/microsoft/vscode/issues/249974) | **build** |
| Compare-with-revision / branch / two-revisions, file-history diff | partial at best | **build** |
| Commit / Push / Update buttons | partial | **build (thin)** |

Also noted: VS Code now ships its own Source Control Graph, but it still
[lacks reset / soft-reset / squash](https://github.com/microsoft/vscode/issues/257433).
The old [`mhutchie.git-graph`](https://github.com/mhutchie/vscode-git-graph) has
those actions but its last release was **April 2021** — unmaintained, don't
depend on it. [`WMBGmbH.intellij-git-ext`](https://marketplace.visualstudio.com/items?itemName=WMBGmbH.intellij-git-ext)
claims to do everything but has ~3.8k installs, one review, and no update since
Nov 2024 — not on anyone's critical path.

**Consequence:** this extension deliberately has **no commit graph**.
`ideaGit.vcs.openGraph` forwards to Git Graph+ (`gitGraphPlus.open`), falls back
to `mhutchie`'s `git-graph.view`, then to VS Code's built-in
`scm.showHistoryGraph`, then offers to install Git Graph+. See
`src/integration/gitGraphPlus.ts`. If a future request is "add a graph", push
back and point here first.

---

## 3. Project map

```
idea-git/
├─ package.json            manifest: 18 commands, 1 view, 4 settings, NO keybindings (§4.2)
├─ esbuild.js              bundles src/extension.ts → dist/extension.js (vscode external)
├─ tsconfig.json           main build (strict, noUnusedLocals)
├─ tsconfig.test.json      test build; rootDir "." → output lands in dist-test/test/
├─ README.md               user-facing docs
├─ HANDOVER.md             this file
└─ src/
   ├─ extension.ts                 activate(): wires API, tree view, commands, per-repo managers
   ├─ commands.ts                  command implementations (prompts, confirmations, progress, errors)
   ├─ git/
   │  ├─ cli.ts                    GitRunner — spawn(git, argv[]). NEVER a shell string.
   │  ├─ porcelain.ts              status --porcelain=v2 -z parser, log, show, rev-parse, branches
   │  └─ gitApi.ts                 minimal typing of the built-in `vscode.git` API + repo picking
   ├─ changelists/
   │  ├─ model.ts                  pure data: state shape, normalize, reconcile, movePaths, refSlug
   │  ├─ store.ts                  persistence: JSON in .git/ + snapshot commits under refs/
   │  ├─ operations.ts             ⚠ the destructive git sequences — commit & rollback
   │  ├─ manager.ts                per-repo orchestration, serialised mutation queue, events
   │  └─ treeView.ts               TreeDataProvider + TreeDragAndDropController
   ├─ diff/
   │  ├─ revisionProvider.ts       TextDocumentContentProvider for scheme `idea-git-rev`
   │  └─ commands.ts               compare-with-revision/branch/two-revisions, file history
   └─ integration/gitGraphPlus.ts  delegation to a graph extension, every call guarded
└─ test/
   ├─ operations.test.ts     29 tests — pathspec safety, commit isolation, in-progress guards, rollback
   └─ store.test.ts          11 tests — status parsing, snapshots, shelving, model invariants
```

**Vscode-free modules** (importable by tests): `git/cli.ts`, `git/porcelain.ts`,
`changelists/model.ts`, `changelists/store.ts`, `changelists/operations.ts`.
Keep it that way — it is the only reason the dangerous code is testable.
`tsconfig.test.json`'s `include` list names them explicitly; add to it if you
extract more.

---

## 4. Design decisions and their rationale

### 4.1 Storage: NOT literal stash entries (deviation from what was asked)

Paviel chose the option described as *"each inactive changelist becomes a real
stash entry."* Implemented literally that is wrong, and he was told so:
`git stash push` **removes files from the working tree**, so with three
changelists you would only ever see one list's files on disk. That is shelving,
not changelists. IDEA keeps every changelist in the working tree; *shelves* are
the separate thing that removes content.

What was built instead — two layers:

1. **Assignments** (which file is in which list) → `.git/idea-git/changelists.json`.
   `.git` is the one directory guaranteed never to be tracked, so this metadata
   can't reach a commit. Written via write-then-rename. Re-validated on every
   load (`normalizeState`) because the file can be hand-edited or written by an
   older build — a corrupt file degrades to a clean state rather than breaking
   the view.

2. **Content** → real commit objects under `refs/idea-git/changelists/<id>`,
   built in a **temporary index** (`GIT_INDEX_FILE` + `read-tree` →
   `update-index` → `write-tree` → `commit-tree` → `update-ref`). A ref anchors
   the objects against `gc`, so a snapshot survives branch switches, resets,
   reboots and a deleted metadata file — the durability he wanted — while the
   working tree and the real index are never touched.

   Recovery is plain git:
   ```bash
   git for-each-ref refs/idea-git/changelists
   git show <hash>:path/to/file
   git diff HEAD <hash>
   ```

3. **Real stashes are still used** — for the explicit **Shelve** command, where
   removing the changes from the tree *is* the point. Tagged
   `idea-git-shelf:<name>` so `listShelves()` can find them again.

### 4.2 No default keybindings (deviation from "IDEA muscle memory")

IDEA's `Ctrl+K` / `Ctrl+Shift+K` / `Ctrl+T` all collide with real VS Code
defaults: `Ctrl+K` is the **chord prefix** (binding it plainly breaks every
`Ctrl+K Ctrl+*` shortcut), `Ctrl+Shift+K` is **Delete Line**, `Ctrl+T` is **Go
to Symbol in Workspace**. Claiming those by default would make the editor feel
broken in ways a user would never trace back to this extension. They were
removed from the manifest and documented in README as a paste-in
`keybindings.json` block. **Do not re-add them to `contributes.keybindings`.**

### 4.3 Why the git CLI rather than the built-in API

The `vscode.git` API is used for repository *discovery*, the git binary path,
and change events — see `src/git/gitApi.ts`, which types only the members
actually used (depending on the full `git.d.ts` would pin a VS Code version).
Everything else goes through `GitRunner` because the API exposes no temporary
index, no `commit-tree`, no `update-ref`, and no pathspec control — all of which
this design needs.

`GitRunner` always takes `argv` arrays, never a shell string, and forces
`GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `GIT_PAGER=cat`, `LC_ALL=C` for
stable, non-interactive output.

---

## 5. ⚠ Invariants — breaking any of these loses user work

An adversarial review found four data-loss bugs in the first implementation.
All are fixed and all have named regression tests. **If you change
`operations.ts`, `store.ts` or `manager.ts`, re-read this section.**

### 5.1 Every path handed to git must be `:(literal)`-wrapped

git reports **literal** filenames in `status` but consumes them as **globs**.
A file genuinely named `note*.md` in one changelist made `git add`,
`git restore` and `git clean` also match `notes.md` and `noteX.md` — committing,
reverting and **permanently deleting** files belonging to other changelists.
A leading `:` was worse: `git add -- ':colon.txt'` fails as pathspec magic.

Use `literal()` from `operations.ts` for anything passed as a pathspec.
Exception: `git update-index` takes **literal paths already** and must *not* be
wrapped — that is why `store.snapshot()` and `commitEntries()` pass bare paths
to it. Tests: `pathspec safety` describe block.

### 5.2 Never run `git reset` to clear the index before committing

The original `commitPaths()` did. It:
- destroyed index-only content (staged blob ≠ worktree file → unreachable),
- wiped `MERGE_HEAD` / `MERGE_MSG` mid-merge, making `git merge --abort`
  impossible and producing a non-merge commit with conflict markers,
- and on failure after the reset, silently discarded the user's staging with no
  way to restore it.

`commitEntries()` now assembles the commit in a **temporary index** seeded from
HEAD, so the user's real index is never touched. It is still a real `git commit`
(run with `GIT_INDEX_FILE` set), so **hooks, GPG signing and commit templates
all work normally** — don't "optimise" it into `commit-tree`, which would bypass
them. Afterwards the real index is refreshed for the committed paths only, so
the files read as clean instead of showing a phantom reverse diff.

Tests: `leaves the user's separately staged work staged and uncommitted`,
`preserves index-only content that differs from the worktree`,
`a failed commit changes nothing at all`.

### 5.3 Refuse to commit during a multi-step operation

`repoOperationState()` checks for `MERGE_HEAD`, `rebase-merge`/`rebase-apply`,
`CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG` and `commitEntries()` throws
`RepoBusyError`. Verified failure mode without it: during a conflicted rebase
the commit landed on the detached rebase head, `git rebase --continue` then
refused, and `git rebase --abort` **threw the commit and its content away**.

### 5.4 Renames carry both names

A rename is one status entry whose `path` is the **new** name and `origPath` the
old one. Operating on `path` alone meant rollback deleted the new file and left
the old one staged-deleted — **neither file on disk**, content unrecoverable if
the rename carried edits. `pathsOf()` returns both; use it, don't map over
`.path`.

### 5.5 `git clean` is always bounded by explicit pathspecs

Never `clean -fd`. Only the exact untracked paths in the list, each
`:(literal)`-wrapped. Test: `clean never deletes untracked files outside the list`.

### Other fixed issues worth not regressing

- `viewItem =~ /^changelist/` also matched `changelistFile`, putting list-only
  actions (incl. Rollback) on every file row. It is now `/^changelist\./`.
- `ideaGit.diff.withRevision` is contributed to the tree view, the editor title
  menu *and* the palette, so its argument may be a `ChangelistNode`, a `Uri`, or
  nothing. `toUri()` in `extension.ts` normalises — passing a node straight
  through threw inside `path.relative`.
- A contributed `ideaGit.fileHistory` view had no provider and rendered
  permanently empty; removed.
- `npm test` globbed `dist-test/*.test.js` and silently ran **zero** tests while
  exiting 0. Fixed to `dist-test/test/*.test.js`.
- `isImmutableRef` cached any 7–40 hex string forever; a branch named
  `deadbeef` is legal, so only full 40-char hashes are cached now.
- Managers are no longer pushed onto `context.subscriptions` per repository
  (that array is never pruned); `removeRepository` disposes them and a single
  dispose hook covers deactivation.
- `refresh()` and `snapshotNow()` rejections are swallowed at the event-listener
  boundary — an unhandled rejection there surfaced as a crash notification.

---

## 6. Build, test, package

```bash
cd /home/claude/idea-git
npm install
npm run typecheck     # tsc --noEmit, strict
npm run build         # esbuild → dist/extension.js (~31 KB)
npm test              # pretest compiles, then 40 node:test tests
npx @vscode/vsce package --allow-missing-repository --skip-license
```

Tests create throwaway repos under the OS temp dir and clean up in `after()`.
They need a real `git` binary (verified against 2.43). No VS Code required —
that is deliberate, see §3.

To install locally: `code --install-extension idea-git-0.1.0.vsix`, or
Extensions panel → `⋯` → *Install from VSIX*.

---

## 7. Current state

**Works and is tested** (40 tests): the git layer end to end — status parsing
(v2 format, renames, conflicts, spaces, glob chars), temp-index snapshots,
commit isolation, in-progress-operation guards, rollback semantics, shelve/
unshelve round-trip, state normalisation and reconciliation.

**Written, typechecked, reviewed — but never run inside VS Code:** the entire UI
layer. Tree view rendering, drag and drop, menu `when` clauses, command
argument plumbing, the `idea-git-rev` content provider, progress/error toasts.
**0.1.0 is "ready to try", not "battle-tested."** Paviel was told this.

**The obvious next step is an F5 smoke test** in an Extension Development Host
against a scratch repo: create a list, drag a file into it, commit it, confirm
only those files landed, roll one back, shelve/unshelve, open each diff command.

---

## 8. Known limitations (documented in README, not bugs)

- Changelists are **local** — not shared with teammates, don't survive a fresh
  clone. Same as IDEA.
- **No multi-file diff container.** VS Code exposes no API for an extension to
  populate one, so "diff a changelist" is a multi-select quick pick that opens
  each file's diff into its own tab. This is the API ceiling, not laziness.
- **No hunk-level changelist assignment** — a file belongs to one list as a
  whole. IDEA can't split a file across changelists either.
- Untested against **submodules** and **bare / worktree checkouts**.
- `Porcelain.showFile` decodes stdout as UTF-8, so binary blobs are corrupted in
  revision diffs, and any exit-128 maps to "absent". Low priority; would need a
  buffer-returning path for binary-aware diffs.

## 9. Ideas that were considered and deliberately not done

- Rebuilding the commit graph (§2).
- Forking Git Graph+ — it has no exported API, so integration is by command id;
  forking would mean diverging from an actively maintained project.
- Re-adding IDEA keybindings as defaults (§4.2).
- Using `commit-tree` directly instead of `git commit` with a temp index — would
  bypass hooks and signing (§5.2).

---

## 10. Reference

- Git Graph+ — https://github.com/the0807/git-graph-plus (Apache-2.0, id `the0807.git-graph-plus`)
- Legacy Git Graph — https://github.com/mhutchie/vscode-git-graph (unmaintained since 2021)
- VS Code built-in graph gaps — https://github.com/microsoft/vscode/issues/257433
- VS Code changelist request — https://github.com/microsoft/vscode/issues/249974
- GitLens changelists (declined) — https://github.com/eamodio/vscode-gitlens/issues/1333
- Built-in git API surface — `extensions/git/src/api/git.d.ts` in microsoft/vscode

**Communication note:** Paviel's original framing ("we can port it") was
over-scoped, and saying so plainly — with a concrete alternative — was the
useful move. He engaged with the pushback both times (scope, and the stash
design). Keep being direct about what won't work and why.

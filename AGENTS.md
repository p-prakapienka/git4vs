# AGENTS.md

Operating rules for coding agents in this repo. Read this, then
[HANDOVER.md](HANDOVER.md), before editing. HANDOVER has the design rationale
and the names of the regression tests; this file is the constraint list.

## What this is

`git4vs` ([p-prakapienka/git4vs](https://github.com/p-prakapienka/git4vs)) is a
VS Code extension that adds IntelliJ-style **changelists** and **revision
diffs**. Apache-2.0. **No `git4idea` source was copied, and none may be.**

It is deliberately small. A literal port of git4idea is out of scope: that
plugin is welded to IntelliJ platform APIs. Do not grow this into one.

## Do not build

| Ask | Why not | Do this instead |
| --- | --- | --- |
| Commit graph, branch rails, rebase / reset / cherry-pick UI | Git Graph+ already does this and is maintained | `git4vs.vcs.openGraph` in `src/integration/gitGraphPlus.ts` delegates to it |
| Default IDEA keybindings (`Ctrl+K`, `Ctrl+Shift+K`, `Ctrl+T`) | Those are VS Code's chord prefix, Delete Line, and Go to Symbol | Opt-in snippet is in the README. Do not add `contributes.keybindings` |
| One real `git stash` entry per inactive changelist | `stash push` removes those files from the working tree, so only one list would be visible | Assignments in `.git/git4vs/changelists.json`; content as commits on `refs/git4vs/changelists/<id>`. Real stash only for the explicit Shelve command |
| `commit-tree` instead of `git commit` | Bypasses hooks, signing, and templates | Temporary index plus a real `git commit` |

If asked for any of the above, say why and point here. Do not implement it.

## Where code lives

These modules must stay free of the `vscode` import. Tests import them
directly, and that is the only reason the dangerous git code is testable.
`tsconfig.test.json` `include` names them; add a new one there if you extract
more:

- `src/git/cli.ts` — `GitRunner`. `argv` arrays only, never a shell string.
- `src/git/porcelain.ts`
- `src/changelists/model.ts`
- `src/changelists/store.ts`
- `src/changelists/operations.ts`

`vscode.git` (`src/git/gitApi.ts`) is only for repository discovery, the git
binary path, and change events. Type only the members you use. Do not depend
on the full `git.d.ts`.

The UI layer (`extension.ts`, `commands.ts`, `treeView.ts`, `diff/`) is
typechecked and reviewed, **not** exercised inside VS Code. Do not describe it
as tested.

## Invariants

Breaking these loses user work. Details and the named tests are in HANDOVER
§5. Re-read that section before changing `operations.ts`, `store.ts`, or
`manager.ts`. A change to those git sequences needs a regression test, and
`npm test` must stay green.

1. Every pathspec goes through `literal()` (`:(literal)…`). Exception:
   `git update-index` already takes literal paths and must **not** be wrapped.
2. Never `git reset` the real index in order to commit. `commitEntries()`
   builds a temporary index (`GIT_INDEX_FILE`) seeded from HEAD. The user's
   staged work stays as they left it, including index-only content.
3. `commitEntries()` throws `RepoBusyError` while a merge, rebase,
   cherry-pick, revert, or bisect is in progress. Do not remove that guard.
4. A rename is one status entry: `path` is the new name, `origPath` the old.
   Use `pathsOf()`. Mapping over `.path` alone deletes the new file and leaves
   the old one staged-deleted.
5. Never `git clean -fd`. Only the exact untracked paths in that list, each
   `:(literal)`-wrapped.
6. Assignments stay inside `.git/` so they cannot be committed. Snapshot
   objects stay on `refs/git4vs/changelists/<id>`. Do not invent a second
   store in the working tree.
7. List-only menu `when` clauses match `/^changelist\./`, not `/^changelist/`.
   The shorter form also matches `changelistFile` and puts Rollback on file
   rows.
8. The `npm test` glob is `dist-test/test/*.test.js`. A glob that matches
   nothing exits 0 and looks like a pass.

## Commands

```bash
npm ci
npm run typecheck
npm test          # pretest compiles tsconfig.test.json, then the node:test suite
npm run build     # esbuild → dist/extension.js
npx @vscode/vsce package --skip-license
```

Tests need a real `git` on `PATH`. They create throwaway repos in the OS temp
dir. No VS Code is required, and CI does not have one.

`.github/workflows/build.yml` runs typecheck, test, build, and package on
every push to `main` and uploads the `git4vs-vsix` artifact. Do not merge a
change that breaks it.

## Scope

Fix the bug or add the behaviour that was asked. Do not refactor neighbours,
do not add a graph, and do not add a second way to store changelists.
New git behaviour gets a test beside the ones in `test/`.

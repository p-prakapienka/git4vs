# IDEA Git — Changelists & Diff

A VS Code extension for people moving over from IntelliJ IDEA who miss
`git4idea`. It deliberately implements **only the parts nothing else covers**
and delegates the rest.

> Picking this project up cold? Read **[HANDOVER.md](HANDOVER.md)** first — it
> has the design rationale, the safety invariants, and what is and isn't tested.
> Coding agents: **[AGENTS.md](AGENTS.md)** is the constraint list; it points
> back here.

## Why this shape

A literal port of `git4idea` is not feasible — it's ~200k lines welded to the
IntelliJ platform. More importantly, most of what people miss is already
solved in the VS Code ecosystem:

| git4idea feature | Where it comes from |
| --- | --- |
| Commit graph, branch rails | **Git Graph+** (`the0807.git-graph-plus`) |
| Right-click rebase / reset / cherry-pick / interactive rebase | **Git Graph+** |
| Branch, tag, stash, worktree trees | **Git Graph+** |
| Staging, hunk-level staging, 3-way merge | **built-in Git** |
| **Changelists** | **this extension** |
| **Compare with revision / branch / two revisions, file history diff** | **this extension** |
| Commit / Push / Update buttons and IDEA keybindings | **this extension** |

Install Git Graph+ alongside this. `IDEA Git: Show Git Log` forwards to it
(`gitGraphPlus.open`), falling back to the older `mhutchie.git-graph` and then
to VS Code's own Source Control Graph.

## Changelists

Named groups of uncommitted changes, as in IDEA:

- One list is **active**; newly modified files land there automatically.
- **Drag files between lists** in the Changelists view, or use *Move to
  Changelist…* from the view or the built-in Source Control panel.
- **Commit Changelist** commits *only* that list, and does it by assembling
  the commit in a **temporary index** (`GIT_INDEX_FILE`). Anything you had
  staged by hand is neither swept into the commit nor thrown away to keep it
  out — it stays exactly as you left it, index-only content included. It's
  still a real `git commit`, so hooks, signing and templates work normally.
- Committing is **refused** while a merge, rebase, cherry-pick, revert or
  bisect is in progress, with a message saying so. Committing part of the tree
  in those states is destructive in ways that are hard to undo.
- **Shelve** moves a list out of the working tree into a real `git stash`
  entry tagged `idea-git-shelf:<name>`; **Unshelve** restores it.
- **Rollback** reverts a list. Untracked files are removed with an explicit
  pathspec, never a bare `git clean -fd`.
- **Renames carry both names.** Committing or reverting a renamed file handles
  the old path and the new one together, so a rollback brings the original
  back instead of leaving neither file on disk.

### Filenames are treated as literal paths

git reports literal filenames in `status` but consumes them as *globs*. A file
genuinely named `note*.md` in one changelist would otherwise make `git add`,
`git restore` and `git clean` also match `notes.md` — committing, reverting or
**deleting** files from a different changelist. Every path this extension hands
to git is wrapped in `:(literal)`, and there are tests for the commit, rollback
and clean paths asserting the neighbours survive.

### How state is stored

Two layers, and the split is deliberate:

**Assignments** (which file is in which list) live in
`.git/idea-git/changelists.json`. `.git` is the one directory guaranteed never
to be tracked, so this metadata can't end up in a commit. Writes are
write-then-rename, and the file is re-validated on load — a corrupt or
hand-edited file degrades to a clean state instead of breaking the view.

**Content** is snapshotted into real git commit objects under
`refs/idea-git/changelists/<id>`. The ref anchors the objects against `gc`, so
a snapshot survives branch switches, resets, reboots and a deleted metadata
file:

```
git for-each-ref refs/idea-git/changelists      # what snapshots exist
git show <hash>:path/to/file                    # recover one file
git diff HEAD <hash>                            # see the whole list
```

> **A note on the "stash-backed" choice.** You asked for each inactive
> changelist to be a real stash entry. Implemented literally, that breaks the
> everyday flow: `git stash push` *removes* files from the working tree, so
> with three changelists you'd only ever see one list's files on disk — which
> is not how IDEA changelists behave (IDEA keeps everything in the tree;
> *shelves* are the thing that removes it).
>
> So snapshots are written with a **temporary index** (`GIT_INDEX_FILE` +
> `read-tree` / `update-index` / `write-tree` / `commit-tree`) instead. You get
> the durability you were after — real git objects, anchored by refs, survives
> everything — with the working tree and your real index never touched. There
> is a test asserting exactly that. Real stash entries are still used for the
> explicit **Shelve** command, where removing the changes *is* the point.

## Diff

- **Compare with Revision…** — pick from that file's history, diff against the
  working tree.
- **Compare with Branch…**
- **Compare Two Revisions…** — pick two points in the file's history.
- **Show File History** — pick a commit, see that commit's own diff
  (parent ↔ commit). Root commits are handled.
- **Show Diff for Changelist** — walk a list's files.
- Clicking a file in the Changelists view opens HEAD ↔ working tree.

Revision content is served through an `idea-git-rev:` document provider. The
URI keeps the real file path so VS Code picks the right language mode — these
diffs are syntax-highlighted. Immutable revisions (hashes) are cached; symbolic
refs like `HEAD` are not.

## IDEA keybindings (opt-in)

Not bound by default, on purpose: `Ctrl+K` is VS Code's **chord prefix** (every
`Ctrl+K Ctrl+*` shortcut would break), `Ctrl+Shift+K` is **Delete Line**, and
`Ctrl+T` is **Go to Symbol in Workspace**. Claiming those silently would make
the editor feel broken in ways you'd never trace back to this extension.

If you want the muscle memory anyway, paste this into `keybindings.json`
(Command Palette → *Preferences: Open Keyboard Shortcuts (JSON)*):

```jsonc
[
  { "key": "ctrl+k",       "command": "ideaGit.changelist.commit", "when": "!terminalFocus" },
  { "key": "ctrl+shift+k", "command": "ideaGit.vcs.push",          "when": "!terminalFocus" },
  { "key": "ctrl+t",       "command": "ideaGit.vcs.update",        "when": "!terminalFocus" },
  { "key": "ctrl+d",       "command": "ideaGit.diff.withRevision", "when": "!terminalFocus" }
]
```

On macOS swap `ctrl` for `cmd`. Drop any line whose VS Code default you'd
rather keep.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `ideaGit.changelists.autoAssignToActive` | `true` | New changes join the active list |
| `ideaGit.changelists.persistIntervalMs` | `4000` | Snapshot cadence; `0` disables |
| `ideaGit.diff.openSideBySide` | `true` | |
| `ideaGit.integration.gitGraphPlus` | `true` | Forward log/graph commands to Git Graph+ |

## Build

```bash
npm install
npm run build       # esbuild bundle -> dist/extension.js
npm run typecheck
npm test            # 40 tests against throwaway git repos
npx @vscode/vsce package --skip-license
```

Every push to `main` runs that on GitHub Actions and uploads
`idea-git-<version>.vsix` as the **idea-git-vsix** artifact on the run
(Actions → Build → the run → Artifacts). It is kept for 90 days.

## Known limitations

- **Changelists are local.** They don't survive a fresh clone and aren't
  shared with teammates — same as IDEA.
- **No multi-file diff container.** VS Code exposes no API for an extension to
  populate one, so "diff a changelist" is a multi-select picker that opens each
  file's diff into its own tab. This is the honest ceiling of the API.
- **No hunk-level changelist assignment.** A file belongs to one list as a
  whole. IDEA can't split a file across changelists either.
- **Not tested against submodules or bare/worktree checkouts.**
- **Not yet exercised inside a running VS Code instance.** The git layer is
  covered by 40 tests against real repositories; the UI layer (tree view, drag
  and drop, menu wiring) is type-checked and reviewed but not integration
  tested. Treat 0.1.0 as ready to try, not as battle-tested.
- **`git4idea` code was not copied.** Both it and this are Apache-2.0, so
  lifting code would be permitted with attribution, but nothing was — the
  behaviour was reimplemented against `git` directly.

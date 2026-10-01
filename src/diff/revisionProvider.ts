import * as vscode from 'vscode';
import { GitRunner } from '../git/cli';
import { Porcelain } from '../git/porcelain';

export const REVISION_SCHEME = 'idea-git-rev';

interface RevisionQuery {
  repoRoot: string;
  ref: string;
  path: string;
}

/**
 * Serves file contents at an arbitrary revision as a read-only document, so
 * the standard diff editor can be pointed at any two points in history.
 *
 * The URI carries the repo root and ref in the query rather than the path so
 * that the URI's own path stays the real file path -- VS Code picks the
 * language mode from it, which is what makes these diffs syntax-highlighted.
 */
export class RevisionContentProvider
  implements vscode.TextDocumentContentProvider, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;

  // Bounded so that browsing a long history cannot grow the cache without
  // limit; oldest entry is evicted first.
  private static readonly MAX_CACHED = 200;
  private readonly cache = new Map<string, string>();

  constructor(private readonly gitPath: string) {}

  dispose(): void {
    this._onDidChange.dispose();
    this.cache.clear();
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const key = uri.toString();
    const cached = this.cache.get(key);
    // Immutable revisions (anything that is not a symbolic HEAD-ish name) can
    // be cached forever; a commit's content never changes.
    if (cached !== undefined) return cached;

    const query = decodeRevisionUri(uri);
    const porcelain = new Porcelain(new GitRunner(query.repoRoot, this.gitPath));
    const content = (await porcelain.showFile(query.ref, query.path)) ?? '';

    if (isImmutableRef(query.ref)) {
      if (this.cache.size >= RevisionContentProvider.MAX_CACHED) {
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      this.cache.set(key, content);
    }
    return content;
  }
}

export function encodeRevisionUri(
  repoRoot: string,
  ref: string,
  relPath: string,
): vscode.Uri {
  return vscode.Uri.from({
    scheme: REVISION_SCHEME,
    path: `/${relPath}`,
    query: JSON.stringify({ repoRoot, ref, path: relPath } satisfies RevisionQuery),
  });
}

export function decodeRevisionUri(uri: vscode.Uri): RevisionQuery {
  return JSON.parse(uri.query) as RevisionQuery;
}

function isImmutableRef(ref: string): boolean {
  // Only a FULL hash is safe to cache forever. An abbreviated one could also
  // be a branch name (a branch called "deadbeef" is legal), and caching that
  // would freeze the diff at whatever the branch pointed to first.
  return /^[0-9a-f]{40}$/.test(ref);
}

/** Short, human-readable label for a revision, used in diff editor titles. */
export function refLabel(ref: string): string {
  if (/^[0-9a-f]{40}$/.test(ref)) return ref.slice(0, 8);
  return ref;
}

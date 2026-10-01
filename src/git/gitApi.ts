import * as vscode from 'vscode';
import { GitRunner } from './cli';

/**
 * Minimal shape of the built-in `vscode.git` extension API.
 *
 * Only the members actually used are declared: depending on the full d.ts
 * would tie this extension to one VS Code version, and the API is versioned
 * through getAPI(1) anyway.
 */
export interface BuiltInRepository {
  readonly rootUri: vscode.Uri;
  readonly state: {
    readonly HEAD?: { name?: string; commit?: string; upstream?: unknown };
    readonly onDidChange: vscode.Event<void>;
  };
  add(paths: string[]): Promise<void>;
  commit(message: string, opts?: { all?: boolean; amend?: boolean }): Promise<void>;
  push(): Promise<void>;
  pull(): Promise<void>;
}

export interface BuiltInGitApi {
  readonly repositories: BuiltInRepository[];
  readonly onDidOpenRepository: vscode.Event<BuiltInRepository>;
  readonly onDidCloseRepository: vscode.Event<BuiltInRepository>;
  readonly git: { readonly path: string };
  getRepository(uri: vscode.Uri): BuiltInRepository | null;
}

interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): BuiltInGitApi;
}

/**
 * Wait for the built-in git extension and hand back its API.
 *
 * The extension can be present but disabled (git.enabled = false), and it
 * activates lazily, so both cases are handled rather than assumed.
 */
export async function getBuiltInGitApi(): Promise<BuiltInGitApi | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;

  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports.enabled) {
    return new Promise((resolve) => {
      const sub = exports.onDidChangeEnablement((enabled) => {
        if (enabled) {
          sub.dispose();
          resolve(exports.getAPI(1));
        }
      });
    });
  }
  return exports.getAPI(1);
}

/** A repository plus the raw-git runner used for everything the API lacks. */
export interface RepoContext {
  readonly root: vscode.Uri;
  readonly repository: BuiltInRepository;
  readonly git: GitRunner;
}

export function makeRepoContext(
  api: BuiltInGitApi,
  repository: BuiltInRepository,
): RepoContext {
  return {
    root: repository.rootUri,
    repository,
    // Reuse the git binary VS Code already located, so a user with git in a
    // non-standard location does not have to configure it twice.
    git: new GitRunner(repository.rootUri.fsPath, api.git.path || 'git'),
  };
}

/** Pick the repository for the active editor, or ask when several are open. */
export async function pickRepository(
  api: BuiltInGitApi,
  hint?: vscode.Uri,
): Promise<BuiltInRepository | undefined> {
  if (api.repositories.length === 0) return undefined;
  if (api.repositories.length === 1) return api.repositories[0];

  const uri = hint ?? vscode.window.activeTextEditor?.document.uri;
  if (uri) {
    const found = api.getRepository(uri);
    if (found) return found;
  }

  const picked = await vscode.window.showQuickPick(
    api.repositories.map((r) => ({
      label: r.rootUri.path.split('/').pop() ?? r.rootUri.fsPath,
      description: r.rootUri.fsPath,
      repository: r,
    })),
    { title: 'Select repository' },
  );
  return picked?.repository;
}

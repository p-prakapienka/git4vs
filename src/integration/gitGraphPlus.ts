import * as vscode from 'vscode';

const GIT_GRAPH_PLUS = 'the0807.git-graph-plus';
const GIT_GRAPH_LEGACY = 'mhutchie.git-graph';

/**
 * Delegation to a graph extension.
 *
 * This extension deliberately does not draw its own commit graph: Git Graph+
 * already does that well and is actively maintained. Where IDEA would open the
 * Log tool window, the command is forwarded there instead, falling back to the
 * older Git Graph and finally to the graph view VS Code now ships.
 *
 * Commands are invoked by id and every call is guarded, because a third-party
 * extension can rename or drop a command in any release and that must degrade
 * to a fallback rather than an error toast.
 */
export class GraphIntegration {
  private get enabled(): boolean {
    return vscode.workspace
      .getConfiguration('ideaGit')
      .get<boolean>('integration.gitGraphPlus', true);
  }

  get installedGraphExtension(): string | undefined {
    if (vscode.extensions.getExtension(GIT_GRAPH_PLUS)) return GIT_GRAPH_PLUS;
    if (vscode.extensions.getExtension(GIT_GRAPH_LEGACY)) return GIT_GRAPH_LEGACY;
    return undefined;
  }

  async openGraph(): Promise<void> {
    if (this.enabled) {
      const which = this.installedGraphExtension;
      if (which === GIT_GRAPH_PLUS && (await tryCommand('gitGraphPlus.open'))) return;
      if (which === GIT_GRAPH_LEGACY && (await tryCommand('git-graph.view'))) return;
    }

    // Built-in fallback: VS Code's own Source Control Graph view.
    if (await tryCommand('workbench.view.scm')) {
      if (await tryCommand('scm.showHistoryGraph')) return;
      return;
    }

    const install = 'Install Git Graph+';
    const choice = await vscode.window.showInformationMessage(
      'No Git graph view is available. Git Graph+ gives you the IntelliJ-style log with right-click rebase, reset and cherry-pick.',
      install,
    );
    if (choice === install) {
      await vscode.commands.executeCommand(
        'workbench.extensions.search',
        GIT_GRAPH_PLUS,
      );
    }
  }
}

async function tryCommand(id: string, ...args: unknown[]): Promise<boolean> {
  const available = await vscode.commands.getCommands(true);
  if (!available.includes(id)) return false;
  try {
    await vscode.commands.executeCommand(id, ...args);
    return true;
  } catch {
    return false;
  }
}

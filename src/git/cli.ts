import { spawn } from 'child_process';

export interface GitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly result: GitResult,
  ) {
    super(message);
    this.name = 'GitError';
  }
}

export interface GitRunnerOptions {
  cwd: string;
  /** Extra environment for a single call, e.g. GIT_INDEX_FILE for plumbing work. */
  env?: NodeJS.ProcessEnv;
  /** Data to write to stdin. */
  stdin?: string;
  /** Treat these exit codes as success (git diff --quiet returns 1 for "differs"). */
  okExitCodes?: number[];
  timeoutMs?: number;
}

/**
 * Thin wrapper around the git binary.
 *
 * Everything goes through argv arrays -- never a shell string -- so branch and
 * file names containing spaces, quotes or semicolons cannot be misparsed.
 */
export class GitRunner {
  constructor(
    private readonly repoRoot: string,
    private readonly gitPath: string = 'git',
  ) {}

  get root(): string {
    return this.repoRoot;
  }

  async run(args: string[], opts: Partial<GitRunnerOptions> = {}): Promise<GitResult> {
    const ok = opts.okExitCodes ?? [0];
    const result = await this.exec(args, opts);
    if (!ok.includes(result.exitCode)) {
      throw new GitError(
        `git ${args.join(' ')} failed (${result.exitCode}): ${result.stderr.trim() || result.stdout.trim()}`,
        args,
        result,
      );
    }
    return result;
  }

  /** Run and return trimmed stdout. */
  async text(args: string[], opts: Partial<GitRunnerOptions> = {}): Promise<string> {
    return (await this.run(args, opts)).stdout.trim();
  }

  /** Run and split stdout on NUL, dropping the trailing empty element. */
  async nulLines(args: string[], opts: Partial<GitRunnerOptions> = {}): Promise<string[]> {
    const out = (await this.run(args, opts)).stdout;
    return out.split('\0').filter((s) => s.length > 0);
  }

  private exec(args: string[], opts: Partial<GitRunnerOptions>): Promise<GitResult> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.gitPath, args, {
        cwd: opts.cwd ?? this.repoRoot,
        env: {
          ...process.env,
          ...opts.env,
          // Keep output stable and non-interactive regardless of user config.
          GIT_OPTIONAL_LOCKS: '0',
          GIT_TERMINAL_PROMPT: '0',
          GIT_PAGER: 'cat',
          LC_ALL: 'C',
        },
      });

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let settled = false;

      const timer = opts.timeoutMs
        ? setTimeout(() => {
            if (!settled) {
              child.kill('SIGTERM');
            }
          }, opts.timeoutMs)
        : undefined;

      child.stdout.on('data', (d: Buffer) => stdout.push(d));
      child.stderr.on('data', (d: Buffer) => stderr.push(d));

      child.on('error', (err) => {
        settled = true;
        if (timer) clearTimeout(timer);
        reject(err);
      });

      child.on('close', (code) => {
        settled = true;
        if (timer) clearTimeout(timer);
        resolve({
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          exitCode: code ?? 1,
        });
      });

      if (opts.stdin !== undefined) {
        child.stdin.end(opts.stdin);
      } else {
        child.stdin.end();
      }
    });
  }
}

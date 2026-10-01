import { GitRunner } from './cli';

export type WorkingTreeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'untracked'
  | 'conflicted'
  | 'typechange';

export interface WorkingTreeEntry {
  /** Repo-relative path, forward slashes, as git reports it. */
  path: string;
  /** Original path for renames. */
  origPath?: string;
  status: WorkingTreeStatus;
  staged: boolean;
  unstaged: boolean;
}

export interface CommitInfo {
  hash: string;
  shortHash: string;
  authorName: string;
  authorEmail: string;
  authorDate: Date;
  subject: string;
  body: string;
  parents: string[];
  refs: string[];
}

// ASCII record/unit separators: safe because git refuses them in ref names and
// they cannot appear in a commit subject line.
const RECORD_SEP = '\x1e';
const FIELD_SEP = '\x1f';

/** Porcelain-level git queries used by the changelist and diff features. */
export class Porcelain {
  constructor(private readonly git: GitRunner) {}

  async repoRoot(): Promise<string> {
    return this.git.text(['rev-parse', '--show-toplevel']);
  }

  async currentBranch(): Promise<string | undefined> {
    const name = await this.git.text(['rev-parse', '--abbrev-ref', 'HEAD']);
    return name === 'HEAD' ? undefined : name;
  }

  async hasHead(): Promise<boolean> {
    const res = await this.git.run(['rev-parse', '--verify', '--quiet', 'HEAD'], {
      okExitCodes: [0, 1],
    });
    return res.exitCode === 0;
  }

  /**
   * Parse `git status --porcelain=v2 -z`.
   *
   * v2 rather than v1: it reports a rename's original path as its own
   * NUL-terminated field instead of an ambiguous " -> " string, which v1 cannot
   * escape safely for paths that themselves contain an arrow.
   */
  async status(): Promise<WorkingTreeEntry[]> {
    const fields = await this.git.nulLines([
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=all',
    ]);

    const entries: WorkingTreeEntry[] = [];
    for (let i = 0; i < fields.length; i++) {
      const line = fields[i];
      const kind = line[0];

      if (kind === '1') {
        // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
        const parts = splitN(line, ' ', 8);
        const xy = parts[1];
        entries.push({
          path: parts[8],
          status: statusFromXY(xy),
          staged: xy[0] !== '.',
          unstaged: xy[1] !== '.',
        });
      } else if (kind === '2') {
        // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\0<origPath>
        const parts = splitN(line, ' ', 9);
        const xy = parts[1];
        const origPath = fields[++i];
        entries.push({
          path: parts[9],
          origPath,
          status: 'renamed',
          staged: xy[0] !== '.',
          unstaged: xy[1] !== '.',
        });
      } else if (kind === 'u') {
        // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
        const parts = splitN(line, ' ', 10);
        entries.push({
          path: parts[10],
          status: 'conflicted',
          staged: false,
          unstaged: true,
        });
      } else if (kind === '?') {
        entries.push({
          path: line.slice(2),
          status: 'untracked',
          staged: false,
          unstaged: true,
        });
      }
      // '!' (ignored) is never requested; '#' header lines carry no entry.
    }
    return entries;
  }

  async log(
    options: { maxCount?: number; ref?: string; path?: string } = {},
  ): Promise<CommitInfo[]> {
    const format =
      ['%H', '%h', '%an', '%ae', '%aI', '%P', '%D', '%s', '%b'].join(FIELD_SEP) + RECORD_SEP;

    const args = ['log', `--format=${format}`];
    if (options.maxCount) args.push(`--max-count=${options.maxCount}`);
    args.push(options.ref ?? 'HEAD');
    if (options.path) args.push('--', `:(literal)${options.path}`);

    const out = (await this.git.run(args)).stdout;
    return out
      .split(RECORD_SEP)
      .map((r) => r.replace(/^\n/, ''))
      .filter((r) => r.trim().length > 0)
      .map(parseCommitRecord);
  }

  /** File contents at a revision; undefined when the path did not exist there. */
  async showFile(ref: string, path: string): Promise<string | undefined> {
    const res = await this.git.run(['show', `${ref}:${path}`], { okExitCodes: [0, 128] });
    return res.exitCode === 0 ? res.stdout : undefined;
  }

  async revParse(rev: string): Promise<string | undefined> {
    const res = await this.git.run(['rev-parse', '--verify', '--quiet', rev], {
      okExitCodes: [0, 1],
    });
    return res.exitCode === 0 ? res.stdout.trim() : undefined;
  }

  async listBranches(): Promise<string[]> {
    const out = await this.git.text([
      'for-each-ref',
      '--format=%(refname:short)',
      'refs/heads',
      'refs/remotes',
    ]);
    return out.split('\n').filter(Boolean);
  }

  /** Paths changed between two tree-ish refs. */
  async changedPaths(fromRef: string, toRef: string): Promise<string[]> {
    return this.git.nulLines(['diff', '--name-only', '-z', fromRef, toRef]);
  }
}

export function parseCommitRecord(record: string): CommitInfo {
  const f = record.split(FIELD_SEP);
  return {
    hash: f[0],
    shortHash: f[1],
    authorName: f[2],
    authorEmail: f[3],
    authorDate: new Date(f[4]),
    parents: f[5] ? f[5].split(' ').filter(Boolean) : [],
    refs: f[6] ? f[6].split(', ').filter(Boolean) : [],
    subject: f[7] ?? '',
    body: f[8] ?? '',
  };
}

/**
 * Split on `sep` at most `n` times, returning n+1 elements; the last element
 * keeps any remaining separators. Needed because paths may contain spaces.
 */
export function splitN(s: string, sep: string, n: number): string[] {
  const out: string[] = [];
  let rest = s;
  for (let i = 0; i < n; i++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) {
      out.push(rest);
      return out;
    }
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

export function statusFromXY(xy: string): WorkingTreeStatus {
  const codes = xy.replace(/\./g, '');
  if (codes.includes('U')) return 'conflicted';
  if (codes.includes('A')) return 'added';
  if (codes.includes('D')) return 'deleted';
  if (codes.includes('R')) return 'renamed';
  if (codes.includes('T')) return 'typechange';
  return 'modified';
}

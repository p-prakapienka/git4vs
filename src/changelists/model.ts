export const DEFAULT_CHANGELIST_ID = 'default';

export interface Changelist {
  id: string;
  name: string;
  /** Free-text note carried into the commit message template. */
  comment?: string;
  /** Repo-relative paths assigned to this list. */
  paths: string[];
  /**
   * Hash of the snapshot commit object under refs/git4vs/changelists/<id>,
   * if one has been written. Purely a recovery aid.
   */
  snapshot?: string;
}

export interface ChangelistState {
  version: 1;
  activeId: string;
  lists: Changelist[];
}

export function emptyState(): ChangelistState {
  return {
    version: 1,
    activeId: DEFAULT_CHANGELIST_ID,
    lists: [{ id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [] }],
  };
}

/**
 * Normalise arbitrary parsed JSON into a valid state.
 *
 * The file lives in .git and can be hand-edited or written by an older build,
 * so every invariant is re-established rather than trusted: the default list
 * always exists, no path belongs to two lists, and activeId always resolves.
 */
export function normalizeState(raw: unknown): ChangelistState {
  const state = emptyState();
  if (!raw || typeof raw !== 'object') return state;

  const obj = raw as Partial<ChangelistState>;
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  const lists: Changelist[] = [];

  for (const candidate of Array.isArray(obj.lists) ? obj.lists : []) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as Partial<Changelist>;
    if (typeof c.id !== 'string' || c.id.length === 0) continue;
    if (seenIds.has(c.id)) continue;
    seenIds.add(c.id);

    const paths: string[] = [];
    for (const p of Array.isArray(c.paths) ? c.paths : []) {
      if (typeof p !== 'string' || p.length === 0) continue;
      // First list to claim a path wins; a path is never in two lists.
      if (seenPaths.has(p)) continue;
      seenPaths.add(p);
      paths.push(p);
    }

    lists.push({
      id: c.id,
      name: typeof c.name === 'string' && c.name.length > 0 ? c.name : c.id,
      comment: typeof c.comment === 'string' ? c.comment : undefined,
      snapshot: typeof c.snapshot === 'string' ? c.snapshot : undefined,
      paths,
    });
  }

  if (!lists.some((l) => l.id === DEFAULT_CHANGELIST_ID)) {
    lists.unshift({ id: DEFAULT_CHANGELIST_ID, name: 'Changes', paths: [] });
  }

  state.lists = lists;
  state.activeId =
    typeof obj.activeId === 'string' && lists.some((l) => l.id === obj.activeId)
      ? obj.activeId
      : DEFAULT_CHANGELIST_ID;
  return state;
}

/** Reconcile assignments against what git actually reports as changed. */
export function reconcile(
  state: ChangelistState,
  changedPaths: readonly string[],
  autoAssignToActive: boolean,
): ChangelistState {
  const changed = new Set(changedPaths);
  const assigned = new Set<string>();

  const lists = state.lists.map((list) => {
    const paths = list.paths.filter((p) => {
      if (!changed.has(p)) return false; // no longer modified -> drop
      if (assigned.has(p)) return false; // defensive: never double-assign
      assigned.add(p);
      return true;
    });
    return { ...list, paths };
  });

  if (autoAssignToActive) {
    const active = lists.find((l) => l.id === state.activeId) ?? lists[0];
    for (const p of changedPaths) {
      if (!assigned.has(p)) {
        active.paths.push(p);
        assigned.add(p);
      }
    }
  }

  for (const list of lists) {
    list.paths.sort();
  }

  return { ...state, lists };
}

export function movePaths(
  state: ChangelistState,
  paths: readonly string[],
  targetId: string,
): ChangelistState {
  const moving = new Set(paths);
  const lists = state.lists.map((l) => ({
    ...l,
    paths: l.paths.filter((p) => !moving.has(p)),
  }));
  const target = lists.find((l) => l.id === targetId);
  if (!target) return state;
  target.paths = [...new Set([...target.paths, ...paths])].sort();
  return { ...state, lists };
}

/**
 * Slug used for the ref name under refs/git4vs/changelists/.
 *
 * git-check-ref-format rejects a component that is empty, starts with a dot,
 * ends with a dot or ".lock", or contains "..", so all of those are ruled out
 * here rather than discovered as a failed update-ref later.
 */
export function refSlug(id: string): string {
  const slug = id
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/\.{2,}/g, '.')
    .replace(/^[-.]+/, '')
    .replace(/[-.]+$/, '')
    .replace(/\.lock$/i, '-lock');
  return slug.length > 0 ? slug : 'unnamed';
}

export function newChangelistId(name: string, existing: readonly string[]): string {
  const base = refSlug(name.toLowerCase().replace(/\s+/g, '-')) || 'changelist';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

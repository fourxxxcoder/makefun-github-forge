// Domain operations shared by the REST, GraphQL and MCP surfaces: repository, issue,
// pull-request, comment, label and file-content operations over the store and the git
// object model. Each operation returns a result or a {status, message} failure shaped
// like GitHub's own errors, so every surface reports the same failure the same way.

import {
  commitTree,
  flattenTree,
  formatCommit,
  getObject,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTree,
  putObject,
  resolveRef,
  setTreePath,
  treeFromFlat,
  type FlatEntry,
} from './git.ts';
import {
  store,
  VIEWER,
  encodeGlobalId,
  type CommentRec,
  type IssueRec,
  type ItemRec,
  type LabelRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface OpFailure {
  ok: false;
  status: number;
  message: string;
}

export function fail(status: number, message: string): OpFailure {
  return { ok: false, status, message };
}

// ---------------------------------------------------------------- JSON shapes

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: encodeGlobalId('User', VIEWER.id),
    name: VIEWER.name,
    email: VIEWER.email,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: RepoRec): Record<string, unknown> {
  let openIssues = 0;
  for (const item of repo.items.values()) if (item.state === 'open') openIssues += 1;
  return {
    id: repo.id,
    node_id: encodeGlobalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER.id, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    default_branch: repo.defaultBranch,
    created_at: store.isoOf(repo.seq),
    updated_at: store.isoOf(repo.seq),
    pushed_at: store.isoOf(repo.seq),
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    forks_count: 0,
    open_issues_count: openIssues,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
  };
}

function labelId(name: string): number {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) | 0;
  return Math.abs(hash) % 1_000_000;
}

export function labelJson(label: LabelRec): Record<string, unknown> {
  return {
    id: labelId(label.name),
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: encodeGlobalId('Issue', `${repo.id}:${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    comments: (repo.comments.get(issue.number) ?? []).length,
    created_at: store.isoOf(issue.seq),
    updated_at: store.isoOf(issue.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  return {
    id: pull.id,
    node_id: encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedSeq === null ? null : store.isoOf(pull.mergedSeq),
    merge_commit_sha: pull.mergeCommitSha,
    draft: false,
    labels: pull.labels.map((name) => labelJson(repo.labels.get(name) ?? { name, color: 'ededed', description: '' })),
    user: { login: VIEWER.login, id: VIEWER.id },
    head: {
      ref: pull.headRef,
      sha: headTip,
      label: `${repo.owner}:${pull.headRef}`,
    },
    base: {
      ref: pull.baseRef,
      sha: baseTip,
      label: `${repo.owner}:${pull.baseRef}`,
    },
    created_at: store.isoOf(pull.seq),
    updated_at: store.isoOf(pull.seq),
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}

export function itemJson(repo: RepoRec, item: ItemRec): Record<string, unknown> {
  return item.kind === 'issue' ? issueJson(repo, item) : pullJson(repo, item);
}

export function commentJson(comment: CommentRec): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.authorLogin, id: VIEWER.id },
    created_at: store.isoOf(comment.seq),
    updated_at: store.isoOf(comment.seq),
  };
}

// ---------------------------------------------------------------- labels

export function upsertLabel(repo: RepoRec, name: string, color?: string, description?: string): LabelRec {
  const existing = repo.labels.get(name);
  if (existing !== undefined) {
    if (color !== undefined) existing.color = color;
    if (description !== undefined) existing.description = description;
    return existing;
  }
  const label: LabelRec = { name, color: color ?? 'ededed', description: description ?? '' };
  repo.labels.set(name, label);
  return label;
}

// ---------------------------------------------------------------- issues

export function createIssue(
  repo: RepoRec,
  input: { title: string; body?: string; labels?: readonly string[] },
): { ok: true; issue: IssueRec } | OpFailure {
  const labels = [...(input.labels ?? [])];
  for (const name of labels) {
    if (!repo.labels.has(name)) return fail(422, `Label "${name}" does not exist in ${repo.owner}/${repo.name}`);
  }
  const issue: IssueRec = {
    kind: 'issue',
    id: store.nextItemId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    labels,
    seq: store.tick(),
  };
  repo.nextNumber += 1;
  repo.items.set(issue.number, issue);
  return { ok: true, issue };
}

export function addComment(repo: RepoRec, item: ItemRec, body: string): CommentRec {
  const comment: CommentRec = { id: store.nextCommentId(), body, authorLogin: VIEWER.login, seq: store.tick() };
  const list = repo.comments.get(item.number) ?? [];
  list.push(comment);
  repo.comments.set(item.number, list);
  return comment;
}

// ---------------------------------------------------------------- pulls

/** A branch argument may arrive as "branch" or "owner:branch"; keep the branch part. */
export function branchNameOf(ref: string): string {
  const colon = ref.indexOf(':');
  return colon < 0 ? ref : ref.slice(colon + 1);
}

export function createPull(
  repo: RepoRec,
  input: { title: string; body?: string; head: string; base: string },
): { ok: true; pull: PullRec } | OpFailure {
  const headRef = branchNameOf(input.head);
  const baseRef = branchNameOf(input.base);
  const headSha = repo.refs.get(`refs/heads/${headRef}`);
  if (headSha === undefined) return fail(422, `Head branch "${headRef}" does not exist`);
  const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
  if (baseSha === undefined) return fail(422, `Base branch "${baseRef}" does not exist`);
  const pull: PullRec = {
    kind: 'pull',
    id: store.nextItemId(),
    number: repo.nextNumber,
    title: input.title,
    body: input.body ?? '',
    state: 'open',
    merged: false,
    mergeCommitSha: null,
    mergedSeq: null,
    headRef,
    headSha,
    baseRef,
    baseSha,
    labels: [],
    seq: store.tick(),
  };
  repo.nextNumber += 1;
  repo.items.set(pull.number, pull);
  return { ok: true, pull };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

/** Line-change counts between two blob bodies (multiset difference of lines). */
export function lineCounts(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
  const lines = (data: Buffer | null): string[] => {
    if (data === null) return [];
    const text = data.toString('utf8');
    if (text === '') return [];
    const parts = text.split('\n');
    if (parts[parts.length - 1] === '') parts.pop();
    return parts;
  };
  const tally = (list: string[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of list) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldTally = tally(lines(oldData));
  const newTally = tally(lines(newData));
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newTally) additions += Math.max(0, count - (oldTally.get(line) ?? 0));
  for (const [line, count] of oldTally) deletions += Math.max(0, count - (newTally.get(line) ?? 0));
  return { additions, deletions };
}

/** The file diff of a pull request: merge-base tree against the head tip tree. */
export function pullFiles(repo: RepoRec, pull: PullRec): FileDiff[] {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseCommit = resolveRef(repo, baseTip) ?? baseTip;
  const headCommit = resolveRef(repo, headTip) ?? headTip;
  const base = mergeBase(repo, baseCommit, headCommit) ?? baseCommit;
  const baseTree = commitTree(repo, base);
  const headTree = commitTree(repo, headCommit);
  const from = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  const to = headTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, headTree);
  const diffs: FileDiff[] = [];
  const paths = new Set<string>([...from.keys(), ...to.keys()]);
  for (const path of [...paths].sort()) {
    const before = from.get(path);
    const after = to.get(path);
    if (before !== undefined && after !== undefined && before.oid === after.oid) continue;
    const oldData = before === undefined ? null : getObject(repo, before.oid)?.data ?? null;
    const newData = after === undefined ? null : getObject(repo, after.oid)?.data ?? null;
    const { additions, deletions } = lineCounts(oldData, newData);
    diffs.push({
      filename: path,
      status: before === undefined ? 'added' : after === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return diffs;
}

/** True when merging `pull` today would conflict (both sides changed a path apart). */
export function pullConflicts(repo: RepoRec, pull: PullRec): boolean {
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return true;
  const baseCommit = resolveRef(repo, baseTip) ?? baseTip;
  const headCommit = resolveRef(repo, headTip) ?? headTip;
  const base = mergeBase(repo, baseCommit, headCommit);
  if (base === null) return true;
  if (base === baseCommit || base === headCommit) return false;
  const flatBase0 = flattenTree(repo, commitTree(repo, base) ?? '');
  const flatBase = flattenTree(repo, commitTree(repo, baseCommit) ?? '');
  const flatHead = flattenTree(repo, commitTree(repo, headCommit) ?? '');
  const paths = new Set<string>([...flatBase0.keys(), ...flatBase.keys(), ...flatHead.keys()]);
  for (const path of paths) {
    const m = flatBase0.get(path)?.oid;
    const b = flatBase.get(path)?.oid;
    const h = flatHead.get(path)?.oid;
    if (b === h || m === b || m === h) continue;
    return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch: one new commit whose tree resolves
 * every path the way a three-way merge would, whose only parent is the base tip.
 */
export function mergePull(repo: RepoRec, pull: PullRec): { ok: true; sha: string } | OpFailure {
  if (pull.merged) return fail(405, 'Pull Request is not mergeable');
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return fail(404, 'Not Found');
  const baseCommit = resolveRef(repo, baseTip) ?? baseTip;
  const headCommit = resolveRef(repo, headTip) ?? headTip;
  if (isAncestor(repo, headCommit, baseCommit)) return fail(405, 'Pull Request is not mergeable');
  const base = mergeBase(repo, baseCommit, headCommit);
  if (base === null) return fail(405, 'Pull Request is not mergeable');
  const flatBase0 = flattenTree(repo, commitTree(repo, base) ?? '');
  const flatBase = flattenTree(repo, commitTree(repo, baseCommit) ?? '');
  const flatHead = flattenTree(repo, commitTree(repo, headCommit) ?? '');
  const merged = new Map<string, FlatEntry>(flatBase);
  const paths = new Set<string>([...flatBase0.keys(), ...flatBase.keys(), ...flatHead.keys()]);
  for (const path of paths) {
    const m = flatBase0.get(path);
    const b = flatBase.get(path);
    const h = flatHead.get(path);
    const same = (x?: FlatEntry, y?: FlatEntry): boolean => x?.oid === y?.oid && x?.mode === y?.mode;
    if (same(b, h) || same(m, h)) continue;
    if (same(m, b)) {
      if (h === undefined) merged.delete(path);
      else merged.set(path, h);
      continue;
    }
    return fail(405, 'Pull Request is not mergeable');
  }
  const tree = treeFromFlat(repo, merged);
  const message = pull.body === '' ? pull.title : `${pull.title}\n\n${pull.body}`;
  const commit = formatCommit({
    tree,
    parents: [baseCommit],
    message,
    name: VIEWER.name,
    email: VIEWER.email,
    whenSec: store.nowSec(),
  });
  const sha = putObject(repo, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = sha;
  pull.mergedSeq = store.tick();
  return { ok: true, sha };
}

// ---------------------------------------------------------------- contents

export interface PutContentResult {
  blobOid: string;
  commitOid: string;
  created: boolean;
}

/**
 * Create or update (content != null) or delete (content == null) one file on a branch,
 * committing through the same object store git pushes write to. A branch that does not
 * exist yet starts from the default branch's tip (or from nothing on an unborn repo).
 */
export function putContent(
  repo: RepoRec,
  input: { path: string; content: Buffer | null; message: string; branch?: string; sha?: string },
): { ok: true; result: PutContentResult } | OpFailure {
  const branch = input.branch ?? repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tipOid = repo.refs.get(refName);
  let parent: string | null = null;
  let baseTree: string | null = null;
  if (tipOid !== undefined) {
    parent = resolveRef(repo, tipOid);
    baseTree = parent === null ? null : commitTree(repo, parent);
  } else if (branch !== repo.defaultBranch) {
    const fallback = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    if (fallback !== undefined) {
      parent = resolveRef(repo, fallback);
      baseTree = parent === null ? null : commitTree(repo, parent);
    }
  }
  const flat = baseTree === null ? new Map<string, FlatEntry>() : flattenTree(repo, baseTree);
  const existing = flat.get(input.path);
  if (input.content === null) {
    if (existing === undefined) return fail(404, 'Not Found');
    if (input.sha !== undefined && input.sha !== existing.oid) return fail(409, 'SHA does not match');
  } else {
    if (existing !== undefined) {
      if (input.sha === undefined) return fail(422, 'SHA is required when updating a file');
      if (input.sha !== existing.oid) return fail(409, 'SHA does not match');
    }
  }
  let blobOid = '';
  let entry: FlatEntry | null = null;
  if (input.content !== null) {
    blobOid = putObject(repo, 'blob', input.content);
    entry = { mode: existing?.mode ?? '100644', oid: blobOid };
  }
  const tree = setTreePath(repo, baseTree, input.path.split('/'), entry);
  const commit = formatCommit({
    tree,
    parents: parent === null ? [] : [parent],
    message: input.message,
    name: VIEWER.name,
    email: VIEWER.email,
    whenSec: store.nowSec(),
  });
  const commitOid = putObject(repo, 'commit', commit);
  repo.refs.set(refName, commitOid);
  return { ok: true, result: { blobOid, commitOid, created: existing === undefined } };
}

/** Read one path at a ref: a file's blob or a directory's entries. */
export function readContent(
  repo: RepoRec,
  path: string,
  ref: string | undefined,
): { ok: true; kind: 'file'; entry: FlatEntry; data: Buffer } | { ok: true; kind: 'dir'; treeOid: string } | OpFailure {
  const commit = resolveRef(repo, ref ?? repo.defaultBranch);
  if (commit === null) return fail(404, 'Not Found');
  const tree = commitTree(repo, commit);
  if (tree === null) return fail(404, 'Not Found');
  if (path === '') return { ok: true, kind: 'dir', treeOid: tree };
  const flat = flattenTree(repo, tree);
  const entry = flat.get(path);
  if (entry !== undefined) {
    const object = getObject(repo, entry.oid);
    if (object === null) return fail(404, 'Not Found');
    return { ok: true, kind: 'file', entry, data: object.data };
  }
  // A directory: walk the tree parts to the subtree.
  let current = tree;
  for (const part of path.split('/')) {
    const object = getObject(repo, current);
    if (object === null || object.type !== 'tree') return fail(404, 'Not Found');
    const next = parseTree(object.data).find((entry2) => entry2.name === part && entry2.mode === '40000');
    if (next === undefined) return fail(404, 'Not Found');
    current = next.oid;
  }
  return { ok: true, kind: 'dir', treeOid: current };
}

/** The blob oid a path holds at a ref (used by tests of the contents flow). */
export function blobOidAt(repo: RepoRec, path: string, ref?: string): string | null {
  const read = readContent(repo, path, ref);
  return read.ok && read.kind === 'file' ? read.entry.oid : null;
}

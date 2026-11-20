// The forge's in-memory store: one process, one store, no persistence and no outside
// service. Everything the REST, GraphQL, MCP and git smart-HTTP surfaces serve lives here,
// so an object created through one surface is the same object on every other surface.
//
// Time is a logical clock (a counter laid over a fixed epoch), never the wall clock: the
// trial replays deterministically, and two reads of the same record must agree byte for
// byte. Ids come from plain counters for the same reason.

export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export interface LabelRec {
  name: string;
  color: string;
  description: string;
}

export interface CommentRec {
  id: number;
  body: string;
  authorLogin: string;
  seq: number;
}

export interface IssueRec {
  kind: 'issue';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  seq: number;
}

export interface PullRec {
  kind: 'pull';
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeCommitSha: string | null;
  mergedSeq: number | null;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  labels: string[];
  seq: number;
}

export type ItemRec = IssueRec | PullRec;

export interface RepoRec {
  id: number;
  owner: string;
  name: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  /** Every git object the repo holds, by hex oid. */
  objects: Map<string, GitObject>;
  /** Full ref name (refs/heads/main, refs/tags/v1) -> commit/tag oid. */
  refs: Map<string, string>;
  labels: Map<string, LabelRec>;
  /** Issues and pull requests share one number space per repo, as on GitHub. */
  items: Map<number, ItemRec>;
  /** Comments by item number. */
  comments: Map<number, CommentRec[]>;
  nextNumber: number;
  seq: number;
}

/** The one login the shop token belongs to; every created repo lives under it. */
export const VIEWER = {
  id: 1000,
  login: 'adaiversen',
  name: 'ada iversen',
  email: 'adaiversen@example.invalid',
} as const;

/** The logical clock's epoch: the moment this bounty opened, in unix seconds. */
const CLOCK_EPOCH_SEC = 1_763_181_000;

export class Store {
  readonly repos = new Map<string, RepoRec>();
  private repoIdCounter = 700_001;
  private itemIdCounter = 900_001;
  private commentIdCounter = 500_001;
  private clock = 0;

  /** Advance the logical clock and return the new sequence number. */
  tick(): number {
    this.clock += 1;
    return this.clock;
  }

  /** The current logical time as unix seconds (no advance). */
  nowSec(): number {
    return CLOCK_EPOCH_SEC + this.clock;
  }

  /** An ISO-8601 stamp for a sequence number (defaults to a fresh tick). */
  isoOf(seq?: number): string {
    const at = seq === undefined ? this.tick() : seq;
    return new Date((CLOCK_EPOCH_SEC + at) * 1000).toISOString();
  }

  nextRepoId(): number {
    const id = this.repoIdCounter;
    this.repoIdCounter += 1;
    return id;
  }

  nextItemId(): number {
    const id = this.itemIdCounter;
    this.itemIdCounter += 1;
    return id;
  }

  nextCommentId(): number {
    const id = this.commentIdCounter;
    this.commentIdCounter += 1;
    return id;
  }

  private key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(name: string, options: { description?: string; isPrivate?: boolean }): RepoRec {
    const repo: RepoRec = {
      id: this.nextRepoId(),
      owner: VIEWER.login,
      name,
      description: options.description ?? '',
      isPrivate: options.isPrivate ?? false,
      defaultBranch: 'main',
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      items: new Map(),
      comments: new Map(),
      nextNumber: 1,
      seq: this.tick(),
    };
    this.repos.set(this.key(repo.owner, repo.name), repo);
    return repo;
  }

  /** A repo by owner/name; only the viewer's own repos exist, anything else is null. */
  getRepo(owner: string, name: string): RepoRec | null {
    if (owner !== VIEWER.login) return null;
    return this.repos.get(this.key(owner, name)) ?? null;
  }

  repoByName(name: string): RepoRec | null {
    return this.repos.get(this.key(VIEWER.login, name)) ?? null;
  }

  repoById(id: number): RepoRec | null {
    for (const repo of this.repos.values()) if (repo.id === id) return repo;
    return null;
  }

  deleteRepo(owner: string, name: string): boolean {
    if (owner !== VIEWER.login) return false;
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repos in creation order. */
  listRepos(): RepoRec[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}

/** The process-wide store. */
export const store = new Store();

/** An opaque GraphQL global id: base64 of "<Type>:<key>", never the bare database id. */
export function encodeGlobalId(type: string, key: string | number): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

/** Split a global id back into its type and key; null when it is not one of ours. */
export function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon <= 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

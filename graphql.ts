// The GitHub GraphQL v4 surface: POST /api/graphql with {query, variables}, or a JSON
// array of operations answered in order. A small hand-written parser and executor cover
// exactly the document shapes the API's clients send: queries and mutations with
// variables, aliases, inline fragments and fragment spreads, connections with cursor
// pagination, global node ids, and __type introspection. A GraphQL-level failure (an
// unknown field, a bad id) is a 200 whose body carries `errors`; only a missing token
// is an HTTP error (401, decided in app.ts).

import { pullConflicts, pullFiles } from './ops.ts';
import { addComment, createIssue, createPull, mergePull } from './ops.ts';
import { decodeGlobalId, encodeGlobalId, store, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import type { Ctx, Reply } from './web.ts';

// ---------------------------------------------------------------- tokenizer

interface Tok {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',' || ch === '﻿') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      toks.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('!$():=@[]{}|&'.includes(ch)) {
      toks.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        const text = end < 0 ? source.slice(i + 3) : source.slice(i + 3, end);
        toks.push({ kind: 'string', value: text });
        i = end < 0 ? source.length : end + 3;
        continue;
      }
      let text = '';
      i += 1;
      while (i < source.length && source[i] !== '"') {
        if (source[i] === '\\' && i + 1 < source.length) {
          const esc = source[i + 1];
          const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', '/': '/', '\\': '\\', '"': '"' };
          if (esc === 'u') {
            text += String.fromCharCode(parseInt(source.slice(i + 2, i + 6), 16));
            i += 6;
          } else {
            text += map[esc] ?? esc;
            i += 2;
          }
        } else {
          text += source[i];
          i += 1;
        }
      }
      i += 1;
      toks.push({ kind: 'string', value: text });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      toks.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      toks.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in document`);
  }
  toks.push({ kind: 'eof', value: '' });
  return toks;
}

// ---------------------------------------------------------------- parser

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  kind: 'field';
  name: string;
  alias: string | null;
  args: Map<string, GqlValue>;
  selectionSet: GqlSelection[] | null;
}

type GqlSelection =
  | GqlField
  | { kind: 'inline'; typeCondition: string | null; selectionSet: GqlSelection[] }
  | { kind: 'spread'; name: string };

interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  selectionSet: GqlSelection[];
}

interface GqlDocument {
  operations: GqlOperation[];
  fragments: Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>;
}

class Parser {
  private toks: Tok[];
  private at = 0;

  constructor(source: string) {
    this.toks = tokenize(source);
  }

  private peek(): Tok {
    return this.toks[this.at];
  }

  private next(): Tok {
    const tok = this.toks[this.at];
    this.at += 1;
    return tok;
  }

  private expect(value: string): void {
    const tok = this.next();
    if (tok.value !== value) throw new Error(`expected ${value}, got ${tok.value || tok.kind}`);
  }

  private skipTypeRef(): void {
    if (this.peek().value === '[') {
      this.next();
      this.skipTypeRef();
      this.expect(']');
    } else {
      this.next(); // the type name
    }
    if (this.peek().value === '!') this.next();
  }

  private parseValue(): GqlValue {
    const tok = this.next();
    if (tok.kind === 'string') return { kind: 'string', value: tok.value };
    if (tok.kind === 'number') return { kind: 'number', value: Number(tok.value) };
    if (tok.value === '$') {
      const name = this.next();
      return { kind: 'var', name: name.value };
    }
    if (tok.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (tok.value === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek().value !== '}') {
        const name = this.next().value;
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok.kind === 'name') {
      if (tok.value === 'true') return { kind: 'boolean', value: true };
      if (tok.value === 'false') return { kind: 'boolean', value: false };
      if (tok.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: tok.value };
    }
    throw new Error(`unexpected value token ${tok.value || tok.kind}`);
  }

  private parseArgs(): Map<string, GqlValue> {
    const args = new Map<string, GqlValue>();
    if (this.peek().value !== '(') return args;
    this.next();
    while (this.peek().value !== ')') {
      const name = this.next().value;
      this.expect(':');
      args.set(name, this.parseValue());
    }
    this.expect(')');
    return args;
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next(); // directive name
      if (this.peek().value === '(') this.parseArgs();
    }
  }

  private parseSelectionSet(): GqlSelection[] {
    this.expect('{');
    const selections: GqlSelection[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        const head = this.next();
        if (head.kind === 'name' && head.value === 'on') {
          const typeCondition = this.next().value;
          this.skipDirectives();
          selections.push({ kind: 'inline', typeCondition, selectionSet: this.parseSelectionSet() });
        } else {
          selections.push({ kind: 'spread', name: head.value });
        }
        continue;
      }
      const first = this.next();
      if (first.kind !== 'name') throw new Error(`expected a field name, got ${first.value || first.kind}`);
      let name = first.value;
      let alias: string | null = null;
      if (this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = this.parseArgs();
      this.skipDirectives();
      const selectionSet = this.peek().value === '{' ? this.parseSelectionSet() : null;
      selections.push({ kind: 'field', name, alias, args, selectionSet });
    }
    this.expect('}');
    return selections;
  }

  parseDocument(): GqlDocument {
    const operations: GqlOperation[] = [];
    const fragments = new Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>();
    while (this.peek().kind !== 'eof') {
      const tok = this.peek();
      if (tok.value === '{') {
        operations.push({ type: 'query', name: null, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && (tok.value === 'query' || tok.value === 'mutation')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') {
          // Variable definitions: ($id: ID!, $n: Int = 3) — names and defaults are all
          // the executor needs, and it reads variables from the request, so just skip
          // the structure carefully.
          this.next();
          while (this.peek().value !== ')') {
            this.expect('$');
            this.next(); // variable name
            this.expect(':');
            this.skipTypeRef();
            if (this.peek().value === '=') {
              this.next();
              this.parseValue();
            }
            this.skipDirectives();
          }
          this.expect(')');
        }
        this.skipDirectives();
        operations.push({ type: tok.value as 'query' | 'mutation', name, selectionSet: this.parseSelectionSet() });
        continue;
      }
      if (tok.kind === 'name' && tok.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('fragment without a type condition');
        const typeCondition = this.next().value;
        this.skipDirectives();
        fragments.set(fragName, { typeCondition, selectionSet: this.parseSelectionSet() });
        continue;
      }
      throw new Error(`unexpected token ${tok.value || tok.kind} at document level`);
    }
    return { operations, fragments };
  }
}

// ---------------------------------------------------------------- values

function evalValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return variables[value.name];
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of value.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

function argsOf(field: GqlField, variables: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of field.args) out[name] = evalValue(value, variables);
  return out;
}

// ---------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, readonly string[]> = {
  Query: ['viewer', 'repository', 'node', 'rateLimit', 'search', 'user', 'organization'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'createRepository', 'updateIssue'],
  User: ['id', 'databaseId', 'login', 'name', 'email', 'url'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'url', 'description',
    'isPrivate', 'createdAt', 'updatedAt',
  ],
  Issue: ['id', 'databaseId', 'number', 'title', 'state', 'body', 'author', 'labels', 'comments', 'repository', 'url', 'createdAt', 'updatedAt'],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'merged', 'mergeable', 'headRefName',
    'baseRefName', 'headRef', 'baseRef', 'files', 'author', 'repository', 'url', 'createdAt', 'updatedAt',
  ],
  Ref: ['name', 'prefix', 'target'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changeType'],
  Label: ['id', 'name', 'color', 'description'],
  LabelConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  Comment: ['id', 'body', 'author', 'createdAt'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  CommentEdge: ['node', 'cursor'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'clientMutationId'],
  __Type: ['name', 'kind', 'fields', 'enumValues', 'possibleTypes'],
  __Field: ['name', 'description', 'type'],
  __EnumValue: ['name', 'description'],
};

const ENUM_TYPES: Record<string, readonly string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'CODE', 'COMMIT'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- wrappers

type Wrapped =
  | { __type: 'User' }
  | { __type: 'Repository'; repo: RepoRec }
  | { __type: 'Issue'; repo: RepoRec; issue: IssueRec }
  | { __type: 'PullRequest'; repo: RepoRec; pull: PullRec }
  | { __type: 'Ref'; name: string }
  | { __type: 'IssueConnection'; nodes: Wrapped[]; total: number; startIndex: number }
  | { __type: 'PullRequestConnection'; nodes: Wrapped[]; total: number; startIndex: number }
  | { __type: 'PullRequestFileConnection'; files: Array<{ path: string; additions: number; deletions: number; changeType: string }> }
  | { __type: 'PullRequestChangedFile'; path: string; additions: number; deletions: number; changeType: string }
  | { __type: 'PageInfo'; hasNextPage: boolean; hasPreviousPage: boolean; startCursor: string | null; endCursor: string | null }
  | { __type: 'Label'; name: string; color: string }
  | { __type: 'LabelConnection'; labels: Array<{ name: string; color: string }> }
  | { __type: 'Comment'; id: number; body: string }
  | { __type: 'IssueComment'; id: number; body: string }
  | { __type: 'CommentEdge'; node: Wrapped }
  | { __type: 'CreateIssuePayload'; issue: Wrapped | null; clientMutationId: unknown }
  | { __type: 'CloseIssuePayload'; issue: Wrapped | null; clientMutationId: unknown }
  | { __type: 'CreatePullRequestPayload'; pullRequest: Wrapped | null; clientMutationId: unknown }
  | { __type: 'MergePullRequestPayload'; pullRequest: Wrapped | null; clientMutationId: unknown }
  | { __type: 'AddCommentPayload'; commentEdge: Wrapped | null; clientMutationId: unknown }
  | { __type: '__Type'; name: string }
  | { __type: '__Field'; name: string }
  | { __type: '__EnumValue'; name: string };

const userWrapped: Wrapped = { __type: 'User' };

function issueWrapped(repo: RepoRec, issue: IssueRec): Wrapped {
  return { __type: 'Issue', repo, issue };
}

function pullWrapped(repo: RepoRec, pull: PullRec): Wrapped {
  return { __type: 'PullRequest', repo, pull };
}

function cursorOf(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexOfCursor(after: unknown): number {
  if (typeof after !== 'string') return -1;
  try {
    const text = Buffer.from(after, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match === null ? -1 : Number(match[1]);
  } catch {
    return -1;
  }
}

/** Slice a connection's items by (first, after); returns nodes plus paging facts. */
function pageOf<T>(items: readonly T[], args: Record<string, unknown>): { slice: T[]; startIndex: number; total: number } {
  const afterIndex = indexOfCursor(args.after);
  const startIndex = afterIndex + 1;
  const first = typeof args.first === 'number' && args.first > 0 ? Math.floor(args.first) : items.length;
  return { slice: items.slice(startIndex, startIndex + first), startIndex, total: items.length };
}

class FieldProblem extends Error {}

function pullGraphqlState(pull: PullRec): string {
  if (pull.merged) return 'MERGED';
  return pull.state.toUpperCase();
}

// ---------------------------------------------------------------- field resolution

function resolveField(
  typeName: string,
  field: string,
  source: Wrapped | null,
  args: Record<string, unknown>,
): unknown {
  if (typeName === 'Query') {
    switch (field) {
      case 'viewer':
        return userWrapped;
      case 'repository': {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        return repo === null ? null : ({ __type: 'Repository', repo } satisfies Wrapped);
      }
      case 'node': {
        const decoded = decodeGlobalId(String(args.id ?? ''));
        if (decoded === null) return null;
        if (decoded.type === 'Repository') {
          const repo = store.repoById(Number(decoded.key));
          return repo === null ? null : ({ __type: 'Repository', repo } satisfies Wrapped);
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':');
          const repo = store.repoById(Number(repoId));
          const item = repo?.items.get(Number(number));
          if (repo === undefined || repo === null || item === undefined) return null;
          return item.kind === 'issue' ? issueWrapped(repo, item) : pullWrapped(repo, item);
        }
        if (decoded.type === 'User') return userWrapped;
        return null;
      }
      case '__type':
        return { __type: '__Type', name: String(args.name ?? '') } satisfies Wrapped;
      default:
        break;
    }
  }
  if (typeName === 'Mutation') return resolveMutation(field, args);
  if (source === null) throw new FieldProblem(`field ${field} on a null source`);
  switch (source.__type) {
    case 'User':
      switch (field) {
        case 'login': return VIEWER.login;
        case 'id': return encodeGlobalId('User', VIEWER.id);
        case 'databaseId': return VIEWER.id;
        case 'name': return VIEWER.name;
        case 'email': return VIEWER.email;
        case 'url': return `https://github.com/${VIEWER.login}`;
        default: break;
      }
      break;
    case 'Repository': {
      const repo = source.repo;
      switch (field) {
        case 'id': return encodeGlobalId('Repository', repo.id);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${repo.owner}/${repo.name}`;
        case 'owner': return userWrapped;
        case 'description': return repo.description;
        case 'isPrivate': return repo.isPrivate;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}`;
        case 'createdAt': return store.isoOf(repo.seq);
        case 'updatedAt': return store.isoOf(repo.seq);
        case 'defaultBranchRef':
          return repo.refs.has(`refs/heads/${repo.defaultBranch}`)
            ? ({ __type: 'Ref', name: repo.defaultBranch } satisfies Wrapped)
            : null;
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'issue': {
          const item = repo.items.get(Number(args.number));
          return item !== undefined && item.kind === 'issue' ? issueWrapped(repo, item) : null;
        }
        case 'issues': {
          let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
          const orderBy = (args.orderBy ?? null) as { direction?: string } | null;
          const descending = orderBy?.direction === 'DESC';
          issues.sort((a, b) => (descending ? b.seq - a.seq || b.number - a.number : a.seq - b.seq || a.number - b.number));
          const page = pageOf(issues, args);
          return {
            __type: 'IssueConnection',
            nodes: page.slice.map((issue) => issueWrapped(repo, issue)),
            total: page.total,
            startIndex: page.startIndex,
          } satisfies Wrapped;
        }
        case 'pullRequest': {
          const item = repo.items.get(Number(args.number));
          return item !== undefined && item.kind === 'pull' ? pullWrapped(repo, item) : null;
        }
        case 'pullRequests': {
          let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
          const states = Array.isArray(args.states) ? (args.states as string[]) : null;
          if (states !== null) pulls = pulls.filter((pull) => states.includes(pullGraphqlState(pull)));
          pulls.sort((a, b) => a.seq - b.seq);
          const page = pageOf(pulls, args);
          return {
            __type: 'PullRequestConnection',
            nodes: page.slice.map((pull) => pullWrapped(repo, pull)),
            total: page.total,
            startIndex: page.startIndex,
          } satisfies Wrapped;
        }
        default: break;
      }
      break;
    }
    case 'Issue': {
      const { repo, issue } = source;
      switch (field) {
        case 'id': return encodeGlobalId('Issue', `${repo.id}:${issue.number}`);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'body': return issue.body;
        case 'state': return issue.state.toUpperCase();
        case 'author': return userWrapped;
        case 'repository': return { __type: 'Repository', repo } satisfies Wrapped;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
        case 'createdAt': return store.isoOf(issue.seq);
        case 'updatedAt': return store.isoOf(issue.seq);
        case 'labels':
          return {
            __type: 'LabelConnection',
            labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
          } satisfies Wrapped;
        default: break;
      }
      break;
    }
    case 'PullRequest': {
      const { repo, pull } = source;
      switch (field) {
        case 'id': return encodeGlobalId('PullRequest', `${repo.id}:${pull.number}`);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pullGraphqlState(pull);
        case 'merged': return pull.merged;
        case 'mergeable': return pull.state === 'open' ? (pullConflicts(repo, pull) ? 'CONFLICTING' : 'MERGEABLE') : 'UNKNOWN';
        case 'headRefName': return pull.headRef;
        case 'baseRefName': return pull.baseRef;
        case 'author': return userWrapped;
        case 'repository': return { __type: 'Repository', repo } satisfies Wrapped;
        case 'url': return `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`;
        case 'createdAt': return store.isoOf(pull.seq);
        case 'updatedAt': return store.isoOf(pull.seq);
        case 'files': {
          const files = pullFiles(repo, pull).map((file) => ({
            path: file.filename,
            additions: file.additions,
            deletions: file.deletions,
            changeType: file.status.toUpperCase(),
          }));
          const page = pageOf(files, args);
          return { __type: 'PullRequestFileConnection', files: page.slice } satisfies Wrapped;
        }
        default: break;
      }
      break;
    }
    case 'Ref':
      if (field === 'name') return source.name;
      if (field === 'prefix') return 'refs/heads/';
      break;
    case 'IssueConnection':
    case 'PullRequestConnection': {
      if (field === 'nodes') return source.nodes;
      if (field === 'totalCount') return source.total;
      if (field === 'pageInfo') {
        const count = source.nodes.length;
        return {
          __type: 'PageInfo',
          hasNextPage: source.startIndex + count < source.total,
          hasPreviousPage: source.startIndex > 0,
          startCursor: count > 0 ? cursorOf(source.startIndex) : null,
          endCursor: count > 0 ? cursorOf(source.startIndex + count - 1) : null,
        } satisfies Wrapped;
      }
      if (field === 'edges') {
        return source.nodes.map((node, index) => ({ __type: 'CommentEdge', node }));
      }
      break;
    }
    case 'PullRequestFileConnection':
      if (field === 'nodes') {
        return source.files.map((file) => ({ __type: 'PullRequestChangedFile', ...file }) satisfies Wrapped);
      }
      if (field === 'totalCount') return source.files.length;
      break;
    case 'PullRequestChangedFile':
      if (field === 'path') return source.path;
      if (field === 'additions') return source.additions;
      if (field === 'deletions') return source.deletions;
      if (field === 'changeType') return source.changeType;
      break;
    case 'PageInfo':
      if (field === 'hasNextPage') return source.hasNextPage;
      if (field === 'hasPreviousPage') return source.hasPreviousPage;
      if (field === 'startCursor') return source.startCursor;
      if (field === 'endCursor') return source.endCursor;
      break;
    case 'Label':
      if (field === 'name') return source.name;
      if (field === 'color') return source.color;
      if (field === 'id') return encodeGlobalId('Label', source.name);
      if (field === 'description') return '';
      break;
    case 'LabelConnection':
      if (field === 'nodes') return source.labels.map((label) => ({ __type: 'Label', ...label }) satisfies Wrapped);
      break;
    case 'Comment':
    case 'IssueComment':
      if (field === 'id') return encodeGlobalId('Comment', source.id);
      if (field === 'body') return source.body;
      if (field === 'author') return userWrapped;
      break;
    case 'CommentEdge':
      if (field === 'node') return source.node;
      if (field === 'cursor') return cursorOf(0);
      break;
    case 'CreateIssuePayload':
    case 'CloseIssuePayload':
      if (field === 'issue') return source.issue;
      if (field === 'clientMutationId') return source.clientMutationId ?? null;
      break;
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload':
      if (field === 'pullRequest') return source.pullRequest;
      if (field === 'clientMutationId') return source.clientMutationId ?? null;
      break;
    case 'AddCommentPayload':
      if (field === 'commentEdge') return source.commentEdge;
      if (field === 'clientMutationId') return source.clientMutationId ?? null;
      break;
    case '__Type': {
      const fields = TYPE_FIELDS[source.name];
      const enumValues = ENUM_TYPES[source.name];
      if (field === 'name') return source.name;
      if (field === 'kind') return enumValues !== undefined ? 'ENUM' : 'OBJECT';
      if (field === 'fields') {
        return fields === undefined ? null : fields.map((name) => ({ __type: '__Field', name }) satisfies Wrapped);
      }
      if (field === 'enumValues') {
        return enumValues === undefined ? null : enumValues.map((name) => ({ __type: '__EnumValue', name }) satisfies Wrapped);
      }
      break;
    }
    case '__Field':
    case '__EnumValue':
      if (field === 'name') return source.name;
      if (field === 'description') return null;
      break;
    default:
      break;
  }
  throw new FieldProblem(`Field '${field}' doesn't exist on type '${typeName}'`);
}

function resolveMutation(field: string, args: Record<string, unknown>): unknown {
  const input = (args.input ?? {}) as Record<string, unknown>;
  const clientMutationId = input.clientMutationId ?? null;
  switch (field) {
    case 'createIssue': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? store.repoById(Number(decoded.key)) : null;
      if (repo === null) throw new FieldProblem('repository not found for createIssue');
      const result = createIssue(repo, { title: String(input.title ?? ''), body: String(input.body ?? '') });
      if (!result.ok) throw new FieldProblem(result.message);
      return { __type: 'CreateIssuePayload', issue: issueWrapped(repo, result.issue), clientMutationId } satisfies Wrapped;
    }
    case 'closeIssue': {
      const found = findItem(String(input.issueId ?? ''));
      if (found === null) throw new FieldProblem('issue not found for closeIssue');
      found.item.state = 'closed';
      return {
        __type: 'CloseIssuePayload',
        issue: found.item.kind === 'issue' ? issueWrapped(found.repo, found.item) : null,
        clientMutationId,
      } satisfies Wrapped;
    }
    case 'createPullRequest': {
      const decoded = decodeGlobalId(String(input.repositoryId ?? ''));
      const repo = decoded !== null && decoded.type === 'Repository' ? store.repoById(Number(decoded.key)) : null;
      if (repo === null) throw new FieldProblem('repository not found for createPullRequest');
      const result = createPull(repo, {
        title: String(input.title ?? ''),
        body: String(input.body ?? ''),
        head: String(input.headRefName ?? ''),
        base: String(input.baseRefName ?? ''),
      });
      if (!result.ok) throw new FieldProblem(result.message);
      return { __type: 'CreatePullRequestPayload', pullRequest: pullWrapped(repo, result.pull), clientMutationId } satisfies Wrapped;
    }
    case 'mergePullRequest': {
      const found = findItem(String(input.pullRequestId ?? ''));
      if (found === null || found.item.kind !== 'pull') throw new FieldProblem('pull request not found for mergePullRequest');
      const result = mergePull(found.repo, found.item);
      if (!result.ok) throw new FieldProblem(result.message);
      return { __type: 'MergePullRequestPayload', pullRequest: pullWrapped(found.repo, found.item), clientMutationId } satisfies Wrapped;
    }
    case 'addComment': {
      const found = findItem(String(input.subjectId ?? ''));
      if (found === null) throw new FieldProblem('subject not found for addComment');
      const comment = addComment(found.repo, found.item, String(input.body ?? ''));
      const node: Wrapped = { __type: 'IssueComment', id: comment.id, body: comment.body };
      return {
        __type: 'AddCommentPayload',
        commentEdge: { __type: 'CommentEdge', node } satisfies Wrapped,
        clientMutationId,
      } satisfies Wrapped;
    }
    default:
      throw new FieldProblem(`Field '${field}' doesn't exist on type 'Mutation'`);
  }
}

function findItem(globalId: string): { repo: RepoRec; item: IssueRec | PullRec } | null {
  const decoded = decodeGlobalId(globalId);
  if (decoded === null) return null;
  const [repoId, number] = decoded.key.split(':');
  const repo = store.repoById(Number(repoId));
  if (repo === null) return null;
  const item = repo.items.get(Number(number));
  return item === undefined ? null : { repo, item };
}

// ---------------------------------------------------------------- executor

interface ExecCtx {
  variables: Record<string, unknown>;
  fragments: Map<string, { typeCondition: string | null; selectionSet: GqlSelection[] }>;
  errors: Array<{ message: string; path?: Array<string | number> }>;
}

function isWrapped(value: unknown): value is Wrapped {
  return typeof value === 'object' && value !== null && '__type' in value;
}

function executeSelections(
  typeName: string,
  source: Wrapped | null,
  selections: readonly GqlSelection[],
  ctx: ExecCtx,
  path: Array<string | number>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const selection of selections) {
    if (selection.kind === 'inline') {
      if (selection.typeCondition === null || selection.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, source, selection.selectionSet, ctx, path));
      }
      continue;
    }
    if (selection.kind === 'spread') {
      const fragment = ctx.fragments.get(selection.name);
      if (fragment === undefined) {
        ctx.errors.push({ message: `Unknown fragment "${selection.name}"`, path });
        continue;
      }
      if (fragment.typeCondition === null || fragment.typeCondition === typeName) {
        Object.assign(out, executeSelections(typeName, source, fragment.selectionSet, ctx, path));
      }
      continue;
    }
    const key = selection.alias ?? selection.name;
    if (selection.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const fieldPath = [...path, key];
    let value: unknown;
    try {
      if (selection.name === '__type' && typeName === 'Query') {
        value = resolveField('Query', '__type', null, argsOf(selection, ctx.variables));
      } else {
        value = resolveField(typeName, selection.name, source, argsOf(selection, ctx.variables));
      }
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err), path: fieldPath });
      out[key] = null;
      continue;
    }
    if (selection.selectionSet !== null && value !== null && value !== undefined) {
      if (Array.isArray(value)) {
        out[key] = value.map((entry, index) =>
          isWrapped(entry) ? executeSelections(entry.__type, entry, selection.selectionSet as GqlSelection[], ctx, [...fieldPath, index]) : entry,
        );
      } else if (isWrapped(value)) {
        out[key] = executeSelections(value.__type, value, selection.selectionSet, ctx, fieldPath);
      } else {
        out[key] = value;
      }
    } else {
      out[key] = value ?? null;
    }
  }
  return out;
}

function executeOperation(operation: GqlOperation, document: GqlDocument, variables: Record<string, unknown>): { data: unknown; errors?: unknown[] } {
  const ctx: ExecCtx = { variables, fragments: document.fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelections(rootType, null, operation.selectionSet, ctx, []);
  const out: { data: unknown; errors?: unknown[] } = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

// ---------------------------------------------------------------- HTTP

/** Route one POST /api/graphql request (a single operation or a batch array). */
export function routeGraphQL(ctx: Ctx): Reply {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return { status: 400, body: { errors: [{ message: 'Request body is not valid JSON' }] } };
  }
  const runOne = (entry: unknown): { data: unknown; errors?: unknown[] } => {
    if (typeof entry !== 'object' || entry === null) return { data: null, errors: [{ message: 'Operation must be an object' }] };
    const record = entry as Record<string, unknown>;
    const query = typeof record.query === 'string' ? record.query : '';
    const variables = (typeof record.variables === 'object' && record.variables !== null ? record.variables : {}) as Record<string, unknown>;
    let document: GqlDocument;
    try {
      document = new Parser(query).parseDocument();
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
    if (document.operations.length === 0) return { data: null, errors: [{ message: 'No operation found' }] };
    const operationName = typeof record.operationName === 'string' ? record.operationName : null;
    const operation = operationName === null ? document.operations[0] : document.operations.find((op) => op.name === operationName) ?? document.operations[0];
    return executeOperation(operation, document, variables);
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}

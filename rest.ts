// The GitHub REST v3 surface: /api/v3 root, meta, the token's user and repositories,
// contents, branches and git refs, commits, labels, issues with comments, and pull
// requests with files and squash merge. Every reply is JSON; every error body carries a
// string `message`; statuses are GitHub's own (201 creates, 409 stale sha, 422 failed
// validation, 405 an unmergeable pull).

import { formatCommit, getObject, parseCommit, parseTree, putObject, resolveRef, setTreePath, walkCommits } from './git.ts';
import {
  addComment,
  commentJson,
  createIssue,
  createPull,
  issueJson,
  itemJson,
  labelJson,
  mergePull,
  pullFiles,
  pullJson,
  putContent,
  readContent,
  repoJson,
  upsertLabel,
  userJson,
} from './ops.ts';
import { store, VIEWER, type IssueRec, type PullRec, type RepoRec } from './store.ts';
import { bodyJson, bool, errorReply, jsonReply, num, paginate, str, strList, type Ctx, type Reply } from './web.ts';

const NOT_FOUND = (): Reply => errorReply(404, 'Not Found');

function repoOr404(owner: string, name: string): RepoRec | Reply {
  const repo = store.getRepo(owner, name);
  return repo ?? NOT_FOUND();
}

function isReply(value: RepoRec | Reply): value is Reply {
  return (value as Reply).status !== undefined;
}

// ---------------------------------------------------------------- root & meta

function root(): Reply {
  return jsonReply(
    200,
    {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      user_repositories_url: '/api/v3/user/repos',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      issue_url: '/api/v3/repos/{owner}/{repo}/issues/{number}',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function meta(): Reply {
  return jsonReply(200, {
    installed_version: '1.0.0',
    verifiable_password_authentication: false,
    ssh_key_fingerprints: {},
    hooks: [],
    web: [],
    api: [],
    git: [],
    packages: [],
    pages: [],
    importer: [],
    actions: [],
    dependabot: [],
  });
}

function rateLimit(): Reply {
  const reset = Math.floor(Date.now() / 1000) + 3600;
  const core = { limit: 5000, remaining: 4999, reset, used: 1 };
  return jsonReply(200, { resources: { core, search: { limit: 30, remaining: 30, reset, used: 0 } }, rate: core });
}

// ---------------------------------------------------------------- repositories

function createRepo(ctx: Ctx): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const name = str(body.name);
  if (name === undefined || name === '' || !/^[A-Za-z0-9._-]+$/.test(name) || name === '.' || name === '..') {
    return errorReply(422, 'Validation Failed: name is invalid');
  }
  if (store.repoByName(name) !== null) return errorReply(422, 'name already exists on this account');
  const repo = store.createRepo(name, {
    description: str(body.description) ?? '',
    isPrivate: bool(body.private) ?? false,
  });
  if (bool(body.auto_init) === true) {
    const blob = putObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
    const tree = setTreePath(repo, null, ['README.md'], { mode: '100644', oid: blob });
    const commit = formatCommit({
      tree,
      parents: [],
      message: 'Initial commit',
      name: VIEWER.name,
      email: VIEWER.email,
      whenSec: store.nowSec(),
    });
    const sha = putObject(repo, 'commit', commit);
    repo.refs.set(`refs/heads/${repo.defaultBranch}`, sha);
  }
  return jsonReply(201, repoJson(repo));
}

function listUserRepos(ctx: Ctx): Reply {
  const page = paginate(ctx, store.listRepos().map(repoJson), '/api/v3/user/repos');
  const headers: Record<string, string> = {};
  if (page.link !== null) headers.link = page.link;
  return jsonReply(200, page.items, headers);
}

function patchRepo(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const description = str(body.description);
  if (description !== undefined) repo.description = description;
  const isPrivate = bool(body.private);
  if (isPrivate !== undefined) repo.isPrivate = isPrivate;
  const defaultBranch = str(body.default_branch);
  if (defaultBranch !== undefined) repo.defaultBranch = defaultBranch;
  const name = str(body.name);
  if (name !== undefined && name !== repo.name) {
    if (store.repoByName(name) !== null) return errorReply(422, 'name already exists on this account');
    store.repos.delete(`${repo.owner}/${repo.name}`);
    repo.name = name;
    store.repos.set(`${repo.owner}/${repo.name}`, repo);
  }
  return jsonReply(200, repoJson(repo));
}

// ---------------------------------------------------------------- contents

function getContents(ctx: Ctx, repo: RepoRec, path: string): Reply {
  const read = readContent(repo, path, str(ctx.query.get('ref') ?? undefined));
  if (!read.ok) return errorReply(read.status, read.message);
  if (read.kind === 'file') {
    const name = path.split('/').pop() ?? path;
    return jsonReply(200, {
      type: 'file',
      encoding: 'base64',
      size: read.data.length,
      name,
      path,
      sha: read.entry.oid,
      content: read.data.toString('base64'),
    });
  }
  const tree = getObject(repo, read.treeOid);
  if (tree === null) return NOT_FOUND();
  const entries = parseTree(tree.data).map((entry) => ({
    name: entry.name,
    path: path === '' ? entry.name : `${path}/${entry.name}`,
    sha: entry.oid,
    size: entry.mode === '40000' ? 0 : (getObject(repo, entry.oid)?.data.length ?? 0),
    type: entry.mode === '40000' ? 'dir' : 'file',
  }));
  return jsonReply(200, entries);
}

function putContents(ctx: Ctx, repo: RepoRec, path: string): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const encoded = str(body.content);
  if (encoded === undefined) return errorReply(422, 'content is required');
  const content = Buffer.from(encoded.replace(/[\r\n\t ]+/g, ''), 'base64');
  const result = putContent(repo, {
    path,
    content,
    message: str(body.message) ?? `Update ${path}`,
    branch: str(body.branch),
    sha: str(body.sha),
  });
  if (!result.ok) return errorReply(result.status, result.message);
  const name = path.split('/').pop() ?? path;
  return jsonReply(result.result.created ? 201 : 200, {
    content: { name, path, sha: result.result.blobOid, size: content.length, encoding: 'base64', type: 'file' },
    commit: { sha: result.result.commitOid, message: str(body.message) ?? `Update ${path}` },
  });
}

function deleteContents(ctx: Ctx, repo: RepoRec, path: string): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const result = putContent(repo, {
    path,
    content: null,
    message: str(body.message) ?? `Delete ${path}`,
    branch: str(body.branch),
    sha: str(body.sha),
  });
  if (!result.ok) return errorReply(result.status, result.message);
  return jsonReply(200, { content: null, commit: { sha: result.result.commitOid } });
}

// ---------------------------------------------------------------- branches, refs, commits

function listBranches(repo: RepoRec): Reply {
  const branches: Array<Record<string, unknown>> = [];
  for (const [ref, oid] of repo.refs) {
    if (!ref.startsWith('refs/heads/')) continue;
    branches.push({ name: ref.slice('refs/heads/'.length), commit: { sha: oid }, protected: false });
  }
  branches.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return jsonReply(200, branches);
}

function getBranch(repo: RepoRec, name: string): Reply {
  const oid = repo.refs.get(`refs/heads/${name}`);
  if (oid === undefined) return NOT_FOUND();
  return jsonReply(200, { name, commit: { sha: oid }, protected: false });
}

function getGitRef(repo: RepoRec, fullRef: string): Reply {
  const oid = repo.refs.get(fullRef);
  if (oid === undefined) return NOT_FOUND();
  const object = getObject(repo, oid);
  return jsonReply(200, {
    ref: fullRef,
    object: { sha: oid, type: object?.type ?? 'commit' },
  });
}

function createGitRef(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const ref = str(body.ref);
  const sha = str(body.sha);
  if (ref === undefined || !ref.startsWith('refs/') || sha === undefined) return errorReply(422, 'Validation Failed');
  const object = getObject(repo, sha);
  if (object === null) return errorReply(422, 'Object does not exist');
  repo.refs.set(ref, sha);
  return jsonReply(201, { ref, object: { sha, type: object.type } });
}

function identJson(ident: string): { name: string; email: string; date: string } {
  const match = /^(.*)<([^>]*)>\s+(\d+)\s+[+-]\d{4}$/.exec(ident.trim());
  if (match === null) return { name: ident, email: '', date: store.isoOf(0) };
  return { name: match[1].trim(), email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

function commitJson(repo: RepoRec, oid: string): Record<string, unknown> | null {
  const object = getObject(repo, oid);
  if (object === null || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  return {
    sha: oid,
    commit: {
      author: identJson(commit.author),
      committer: identJson(commit.committer),
      message: commit.message.replace(/\n$/, ''),
      tree: { sha: commit.tree },
      comment_count: 0,
    },
    author: { login: VIEWER.login, id: VIEWER.id },
    committer: { login: VIEWER.login, id: VIEWER.id },
    parents: commit.parents.map((parent) => ({ sha: parent })),
  };
}

function listCommits(ctx: Ctx, repo: RepoRec): Reply {
  const ref = str(ctx.query.get('sha') ?? undefined) ?? repo.defaultBranch;
  const tip = resolveRef(repo, ref);
  if (tip === null) return jsonReply(200, []);
  const all = walkCommits(repo, tip)
    .map((oid) => commitJson(repo, oid))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
  const page = paginate(ctx, all, `/api/v3/repos/${repo.owner}/${repo.name}/commits`);
  const headers: Record<string, string> = {};
  if (page.link !== null) headers.link = page.link;
  return jsonReply(200, page.items, headers);
}

// ---------------------------------------------------------------- issues & comments

function listIssues(ctx: Ctx, repo: RepoRec): Reply {
  const state = str(ctx.query.get('state') ?? undefined) ?? 'open';
  const direction = str(ctx.query.get('direction') ?? undefined) ?? 'desc';
  let issues = [...repo.items.values()].filter((item): item is IssueRec => item.kind === 'issue');
  if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
  issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  const page = paginate(ctx, issues.map((issue) => issueJson(repo, issue)), `/api/v3/repos/${repo.owner}/${repo.name}/issues`);
  const headers: Record<string, string> = {};
  if (page.link !== null) headers.link = page.link;
  return jsonReply(200, page.items, headers);
}

function postIssue(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const title = str(body.title);
  if (title === undefined || title === '') return errorReply(422, 'Validation Failed: title is required');
  const result = createIssue(repo, { title, body: str(body.body) ?? '', labels: strList(body.labels) ?? [] });
  if (!result.ok) return errorReply(result.status, result.message);
  return jsonReply(201, issueJson(repo, result.issue));
}

function patchIssue(ctx: Ctx, repo: RepoRec, item: IssueRec | PullRec): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const title = str(body.title);
  if (title !== undefined) item.title = title;
  const text = str(body.body);
  if (text !== undefined) item.body = text;
  const state = str(body.state);
  if (state === 'closed' || state === 'open') item.state = state;
  const labels = strList(body.labels);
  if (labels !== undefined) {
    for (const name of labels) if (!repo.labels.has(name)) return errorReply(422, `Label "${name}" does not exist`);
    item.labels = labels;
  }
  return jsonReply(200, itemJson(repo, item));
}

function listComments(repo: RepoRec, number: number): Reply {
  const comments = repo.comments.get(number) ?? [];
  return jsonReply(200, comments.map(commentJson));
}

function postComment(ctx: Ctx, repo: RepoRec, item: IssueRec | PullRec): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const text = str(body.body);
  if (text === undefined) return errorReply(422, 'Validation Failed: body is required');
  const comment = addComment(repo, item, text);
  return jsonReply(201, commentJson(comment));
}

// ---------------------------------------------------------------- pulls

function listPulls(ctx: Ctx, repo: RepoRec): Reply {
  const state = str(ctx.query.get('state') ?? undefined) ?? 'open';
  let pulls = [...repo.items.values()].filter((item): item is PullRec => item.kind === 'pull');
  if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  const page = paginate(ctx, pulls.map((pull) => pullJson(repo, pull)), `/api/v3/repos/${repo.owner}/${repo.name}/pulls`);
  const headers: Record<string, string> = {};
  if (page.link !== null) headers.link = page.link;
  return jsonReply(200, page.items, headers);
}

function postPull(ctx: Ctx, repo: RepoRec): Reply {
  const body = bodyJson(ctx);
  if (body === null) return errorReply(400, 'Problems parsing JSON');
  const title = str(body.title);
  const head = str(body.head);
  const base = str(body.base);
  if (title === undefined || head === undefined || base === undefined) {
    return errorReply(422, 'Validation Failed: title, head and base are required');
  }
  const result = createPull(repo, { title, body: str(body.body) ?? '', head, base });
  if (!result.ok) return errorReply(result.status, result.message);
  return jsonReply(201, pullJson(repo, result.pull));
}

function mergePullRoute(repo: RepoRec, pull: PullRec): Reply {
  const result = mergePull(repo, pull);
  if (!result.ok) return errorReply(result.status, result.message);
  return jsonReply(200, { sha: result.sha, merged: true, message: 'Pull Request successfully merged' });
}

// ---------------------------------------------------------------- router

/** Route one /api/v3 request; `rest` is the path after the /api/v3 prefix. */
export function routeRest(ctx: Ctx, rest: readonly string[]): Reply {
  const method = ctx.method;
  if ((method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') && ctx.body.length > 0 && bodyJson(ctx) === null) {
    return errorReply(400, 'Problems parsing JSON');
  }
  if (rest.length === 0) return method === 'GET' ? root() : NOT_FOUND();
  if (rest[0] === 'meta' && rest.length === 1) return method === 'GET' ? meta() : NOT_FOUND();
  if (rest[0] === 'rate_limit' && rest.length === 1) return method === 'GET' ? rateLimit() : NOT_FOUND();
  if (rest[0] === 'user' && rest.length === 1) return method === 'GET' ? jsonReply(200, userJson()) : NOT_FOUND();
  if (rest[0] === 'user' && rest[1] === 'repos' && rest.length === 2) {
    if (method === 'GET') return listUserRepos(ctx);
    if (method === 'POST') return createRepo(ctx);
    return NOT_FOUND();
  }
  if (rest[0] !== 'repos' || rest.length < 3) return NOT_FOUND();
  const found = repoOr404(rest[1], rest[2]);
  if (isReply(found)) return found;
  const repo = found;
  const tail = rest.slice(3);

  if (tail.length === 0) {
    if (method === 'GET') return jsonReply(200, repoJson(repo));
    if (method === 'PATCH') return patchRepo(ctx, repo);
    if (method === 'DELETE') {
      store.deleteRepo(repo.owner, repo.name);
      return { status: 204 };
    }
    return NOT_FOUND();
  }

  if (tail[0] === 'contents') {
    const path = tail.slice(1).join('/');
    if (method === 'GET') return getContents(ctx, repo, path);
    if (method === 'PUT') return putContents(ctx, repo, path);
    if (method === 'DELETE') return deleteContents(ctx, repo, path);
    return NOT_FOUND();
  }
  if (tail[0] === 'branches' && tail.length === 1) return method === 'GET' ? listBranches(repo) : NOT_FOUND();
  if (tail[0] === 'branches') return method === 'GET' ? getBranch(repo, tail.slice(1).join('/')) : NOT_FOUND();
  if (tail[0] === 'git' && tail[1] === 'refs' && tail.length === 2) {
    return method === 'POST' ? createGitRef(ctx, repo) : NOT_FOUND();
  }
  if (tail[0] === 'git' && tail[1] === 'refs') {
    return method === 'GET' ? getGitRef(repo, `refs/${tail.slice(2).join('/')}`) : NOT_FOUND();
  }
  if (tail[0] === 'commits' && tail.length === 1) return method === 'GET' ? listCommits(ctx, repo) : NOT_FOUND();
  if (tail[0] === 'commits' && tail.length === 2) {
    if (method !== 'GET') return NOT_FOUND();
    const commit = commitJson(repo, tail[1]);
    return commit === null ? NOT_FOUND() : jsonReply(200, commit);
  }
  if (tail[0] === 'labels' && tail.length === 1) {
    if (method === 'GET') return jsonReply(200, [...repo.labels.values()].map(labelJson));
    if (method === 'POST') {
      const body = bodyJson(ctx);
      if (body === null) return errorReply(400, 'Problems parsing JSON');
      const name = str(body.name);
      if (name === undefined || name === '') return errorReply(422, 'Validation Failed: name is required');
      const existed = repo.labels.has(name);
      const label = upsertLabel(repo, name, str(body.color), str(body.description));
      return jsonReply(existed ? 200 : 201, labelJson(label));
    }
    return NOT_FOUND();
  }
  if (tail[0] === 'labels' && tail.length === 2) {
    const label = repo.labels.get(tail[1]);
    return method === 'GET' && label !== undefined ? jsonReply(200, labelJson(label)) : NOT_FOUND();
  }
  if (tail[0] === 'issues' && tail.length === 1) {
    if (method === 'GET') return listIssues(ctx, repo);
    if (method === 'POST') return postIssue(ctx, repo);
    return NOT_FOUND();
  }
  if (tail[0] === 'issues' && tail.length >= 2) {
    const number = num(Number(tail[1]));
    const item = number === undefined ? undefined : repo.items.get(number);
    if (item === undefined) return NOT_FOUND();
    if (tail.length === 2) {
      if (method === 'GET') return jsonReply(200, itemJson(repo, item));
      if (method === 'PATCH') return patchIssue(ctx, repo, item);
      return NOT_FOUND();
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (method === 'GET') return listComments(repo, item.number);
      if (method === 'POST') return postComment(ctx, repo, item);
      return NOT_FOUND();
    }
    return NOT_FOUND();
  }
  if (tail[0] === 'pulls' && tail.length === 1) {
    if (method === 'GET') return listPulls(ctx, repo);
    if (method === 'POST') return postPull(ctx, repo);
    return NOT_FOUND();
  }
  if (tail[0] === 'pulls' && tail.length >= 2) {
    const number = num(Number(tail[1]));
    const item = number === undefined ? undefined : repo.items.get(number);
    if (item === undefined || item.kind !== 'pull') return NOT_FOUND();
    if (tail.length === 2) {
      if (method === 'GET') return jsonReply(200, pullJson(repo, item));
      if (method === 'PATCH') return patchIssue(ctx, repo, item);
      return NOT_FOUND();
    }
    if (tail.length === 3 && tail[2] === 'files') {
      return method === 'GET' ? jsonReply(200, pullFiles(repo, item)) : NOT_FOUND();
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      return method === 'PUT' ? mergePullRoute(repo, item) : NOT_FOUND();
    }
    return NOT_FOUND();
  }
  return NOT_FOUND();
}

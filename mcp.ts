// The MCP endpoint: POST /mcp, JSON-RPC 2.0 over Streamable HTTP, answered with plain
// JSON. The server speaks the modern discovery revision (server/discover) and the older
// initialize handshake, and its tools act on the same store as REST and GraphQL, so an
// issue created here is the same issue everywhere. Authentication is decided in app.ts
// before this module runs: a request without the shop token never reaches a tool.

import { createIssue, createPull, issueJson, mergePull, pullJson, repoJson } from './ops.ts';
import { store, type RepoRec } from './store.ts';
import { str, type Ctx, type Reply } from './web.ts';

const SERVER_INFO = { name: 'makefun-forge', version: '1.0.0' };
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const OWNER_REPO: Record<string, { type: string; description: string }> = {
  owner: { type: 'string', description: 'The repository owner login' },
  repo: { type: 'string', description: 'The repository name' },
};

/** The tool list, built once so two tools/list calls answer byte-identically. */
const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name' },
        description: { type: 'string', description: 'A short description of the repository' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: { type: 'object', properties: { ...OWNER_REPO }, required: ['owner', 'repo'] },
  },
  {
    name: 'list_repos',
    description: 'List the repositories of the authenticated user',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'create_issue',
    description: 'Create a new issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The issue title' },
        body: { type: 'string', description: 'The issue body' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        state: { type: 'string', description: 'Filter by state: open, closed or all' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'get_issue',
    description: 'Get one issue of a repository by its number',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        issue_number: { type: 'number', description: 'The issue number' },
      },
      required: ['owner', 'repo', 'issue_number'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        title: { type: 'string', description: 'The pull request title' },
        body: { type: 'string', description: 'The pull request body' },
        head: { type: 'string', description: 'The head branch name' },
        base: { type: 'string', description: 'The base branch name' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by its number (squash merge)',
    inputSchema: {
      type: 'object',
      properties: {
        ...OWNER_REPO,
        pull_number: { type: 'number', description: 'The pull request number' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

interface RpcError {
  code: number;
  message: string;
}

type ToolOutcome = { ok: true; payload: unknown; text?: string } | { ok: false; rpc?: RpcError; message: string };

function repoArg(args: Record<string, unknown>): RepoRec | null {
  const owner = str(args.owner) ?? '';
  const name = str(args.repo) ?? str(args.repository) ?? '';
  if (name === '') return null;
  return store.getRepo(owner, name) ?? store.repoByName(name);
}

function callTool(name: string, args: Record<string, unknown>): ToolOutcome {
  const canonical = name.toLowerCase().split('/').pop() ?? name.toLowerCase();
  const tool = TOOLS.find((candidate) => candidate.name === canonical || canonical.endsWith(`_${candidate.name}`) || canonical.endsWith(`-${candidate.name}`));
  if (tool === undefined) return { ok: false, rpc: { code: -32602, message: `Unknown tool: ${name}` }, message: `Unknown tool: ${name}` };
  for (const required of tool.inputSchema.required) {
    const value = args[required];
    if (value === undefined || value === null || value === '') {
      return { ok: false, rpc: { code: -32602, message: `Missing required argument: ${required}` }, message: `Missing required argument: ${required}` };
    }
  }
  switch (tool.name) {
    case 'create_repo': {
      const repoName = str(args.name) as string;
      const existing = store.repoByName(repoName);
      if (existing !== null) return { ok: true, payload: repoJson(existing) };
      const repo = store.createRepo(repoName, {
        description: str(args.description) ?? '',
        isPrivate: args.private === true,
      });
      return { ok: true, payload: repoJson(repo) };
    }
    case 'get_repo': {
      const repo = repoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      return { ok: true, payload: repoJson(repo) };
    }
    case 'list_repos': {
      const repos = store.listRepos().map(repoJson);
      return { ok: true, payload: { repositories: repos }, text: JSON.stringify(repos) };
    }
    case 'create_issue': {
      const repo = repoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const result = createIssue(repo, { title: str(args.title) as string, body: str(args.body) ?? '' });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, payload: issueJson(repo, result.issue) };
    }
    case 'list_issues': {
      const repo = repoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const state = str(args.state) ?? 'open';
      const issues = [...repo.items.values()]
        .filter((item) => item.kind === 'issue' && (state === 'all' || item.state === state))
        .map((item) => issueJson(repo, item));
      return { ok: true, payload: { issues }, text: JSON.stringify(issues) };
    }
    case 'get_issue': {
      const repo = repoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const number = typeof args.issue_number === 'number' ? args.issue_number : Number(args.issue_number);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'issue') return { ok: false, message: 'Issue not found' };
      return { ok: true, payload: issueJson(repo, item) };
    }
    case 'create_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const result = createPull(repo, {
        title: str(args.title) as string,
        body: str(args.body) ?? '',
        head: str(args.head) as string,
        base: str(args.base) as string,
      });
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, payload: pullJson(repo, result.pull) };
    }
    case 'merge_pull_request': {
      const repo = repoArg(args);
      if (repo === null) return { ok: false, message: 'Repository not found' };
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const item = repo.items.get(number);
      if (item === undefined || item.kind !== 'pull') return { ok: false, message: 'Pull request not found' };
      const result = mergePull(repo, item);
      if (!result.ok) return { ok: false, message: result.message };
      return { ok: true, payload: { ...pullJson(repo, item), sha: result.sha, merged: true } };
    }
    default:
      return { ok: false, rpc: { code: -32602, message: `Unknown tool: ${name}` }, message: `Unknown tool: ${name}` };
  }
}

function toolResultReply(id: unknown, outcome: ToolOutcome): Reply {
  if (!outcome.ok && outcome.rpc !== undefined) {
    return { status: 200, body: { jsonrpc: '2.0', id, error: outcome.rpc } };
  }
  if (!outcome.ok) {
    return {
      status: 200,
      body: {
        jsonrpc: '2.0',
        id,
        result: { content: [{ type: 'text', text: outcome.message }], isError: true },
      },
    };
  }
  const text = outcome.text ?? JSON.stringify(outcome.payload);
  const structured = typeof outcome.payload === 'object' && outcome.payload !== null ? outcome.payload : { value: outcome.payload };
  return {
    status: 200,
    body: {
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text }], structuredContent: structured, isError: false },
    },
  };
}

function handleOne(message: Record<string, unknown>): Reply | null {
  const id = message.id;
  const method = typeof message.method === 'string' ? message.method : '';
  if (id === undefined) return null; // a notification: accepted, nothing to answer
  switch (method) {
    case 'server/discover':
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER_INFO,
          },
        },
      };
    case 'initialize': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
      const version = SUPPORTED_VERSIONS.includes(offered) ? offered : '2025-11-25';
      return {
        status: 200,
        body: {
          jsonrpc: '2.0',
          id,
          result: { protocolVersion: version, capabilities: { tools: { listChanged: false } }, serverInfo: SERVER_INFO },
        },
      };
    }
    case 'ping':
      return { status: 200, body: { jsonrpc: '2.0', id, result: {} } };
    case 'tools/list':
      return { status: 200, body: { jsonrpc: '2.0', id, result: { tools: TOOLS } } };
    case 'tools/call': {
      const params = (message.params ?? {}) as Record<string, unknown>;
      const name = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null ? params.arguments : {}) as Record<string, unknown>;
      return toolResultReply(id, callTool(name, args));
    }
    case 'resources/list':
      return { status: 200, body: { jsonrpc: '2.0', id, result: { resources: [] } } };
    case 'prompts/list':
      return { status: 200, body: { jsonrpc: '2.0', id, result: { prompts: [] } } };
    default:
      return { status: 200, body: { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } } };
  }
}

/** Route one POST /mcp request. Auth has already been decided by app.ts. */
export function routeMCP(ctx: Ctx): Reply {
  if (ctx.method !== 'POST') return { status: 405, body: { message: 'Method Not Allowed' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
    };
  }
  if (Array.isArray(parsed)) {
    const replies: unknown[] = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const reply = handleOne(entry as Record<string, unknown>);
      if (reply !== null && reply.body !== undefined) replies.push(reply.body);
    }
    return { status: 200, body: replies };
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Invalid Request' } } };
  }
  const reply = handleOne(parsed as Record<string, unknown>);
  if (reply === null) return { status: 202 };
  return reply;
}

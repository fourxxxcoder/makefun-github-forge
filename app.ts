// The forge's server: one HTTP listener that routes every surface — the health probe,
// git smart HTTP, REST v3, GraphQL v4 and MCP — and enforces the one credential the
// platform issues, the shop token, on everything except the health probe.
//
//   Authorization: Bearer $MAKEFUN_SHOP_TOKEN   (missing or wrong -> 401 JSON)
//
// When the token is not in the environment (a local run), any presented bearer token is
// accepted but an absent one is still a 401: the unauthenticated shape never changes.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { routeGit } from './githttp.ts';
import { routeGraphQL } from './graphql.ts';
import { routeMCP } from './mcp.ts';
import { routeRest } from './rest.ts';
import type { Ctx, Reply } from './web.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 256 * 1024 * 1024;

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(36)}-${Date.now().toString(36)}`;
}

/** Read a request body to the end, with a generous cap (push packs are the big ones). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, reply: Reply, id: string): void {
  const headers: Record<string, string> = { ...(reply.headers ?? {}) };
  if (reply.status === 204) {
    res.writeHead(204, headers);
    res.end();
    return;
  }
  let body: Buffer;
  if (reply.raw !== undefined) {
    body = reply.raw;
    headers['content-type'] = reply.contentType ?? 'application/octet-stream';
  } else if (reply.body !== undefined) {
    body = Buffer.from(`${JSON.stringify(reply.body)}\n`, 'utf8');
    headers['content-type'] = reply.contentType ?? JSON_TYPE;
  } else {
    body = Buffer.alloc(0);
    if (reply.contentType !== undefined) headers['content-type'] = reply.contentType;
  }
  headers['content-length'] = String(body.length);
  headers['x-github-request-id'] = id;
  res.writeHead(reply.status, headers);
  res.end(body);
}

function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  const expected = process.env.MAKEFUN_SHOP_TOKEN ?? '';
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  if (presented === '') return false;
  return expected === '' || presented === expected;
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const id = requestId();
  const url = new URL(req.url ?? '/', 'http://entry');
  const path = url.pathname;
  const segments = path
    .split('/')
    .filter((piece) => piece !== '')
    .map((piece) => {
      try {
        return decodeURIComponent(piece);
      } catch {
        return piece;
      }
    });
  const method = req.method ?? 'GET';

  // The env's boot probe: no auth, always the same answer.
  if (method === 'GET' && path === '/healthz') {
    send(res, { status: 200, body: { ok: true } }, id);
    return;
  }

  const isApi = segments[0] === 'api';
  const isGit = segments.length >= 2 && segments[1].endsWith('.git');
  if (!authorized(req)) {
    send(res, { status: 401, body: { message: 'Requires authentication' } }, id);
    return;
  }

  const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
  const ctx: Ctx = {
    method,
    path,
    segments,
    query: url.searchParams,
    headers: req.headers,
    body,
    host: req.headers.host ?? 'localhost',
  };

  let reply: Reply;
  if (isApi && segments[1] === 'v3') {
    reply = routeRest(ctx, segments.slice(2));
  } else if (isApi && segments[1] === 'graphql' && segments.length === 2) {
    reply = method === 'POST' ? routeGraphQL(ctx) : { status: 405, body: { message: 'Method Not Allowed' } };
  } else if (segments[0] === 'mcp' && segments.length === 1) {
    reply = routeMCP(ctx);
  } else if (isGit) {
    reply = routeGit(ctx, segments[0], segments[1].slice(0, -'.git'.length), segments.slice(2));
  } else {
    reply = { status: 404, body: { message: 'Not Found' } };
  }
  send(res, reply, id);
}

/** Build the server. It binds nothing until the caller listens. */
export function createApp(): Server {
  return createServer((req, res) => {
    handle(req, res).catch(() => {
      try {
        if (!res.headersSent) {
          const text = `${JSON.stringify({ message: 'Internal Server Error' })}\n`;
          res.writeHead(500, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
          res.end(text);
        } else {
          res.end();
        }
      } catch {
        // The socket is already gone; nothing more to do.
      }
    });
  });
}

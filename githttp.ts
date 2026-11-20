// Git smart HTTP: the /<owner>/<repo>.git routes. info/refs advertisements in protocol
// v0 and v2, v2 ls-refs and fetch, v0 fetch, and v0 receive-pack with report-status.
// Repositories come into being only through the REST surface; a push to a name that was
// never created is a 404 here, exactly as the rules require.

import {
  PKT_DELIM,
  PKT_FLUSH,
  ZERO_OID,
  commitTree,
  decodePktLines,
  getObject,
  isAncestor,
  isOid,
  parseCommit,
  parseTree,
  peelToCommit,
  pktLine,
  readPack,
  walkCommits,
  writePack,
  type GitObject,
} from './git.ts';
import { store, type RepoRec } from './store.ts';
import type { Ctx, Reply } from './web.ts';

const AGENT = 'makefun-forge/1.0';

function notFound(): Reply {
  return { status: 404, raw: Buffer.from('repository not found\n'), contentType: 'text/plain; charset=utf-8' };
}

function badRequest(message: string): Reply {
  return { status: 400, raw: Buffer.from(`${message}\n`), contentType: 'text/plain; charset=utf-8' };
}

// ---------------------------------------------------------------- advertisements

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function v2Advertisement(): Reply {
  const lines = [
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow\n',
    'object-format=sha1\n',
  ].map((line) => pktLine(line));
  return {
    status: 200,
    raw: Buffer.concat([...lines, PKT_FLUSH]),
    contentType: 'application/x-git-upload-pack-advertisement',
  };
}

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Reply {
  const caps =
    service === 'git-upload-pack'
      ? `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta shallow deepen-since deepen-not agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`
      : `report-status delete-refs side-band-64k quiet atomic ofs-delta object-format=sha1 agent=${AGENT} symref=HEAD:refs/heads/${repo.defaultBranch}`;
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(Buffer.concat([Buffer.from(`${ZERO_OID} capabilities^{}\0${caps}`, 'utf8')])));
  } else {
    parts.push(pktLine(Buffer.concat([Buffer.from(`${headOid} HEAD\0${caps}`, 'utf8')])));
    for (const [ref, oid] of refs) {
      parts.push(pktLine(`${oid} ${ref}\n`));
      const object = getObject(repo, oid);
      if (object !== null && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
      }
    }
  }
  parts.push(PKT_FLUSH);
  return {
    status: 200,
    raw: Buffer.concat(parts),
    contentType: `application/x-${service}-advertisement`,
  };
}

function infoRefs(ctx: Ctx, repo: RepoRec): Reply {
  const service = ctx.query.get('service');
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return notFound();
  const protocol = ctx.headers['git-protocol'];
  const wantsV2 = typeof protocol === 'string' && protocol.includes('version=2');
  if (service === 'git-upload-pack' && wantsV2) return v2Advertisement();
  return v0Advertisement(repo, service);
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(repo: RepoRec, body: Buffer): Reply {
  const { packets } = decodePktLines(body);
  const args: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (afterDelim) args.push(line);
  }
  const peel = args.includes('peel');
  const symrefs = args.includes('symrefs');
  const unborn = args.includes('unborn');
  const prefixes = args.filter((arg) => arg.startsWith('ref-prefix ')).map((arg) => arg.slice('ref-prefix '.length));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const headRef = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headRef);
  if (keep('HEAD')) {
    if (headOid !== undefined) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    } else {
      lines.push(`${ZERO_OID} HEAD${symrefs ? ` symref-target:${headRef}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!keep(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const object = getObject(repo, oid);
      if (object !== null && object.type === 'tag') {
        const peeled = peelToCommit(repo, oid);
        if (peeled !== null) line += ` peeled:${peeled}`;
      }
    }
    lines.push(line);
  }
  return {
    status: 200,
    raw: Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), PKT_FLUSH]),
    contentType: 'application/x-git-upload-pack-result',
  };
}

// ---------------------------------------------------------------- fetch planning

interface FetchPlan {
  wants: string[];
  haves: string[];
  shallowClient: string[];
  depth: number | null;
}

interface FetchSelection {
  objects: GitObject[];
  shallow: string[];
  unshallow: string[];
}

/** Every tree and blob object under a commit's root tree, minus a skip set. */
function collectTreeObjects(repo: RepoRec, treeOid: string, into: Map<string, GitObject>, skip?: ReadonlySet<string>): void {
  const object = getObject(repo, treeOid);
  if (object === null || object.type !== 'tree' || into.has(treeOid)) return;
  if (skip !== undefined && skip.has(treeOid)) return;
  into.set(treeOid, object);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') collectTreeObjects(repo, entry.oid, into, skip);
    else if (skip === undefined || !skip.has(entry.oid)) {
      const blob = getObject(repo, entry.oid);
      if (blob !== null) into.set(entry.oid, blob);
    }
  }
}

/** Add every tree and blob oid under a root tree to a set. */
function collectTreeOids(repo: RepoRec, treeOid: string, into: Set<string>): void {
  if (into.has(treeOid)) return;
  const object = getObject(repo, treeOid);
  if (object === null || object.type !== 'tree') return;
  into.add(treeOid);
  for (const entry of parseTree(object.data)) {
    if (entry.mode === '40000') collectTreeOids(repo, entry.oid, into);
    else into.add(entry.oid);
  }
}

function selectObjects(repo: RepoRec, plan: FetchPlan): FetchSelection {
  const haveSet = new Set(plan.haves);
  const shallowSet = new Set(plan.shallowClient);
  // Commits the client already holds in full: their whole ancestry is excluded from a
  // plain fetch. With a depth, only the named commits are excluded and the depth window
  // does the rest.
  const excluded = new Set<string>();
  if (plan.depth === null) {
    for (const have of plan.haves) for (const oid of walkCommits(repo, have)) excluded.add(oid);
    for (const boundary of plan.shallowClient) excluded.add(boundary);
  } else {
    for (const have of plan.haves) excluded.add(have);
    for (const boundary of plan.shallowClient) excluded.add(boundary);
  }

  // Breadth-first levels from the wants (through excluded commits too: a deepen fetch
  // walks past the shallow boundary it is extending).
  const level = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const tagObjects = new Map<string, GitObject>();
  const enqueue = (oid: string, at: number): void => {
    const object = getObject(repo, oid);
    if (object === null) return;
    if (object.type === 'tag') {
      tagObjects.set(oid, object);
      const target = peelToCommit(repo, oid);
      if (target !== null) enqueue(target, at);
      return;
    }
    if (object.type !== 'commit') return;
    const known = level.get(oid);
    if (known !== undefined && known <= at) return;
    level.set(oid, at);
    queue.push([oid, at]);
  };
  for (const want of plan.wants) enqueue(want, 1);
  while (queue.length > 0) {
    const [oid, at] = queue.shift() as [string, number];
    if (level.get(oid) !== at) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) enqueue(parent, at + 1);
  }

  // Pass 1: which commits are in the pack.
  const included = new Map<string, GitObject>();
  for (const [oid, at] of level) {
    if (excluded.has(oid)) continue;
    if (plan.depth !== null && at > plan.depth) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    included.set(oid, object);
  }
  // Pass 2: the shallow bookkeeping, against the finished inclusion set.
  const shallowOut = new Set<string>();
  const unshallowOut = new Set<string>();
  if (plan.depth !== null) {
    for (const [oid, at] of level) {
      if (!included.has(oid) || at !== plan.depth) continue;
      const object = getObject(repo, oid);
      if (object === null || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (parents.length > 0 && parents.some((parent) => !included.has(parent))) shallowOut.add(oid);
    }
  }
  // A client shallow boundary whose parent is in this pack stops being shallow.
  for (const boundary of plan.shallowClient) {
    const object = getObject(repo, boundary);
    if (object === null || object.type !== 'commit') continue;
    if (parseCommit(object.data).parents.some((parent) => included.has(parent))) unshallowOut.add(boundary);
  }
  for (const [oid, object] of tagObjects) {
    const target = peelToCommit(repo, oid);
    if (target !== null && included.has(target)) included.set(oid, object);
  }
  // The client already holds every object under its have and shallow-boundary
  // commits; a fetch pack must not re-send any of them (git excludes the whole
  // reachable closure of a "have", trees and blobs included).
  const heldObjects = new Set<string>();
  const heldCommits = plan.depth === null ? [...excluded] : [...plan.haves, ...plan.shallowClient];
  for (const held of heldCommits) {
    const commit = peelToCommit(repo, held);
    if (commit === null) continue;
    heldObjects.add(commit);
    const tree = commitTree(repo, commit);
    if (tree !== null) collectTreeOids(repo, tree, heldObjects);
  }
  const trees = new Map<string, GitObject>();
  for (const object of included.values()) {
    if (object.type !== 'commit') continue;
    const tree = parseCommit(object.data).tree;
    collectTreeObjects(repo, tree, trees, heldObjects);
  }
  const objects: GitObject[] = [];
  for (const object of included.values()) if (object.type === 'commit') objects.push(object);
  for (const object of trees.values()) objects.push(object);
  for (const object of included.values()) if (object.type === 'tag') objects.push(object);
  return { objects, shallow: [...shallowOut], unshallow: [...unshallowOut] };
}

/** Wrap pack bytes in sideband-64k packets (band 1), one progress note first. */
function sidebandPackets(pack: Buffer, progress?: string): Buffer[] {
  const packets: Buffer[] = [];
  if (progress !== undefined) packets.push(pktLine(Buffer.concat([Buffer.from([2]), Buffer.from(progress, 'utf8')])));
  const CHUNK = 65515;
  for (let at = 0; at < pack.length; at += CHUNK) {
    packets.push(pktLine(Buffer.concat([Buffer.from([1]), pack.subarray(at, at + CHUNK)])));
  }
  if (pack.length === 0) packets.push(pktLine(Buffer.from([1])));
  return packets;
}

function parseFetchArgs(lines: readonly string[]): FetchPlan {
  const plan: FetchPlan = { wants: [], haves: [], shallowClient: [], depth: null };
  for (const line of lines) {
    if (line.startsWith('want ')) plan.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) plan.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) plan.shallowClient.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isFinite(depth) && depth > 0) plan.depth = Math.floor(depth);
    }
  }
  return plan;
}

function fetchV2(repo: RepoRec, body: Buffer): Reply {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  let afterDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'delim') {
      afterDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    if (afterDelim) lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  const plan = parseFetchArgs(lines);
  const selection = selectObjects(repo, plan);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  if (plan.haves.length > 0) {
    parts.push(pktLine('acknowledgments\n'));
    const common = plan.haves.find((have) => {
      const object = getObject(repo, have);
      return object !== null && object.type === 'commit';
    });
    parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
    parts.push(PKT_DELIM);
  }
  if (selection.shallow.length > 0 || selection.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

function fetchV0(repo: RepoRec, body: Buffer): Reply {
  const { packets } = decodePktLines(body);
  const lines: string[] = [];
  for (const packet of packets) {
    if (packet.kind !== 'data') continue;
    lines.push(packet.payload.toString('utf8').replace(/\n$/, '').split('\0')[0]);
  }
  const plan = parseFetchArgs(lines);
  const selection = selectObjects(repo, plan);
  const pack = writePack(selection.objects);
  const parts: Buffer[] = [];
  for (const oid of selection.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of selection.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const common = plan.haves.find((have) => {
    const object = getObject(repo, have);
    return object !== null && object.type === 'commit';
  });
  parts.push(pktLine(common !== undefined ? `ACK ${common}\n` : 'NAK\n'));
  parts.push(...sidebandPackets(pack));
  parts.push(PKT_FLUSH);
  return { status: 200, raw: Buffer.concat(parts), contentType: 'application/x-git-upload-pack-result' };
}

function uploadPack(repo: RepoRec, body: Buffer): Reply {
  const { packets } = decodePktLines(body);
  const first = packets.find((packet) => packet.kind === 'data');
  const command = first?.kind === 'data' ? first.payload.toString('utf8').replace(/\n$/, '') : '';
  if (command === 'command=ls-refs') return lsRefs(repo, body);
  if (command === 'command=fetch') return fetchV2(repo, body);
  // No command line: a protocol v0 fetch request.
  return fetchV0(repo, body);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

function receivePack(repo: RepoRec, body: Buffer): Reply {
  const { packets, next } = decodePktLines(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const parts = line.split(' ');
    if (parts.length >= 3 && isOid(parts[0]) && isOid(parts[1])) {
      commands.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(next);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes, (oid) => getObject(repo, oid));
      for (const [oid, object] of objects) if (!repo.objects.has(oid)) repo.objects.set(oid, object);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : 'unpack failed';
    }
  }
  const useSideband = capabilities.split(' ').includes('side-band-64k');
  const reportLines: string[] = [`unpack ${unpackError === null ? 'ok' : unpackError}\n`];
  for (const command of commands) {
    if (unpackError !== null) {
      reportLines.push(`ng ${command.ref} unpacker error\n`);
      continue;
    }
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} reference lock failed\n`);
      continue;
    }
    if (command.newOid === ZERO_OID) {
      repo.refs.delete(command.ref);
      reportLines.push(`ok ${command.ref}\n`);
      continue;
    }
    const target = getObject(repo, command.newOid);
    if (target === null || (target.type !== 'commit' && target.type !== 'tag')) {
      reportLines.push(`ng ${command.ref} new object is not a commit\n`);
      continue;
    }
    if (command.ref.startsWith('refs/heads/') && command.oldOid !== ZERO_OID) {
      const newCommit = peelToCommit(repo, command.newOid);
      if (newCommit === null || !isAncestor(repo, command.oldOid, newCommit)) {
        reportLines.push(`ng ${command.ref} non-fast-forward\n`);
        continue;
      }
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  const reportStream = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  let raw: Buffer;
  if (useSideband) {
    // The whole pkt-lined report (its own flush included) rides inside band 1; one
    // final flush ends the sideband stream itself.
    const packetsOut: Buffer[] = [];
    const CHUNK = 65515;
    for (let at = 0; at < reportStream.length; at += CHUNK) {
      packetsOut.push(pktLine(Buffer.concat([Buffer.from([1]), reportStream.subarray(at, at + CHUNK)])));
    }
    packetsOut.push(PKT_FLUSH);
    raw = Buffer.concat(packetsOut);
  } else {
    raw = reportStream;
  }
  return { status: 200, raw, contentType: 'application/x-git-receive-pack-result' };
}

// ---------------------------------------------------------------- router

/** Route one /<owner>/<repo>.git request; `tail` is what follows the .git segment. */
export function routeGit(ctx: Ctx, owner: string, repoName: string, tail: readonly string[]): Reply {
  const repo = store.getRepo(owner, repoName);
  if (repo === null) return notFound();
  try {
    if (tail.length === 2 && tail[0] === 'info' && tail[1] === 'refs' && ctx.method === 'GET') return infoRefs(ctx, repo);
    if (tail.length === 1 && tail[0] === 'git-upload-pack' && ctx.method === 'POST') return uploadPack(repo, ctx.body);
    if (tail.length === 1 && tail[0] === 'git-receive-pack' && ctx.method === 'POST') return receivePack(repo, ctx.body);
    return notFound();
  } catch {
    // A malformed body must never take the server down (the suite probes exactly that).
    return badRequest('bad request');
  }
}

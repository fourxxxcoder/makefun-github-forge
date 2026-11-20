// The git object model and wire codecs, stdlib only: SHA-1 object ids, loose-object
// storage inside the repo record, tree flatten/rebuild helpers for the contents API and
// pull-request merges, packfile read/write (plain objects out; plain, OFS_DELTA and
// REF_DELTA in), and the pkt-line framing every smart-HTTP exchange speaks.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { GitObject, GitObjectType, RepoRec } from './store.ts';

export const ZERO_OID = '0'.repeat(40);
const EMPTY_TREE_OID = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

export function isOid(text: string): boolean {
  return /^[0-9a-f]{40}$/.test(text);
}

/** The object id of a would-be object: sha1 of "<type> <size>\0" over its bytes. */
export function oidOf(type: GitObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store an object in the repo and return its id (idempotent). */
export function putObject(repo: RepoRec, type: GitObjectType, data: Buffer): string {
  const oid = oidOf(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function getObject(repo: RepoRec, oid: string): GitObject | null {
  return repo.objects.get(oid) ?? null;
}

// ---------------------------------------------------------------- commits

export interface CommitRec {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's bytes. Throws on a malformed object. */
export function parseCommit(data: Buffer): CommitRec {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

/** Serialise a commit. `whenSec` is a unix timestamp used for both idents. */
export function formatCommit(input: {
  tree: string;
  parents: readonly string[];
  message: string;
  name: string;
  email: string;
  whenSec: number;
}): Buffer {
  const ident = `${input.name} <${input.email}> ${input.whenSec} +0000`;
  const lines = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`, `committer ${ident}`, '', input.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** The tree oid a commit points at, or null when the object is not a commit we hold. */
export function commitTree(repo: RepoRec, commitOid: string): string | null {
  const object = getObject(repo, commitOid);
  if (object === null || object.type !== 'commit') return null;
  return parseCommit(object.data).tree;
}

/** Peel an oid to the commit it names (through annotated tags); null when it never lands. */
export function peelToCommit(repo: RepoRec, oid: string): string | null {
  let current = oid;
  for (let hops = 0; hops < 16; hops += 1) {
    const object = getObject(repo, current);
    if (object === null) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      const match = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'));
      if (match === null) return null;
      current = match[1];
      continue;
    }
    return null;
  }
  return null;
}

/** Every commit reachable from `tip`, newest first (breadth-first over parents). */
export function walkCommits(repo: RepoRec, tip: string): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const queue: string[] = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return order;
}

/** True when `ancestor` is reachable from `descendant` (or equal to it). */
export function isAncestor(repo: RepoRec, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const queue: string[] = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = getObject(repo, oid);
    if (object === null || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(repo: RepoRec, a: string, b: string): string | null {
  const fromA = new Set(walkCommits(repo, a));
  for (const candidate of walkCommits(repo, b)) {
    if (fromA.has(candidate)) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's bytes into its entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space);
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: by name, directories as if their name ended in '/'. */
function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

/** Serialise tree entries (sorting them the way git does) into an object body. */
export function formatTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** One flattened file: a blob oid and the mode it sits under. */
export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree (by oid) into a path -> blob map. */
export function flattenTree(repo: RepoRec, treeOid: string, prefix = '', out = new Map<string, FlatEntry>()): Map<string, FlatEntry> {
  const object = getObject(repo, treeOid);
  if (object === null || object.type !== 'tree') return out;
  for (const entry of parseTree(object.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(repo, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

/** Rebuild (and store) a tree hierarchy from a flattened path map; returns the root oid. */
export function treeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, FlatEntry>): string {
  interface Node {
    files: Map<string, FlatEntry>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, entry] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      let next = node.dirs.get(parts[i]);
      if (next === undefined) {
        next = { files: new Map(), dirs: new Map() };
        node.dirs.set(parts[i], next);
      }
      node = next;
    }
    node.files.set(parts[parts.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, dir] of node.dirs) entries.push({ mode: '40000', name, oid: build(dir) });
    return putObject(repo, 'tree', formatTree(entries));
  };
  return build(root);
}

/**
 * Set (or, with blobOid null, delete) one path inside a tree, returning the new root tree
 * oid. Intermediate trees are created as needed; emptied directories are pruned.
 */
export function setTreePath(repo: RepoRec, treeOid: string | null, parts: readonly string[], blob: FlatEntry | null): string {
  const flat = treeOid === null ? new Map<string, FlatEntry>() : flattenTree(repo, treeOid);
  const path = parts.join('/');
  if (blob === null) flat.delete(path);
  else flat.set(path, blob);
  if (flat.size === 0) return putObject(repo, 'tree', Buffer.alloc(0));
  return treeFromFlat(repo, flat);
}

/** The empty tree's oid, stored on demand. */
export function emptyTree(repo: RepoRec): string {
  if (!repo.objects.has(EMPTY_TREE_OID)) repo.objects.set(EMPTY_TREE_OID, { type: 'tree', data: Buffer.alloc(0) });
  return EMPTY_TREE_OID;
}

// ---------------------------------------------------------------- refs

/** Resolve a branch name, full ref, HEAD or raw oid to a commit oid; null when unknown. */
export function resolveRef(repo: RepoRec, ref: string): string | null {
  if (ref === 'HEAD') {
    const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
    return tip === undefined ? null : peelToCommit(repo, tip);
  }
  const full = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const direct = repo.refs.get(full);
  if (direct !== undefined) return peelToCommit(repo, direct);
  if (isOid(ref)) {
    const object = getObject(repo, ref);
    if (object !== null && object.type === 'commit') return ref;
  }
  return null;
}

/** The default branch's tip commit, or null on an unborn repository. */
export function defaultTip(repo: RepoRec): string | null {
  const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  return tip === undefined ? null : peelToCommit(repo, tip);
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPE_IDS: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_ID_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a version-2 pack of plain (undeltified) objects, with its SHA-1 trailer. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const object of objects) {
    // Type+size varint: low 4 bits of size in the first byte beside the 3-bit type.
    let size = object.data.length;
    const bytes: number[] = [];
    let first = (PACK_TYPE_IDS[object.type] << 4) | (size & 0x0f);
    size >>= 4;
    while (size > 0) {
      bytes.push(first | 0x80);
      first = size & 0x7f;
      size >>= 7;
    }
    bytes.push(first);
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Apply a git delta buffer to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  while (offset < delta.length) {
    const cmd = delta[offset];
    offset += 1;
    if (cmd & 0x80) {
      let at = 0;
      let size = 0;
      for (let bit = 0; bit < 4; bit += 1) if (cmd & (1 << bit)) { at |= delta[offset] << (8 * bit); offset += 1; }
      for (let bit = 0; bit < 3; bit += 1) if (cmd & (0x10 << bit)) { size |= delta[offset] << (8 * bit); offset += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(at, at + size));
    } else if (cmd > 0) {
      out.push(delta.subarray(offset, offset + cmd));
      offset += cmd;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

/**
 * Inflate one pack entry whose deflate stream starts at `start` and whose inflated size
 * must be `expectedSize`. Node's one-shot inflate ignores trailing bytes but throws on a
 * truncated stream, so "inflates to exactly expectedSize" is monotone in the slice end
 * and the stream's true end is the first end for which it holds: binary-search it.
 */
export function inflateEntry(pack: Buffer, start: number, expectedSize: number): { data: Buffer; nextOffset: number } {
  const maxEnd = pack.length;
  const works = (end: number): boolean => {
    try {
      return inflateSync(pack.subarray(start, end)).length === expectedSize;
    } catch {
      return false;
    }
  };
  let lo = start + 1;
  let hi = maxEnd;
  if (!works(hi)) throw new Error('pack entry does not inflate');
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (works(mid)) hi = mid;
    else lo = mid + 1;
  }
  return { data: inflateSync(pack.subarray(start, lo)), nextOffset: lo };
}

/**
 * Read a packfile into an object map. `resolveBase` supplies objects the pack deltas
 * against but does not carry (thin packs); plain packs never call it.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | null): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    let byte = pack[offset];
    offset += 1;
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeId === 6) {
      // OFS_DELTA: a negative offset back to the base entry.
      let back = pack[offset];
      offset += 1;
      let value = back & 0x7f;
      while (back & 0x80) {
        back = pack[offset];
        offset += 1;
        value = ((value + 1) << 7) | (back & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeId === 7) {
      baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const { data: inflated, nextOffset } = inflateEntry(pack, offset, size);
    offset = nextOffset;
    let object: GitObject;
    if (typeId === 6 || typeId === 7) {
      const base = typeId === 6 ? byOffset.get(baseOffset) : objects.get(baseOid as string) ?? resolveBase?.(baseOid as string) ?? null;
      if (base === null || base === undefined) throw new Error('delta base is missing');
      object = { type: base.type, data: applyDelta(base.data, inflated) };
    } else {
      const type = PACK_ID_TYPES[typeId];
      if (type === undefined) throw new Error(`unknown pack object type ${typeId}`);
      object = { type, data: inflated };
    }
    objects.set(oidOf(object.type, object.data), object);
    byOffset.set(start, object);
  }
  return objects;
}

// ---------------------------------------------------------------- pkt-lines

/** Encode one pkt-line (4-hex length prefix, length includes the prefix itself). */
export function pktLine(payload: Buffer | string): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export type PktPacket =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'response-end' };

/**
 * Decode every complete pkt-line in `buf`. Returns the packets and the number of bytes
 * consumed, so a caller can hand the remainder (a receive-pack packfile) to readPack.
 * A trailing partial packet is left unconsumed; malformed framing throws.
 */
export function decodePktLines(buf: Buffer, from = 0): { packets: PktPacket[]; next: number } {
  const packets: PktPacket[] = [];
  let offset = from;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    // Not a length at all: the pkt-line section is over. This is how a receive-pack
    // body announces its packfile, and how a malformed probe body ends — both are
    // stops, not errors.
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, next: offset };
}

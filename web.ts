// The HTTP plumbing shared by every surface: one request context in, one reply
// descriptor out. app.ts owns the socket; the surface modules own their routes.

export interface Ctx {
  method: string;
  /** The decoded URL path, e.g. /api/v3/repos/adaiversen/demo/contents/a.txt */
  path: string;
  /** The path split into segments (no empty entries). */
  segments: string[];
  query: URLSearchParams;
  headers: Readonly<Record<string, string | string[] | undefined>>;
  /** The raw request body (empty for bodyless requests). */
  body: Buffer;
  /** The Host header, for building absolute pagination links on our own origin. */
  host: string;
}

export interface Reply {
  status: number;
  /** A JSON-serialisable body; undefined means an empty body. */
  body?: unknown;
  headers?: Record<string, string>;
  /** Raw bytes instead of a JSON body (git smart HTTP). */
  raw?: Buffer;
  contentType?: string;
}

export function jsonReply(status: number, body: unknown, headers: Record<string, string> = {}): Reply {
  return { status, body, headers };
}

export function errorReply(status: number, message: string): Reply {
  return { status, body: { message } };
}

/** Parse the request body as a JSON object; null when it is not one. */
export function bodyJson(ctx: Ctx): Record<string, unknown> | null {
  if (ctx.body.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(ctx.body.toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function bool(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function strList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === 'string') out.push(entry);
    else if (typeof entry === 'object' && entry !== null && typeof (entry as { name?: unknown }).name === 'string') {
      out.push((entry as { name: string }).name);
    }
  }
  return out;
}

export interface Page<T> {
  items: T[];
  link: string | null;
}

/**
 * GitHub-style pagination: per_page (default 30, max 100) and page (default 1), with a
 * Link header whose rel="next" stays on this origin so clients may follow it.
 */
export function paginate<T>(ctx: Ctx, all: readonly T[], basePath: string): Page<T> {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '30');
  const pageRaw = Number(ctx.query.get('page') ?? '1');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : 30;
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const start = (page - 1) * perPage;
  const items = all.slice(start, start + perPage);
  const lastPage = Math.max(1, Math.ceil(all.length / perPage));
  const url = (p: number): string => {
    const params = new URLSearchParams(ctx.query);
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `http://${ctx.host}${basePath}?${params.toString()}`;
  };
  const links: string[] = [];
  if (page < lastPage) {
    links.push(`<${url(page + 1)}>; rel="next"`);
    links.push(`<${url(lastPage)}>; rel="last"`);
  }
  if (page > 1) {
    links.push(`<${url(1)}>; rel="first"`);
    links.push(`<${url(page - 1)}>; rel="prev"`);
  }
  return { items, link: links.length > 0 ? links.join(', ') : null };
}

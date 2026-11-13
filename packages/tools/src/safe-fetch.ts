import type { LookupAddress, LookupOptions } from 'node:dns';

import ipaddr from 'ipaddr.js';

/**
 * Fetching a page the model asked for is the riskiest thing the assistant
 * does: a URL could point at the router, a cloud metadata service or Ollama on
 * loopback. Every hop is checked here (ADR-0008).
 */

export type SafeFetchError =
  | 'invalid_url'
  | 'blocked_address'
  | 'too_many_redirects'
  | 'too_large'
  | 'unsupported_type'
  | 'http_error'
  | 'timeout'
  | 'unavailable';

export class SafeFetchFailure extends Error {
  constructor(readonly reason: SafeFetchError) {
    super(`safe fetch failed: ${reason}`);
    this.name = 'SafeFetchFailure';
  }
}

export type Resolve = (host: string) => Promise<readonly LookupAddress[]>;

/** Public unicast only, with IPv4-mapped IPv6 unwrapped first; for IPv6 also inside 2000::/3. */
export function isPublicAddress(address: string): boolean {
  if (!ipaddr.isValid(address)) return false;
  // process() turns IPv4-mapped IPv6 (::ffff:127.0.0.1) back into IPv4 first.
  const parsed = ipaddr.process(address);
  if (parsed.range() !== 'unicast') return false;
  if (parsed.kind() === 'ipv4') return true;
  // 2000::/3: the first 16-bit group is 0x2000 to 0x3fff.
  const first = parseInt(parsed.toNormalizedString().split(':')[0] ?? '0', 16);
  return first >= 0x2000 && first <= 0x3fff;
}

/**
 * Checks a URL before any connection: https, port 443, no user info, and a
 * host name rather than an IP literal, because undici does not call the
 * custom lookup for IP literals.
 */
export function checkUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchFailure('invalid_url');
  }
  if (url.protocol !== 'https:') throw new SafeFetchFailure('invalid_url');
  if (url.port !== '' && url.port !== '443') throw new SafeFetchFailure('invalid_url');
  if (url.username !== '' || url.password !== '') throw new SafeFetchFailure('invalid_url');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (ipaddr.isValid(host) || /^[\d.]+$/.test(host) || !host.includes('.')) {
    throw new SafeFetchFailure('invalid_url');
  }
  return url;
}

/** Resolves a host and rejects it if any of its addresses is not public. */
export async function resolvePublic(
  resolve: Resolve,
  host: string,
): Promise<readonly LookupAddress[]> {
  let addresses: readonly LookupAddress[];
  try {
    addresses = await resolve(host);
  } catch {
    throw new SafeFetchFailure('unavailable');
  }
  if (addresses.length === 0 || !addresses.every((a) => isPublicAddress(a.address))) {
    throw new SafeFetchFailure('blocked_address');
  }
  return addresses;
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/**
 * A `lookup` for undici's connector. The address checked is the address the
 * socket connects to, so a DNS answer cannot change between check and connect.
 */
export function createGuardedLookup(resolve: Resolve) {
  return (hostname: string, options: LookupOptions, callback: LookupCallback): void => {
    resolvePublic(resolve, hostname).then(
      (addresses) => {
        if (options.all === true) {
          callback(null, [...addresses]);
          return;
        }
        const first = addresses[0];
        if (first === undefined) {
          callback(Object.assign(new Error('no address'), { code: 'ENOTFOUND' }), '');
          return;
        }
        callback(null, first.address, first.family);
      },
      (err: unknown) => {
        const error: NodeJS.ErrnoException = Object.assign(new Error('blocked address'), {
          code: 'EBLOCKED',
          cause: err,
        });
        callback(error, '');
      },
    );
  };
}

export interface FetchedPage {
  readonly url: string;
  readonly contentType: string;
  readonly body: string;
}

/** The parts of a response this module reads, met by both undici's and the global Response. */
export interface HopResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly headers: { get(name: string): string | null };
  readonly body: ByteStream | null;
}

/** The reader interface shared by web streams from undici and from the global fetch. */
export interface ByteStream {
  getReader(): {
    read(): Promise<ReadableStreamReadResult<Uint8Array>>;
    cancel(reason?: unknown): Promise<void>;
  };
  cancel(reason?: unknown): Promise<void>;
}

/** One request with redirects left to the caller, so tests can stand in for the network. */
export type HopFetch = (url: string, signal: AbortSignal) => Promise<HopResponse>;

export interface SafeFetchConfig {
  readonly resolve: Resolve;
  /** One request with redirects left to the caller, made through the guarded connector. */
  readonly hop: HopFetch;
  readonly maxRedirects?: number;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
}

const allowedTypes = new Set(['text/html', 'application/xhtml+xml', 'text/plain']);

async function readLimited(res: HopResponse, maxBytes: number): Promise<Uint8Array> {
  if (res.body === null) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new SafeFetchFailure('too_large');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1] ?? 'utf-8';
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder('utf-8').decode(bytes);
  }
}

function causedByBlockedLookup(err: unknown): boolean {
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current instanceof Error; depth++) {
    if ('code' in current && current.code === 'EBLOCKED') return true;
    current = current.cause;
  }
  return false;
}

export type SafeFetch = (url: string, signal: AbortSignal) => Promise<FetchedPage>;

export function createSafeFetch(config: SafeFetchConfig): SafeFetch {
  const maxRedirects = config.maxRedirects ?? 3;
  const maxBytes = config.maxBytes ?? 1024 * 1024;
  const timeoutMs = config.timeoutMs ?? 8_000;

  return async (raw, callerSignal) => {
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = AbortSignal.any([callerSignal, timeout]);
    let current = raw;
    try {
      for (let hop = 0; hop <= maxRedirects; hop++) {
        const url = checkUrl(current);
        // Checked here and again at connect time by the guarded lookup.
        await resolvePublic(config.resolve, url.hostname);
        const res = await config.hop(url.toString(), signal);
        if (res.status >= 300 && res.status < 400) {
          await res.body?.cancel().catch(() => undefined);
          const location = res.headers.get('location');
          if (location === null) throw new SafeFetchFailure('http_error');
          current = new URL(location, url).toString();
          continue;
        }
        if (!res.ok) {
          await res.body?.cancel().catch(() => undefined);
          throw new SafeFetchFailure('http_error');
        }
        const contentType = (res.headers.get('content-type') ?? '').toLowerCase();
        const mime = contentType.split(';')[0]?.trim() ?? '';
        if (!allowedTypes.has(mime)) {
          await res.body?.cancel().catch(() => undefined);
          throw new SafeFetchFailure('unsupported_type');
        }
        const bytes = await readLimited(res, maxBytes);
        return { url: url.toString(), contentType: mime, body: decode(bytes, contentType) };
      }
      throw new SafeFetchFailure('too_many_redirects');
    } catch (err) {
      if (callerSignal.aborted) throw err;
      if (err instanceof SafeFetchFailure) throw err;
      // The guarded lookup refused the address at connect time: a DNS answer
      // that changed after the first check, which is worth reporting as such.
      if (causedByBlockedLookup(err)) throw new SafeFetchFailure('blocked_address');
      if (timeout.aborted) throw new SafeFetchFailure('timeout');
      throw new SafeFetchFailure('unavailable');
    }
  };
}

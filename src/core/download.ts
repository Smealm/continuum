import { createHash } from 'crypto';
import * as fs from 'fs';
import * as http from 'http';
import * as https from 'https';
import * as path from 'path';
import { URL } from 'url';

export interface FetchOptions {
  signal?: AbortSignal;
  onProgress?: (received: number, total: number | null) => void;
  expectedSha256?: string;
  timeoutMs?: number;
  userAgent?: string;
}

export interface FetchResult {
  bytes: number;
  sha256?: string;
}

const MAX_REDIRECTS = 6;
const DEFAULT_TIMEOUT_MS = 60_000;
/** A server cannot ask us to stay away for longer than a day. */
const MAX_RETRY_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Identifies Continuum to the archive operators. It is deliberately stable and
 * versioned, so a host can tell Continuum apart from a browser and block it if
 * the extension ever asks for more than the archive is willing to give. The
 * project URL is where an operator can find out what this client is.
 *
 * Bump the version with the extension version. Changing this string to hide the
 * client would defeat the point of having one.
 */
export const CONTINUUM_USER_AGENT =
  'Continuum/0.4.0 (Flashpoint Infinity extension; +https://github.com/Smealm/continuum)';

/**
 * One agent for all archive traffic, so a run of small packs reuses its
 * connections instead of paying a TCP (and TLS) handshake per file. The socket
 * ceiling is above the maximum worker count; the workers decide concurrency.
 */
const HTTP_AGENT = new http.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });
const HTTPS_AGENT = new https.Agent({ keepAlive: true, maxSockets: 32, maxFreeSockets: 8 });

/** Close pooled sockets, e.g. so a test server can shut down promptly. */
export function closeDownloadConnections(): void {
  HTTP_AGENT.destroy();
  HTTPS_AGENT.destroy();
}

export class HttpStatusError extends Error {
  constructor(
    public readonly status: number,
    public readonly url: string,
    /** Milliseconds the server asked us to wait (`Retry-After`), if it said. */
    public readonly retryAfterMs?: number,
  ) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 404;
}

/**
 * The host did not simply fail: it told us we are not allowed to download. This
 * is the signal a blacklist produces, so it is never retried automatically.
 */
export function isPermissionDenied(error: unknown): boolean {
  return error instanceof HttpStatusError && (error.status === 401 || error.status === 403);
}

/** Parse `Retry-After` (delta seconds or an HTTP date) into milliseconds. */
export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number | undefined {
  if (!value) {
    return undefined;
  }
  const raw = (Array.isArray(value) ? value[0] : value).trim();
  if (!raw) {
    return undefined;
  }
  // Only digits are a delta; `Date.parse('-5')` would invent a year, so a
  // value that is neither plain seconds nor an HTTP date is ignored.
  if (/^\d+(?:\.\d+)?$/.test(raw)) {
    return Math.min(Number(raw) * 1000, MAX_RETRY_AFTER_MS);
  }
  if (!/^[A-Za-z]/.test(raw)) {
    return undefined;
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return Math.min(Math.max(0, at - now), MAX_RETRY_AFTER_MS);
}

export function retryAfterMsOf(error: unknown): number | undefined {
  return error instanceof HttpStatusError ? error.retryAfterMs : undefined;
}

/** Download a URL into `destPath`, writing to a sibling `.part` file first. */
export async function fetchToFile(
  url: string,
  destPath: string,
  options: FetchOptions = {},
): Promise<FetchResult> {
  const partPath = `${destPath}.part`;
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });

  try {
    const result = await requestToFile(url, partPath, options, 0);
    if (options.expectedSha256) {
      const expected = options.expectedSha256.trim().toLowerCase();
      if (result.sha256 && result.sha256 !== expected) {
        throw new Error(
          `Hash of download does not match (expected ${expected.slice(0, 12)}..., got ${result.sha256.slice(0, 12)}...)`,
        );
      }
    }
    await fs.promises.rename(partPath, destPath);
    return result;
  } catch (error) {
    await fs.promises.unlink(partPath).catch(() => undefined);
    throw error;
  }
}

function requestToFile(
  url: string,
  partPath: string,
  options: FetchOptions,
  redirects: number,
): Promise<FetchResult> {
  if (redirects > MAX_REDIRECTS) {
    return Promise.reject(new Error(`Too many redirects while fetching ${url}`));
  }

  return new Promise<FetchResult>((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error(`Invalid URL: ${url}`));
      return;
    }
    const transport = parsed.protocol === 'http:' ? http : parsed.protocol === 'https:' ? https : null;
    if (!transport) {
      reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
      return;
    }

    const hash = createHash('sha256');
    let sink: fs.WriteStream | null = null;
    let settled = false;
    let received = 0;

    const fail = (error: Error): void => {
      if (settled) {
        return;
      }
      settled = true;
      request.destroy();
      if (sink) {
        sink.destroy();
      }
      reject(error);
    };

    const request = transport.request(
      parsed,
      {
        method: 'GET',
        headers: {
          'User-Agent': options.userAgent || CONTINUUM_USER_AGENT,
          'Accept': '*/*',
        },
        agent: transport === http ? HTTP_AGENT : HTTPS_AGENT,
      },
      (response) => {
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          settled = true;
          response.resume();
          const nextUrl = new URL(response.headers.location as string, parsed).href;
          requestToFile(nextUrl, partPath, options, redirects + 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          response.resume();
          fail(new HttpStatusError(
            status,
            parsed.href,
            parseRetryAfter(response.headers['retry-after']),
          ));
          return;
        }

        sink = fs.createWriteStream(partPath);
        const stream = sink;
        if (options.signal) {
          stream.once('close', () => options.signal?.removeEventListener('abort', onAbort));
        }
        const lengthHeader = response.headers['content-length'];
        const total = lengthHeader ? Number.parseInt(lengthHeader, 10) : NaN;
        const totalBytes = Number.isFinite(total) ? total : null;

        response.on('data', (chunk: Buffer) => {
          received += chunk.length;
          hash.update(chunk);
          if (!stream.write(chunk)) {
            response.pause();
            stream.once('drain', () => response.resume());
          }
          if (options.onProgress) {
            options.onProgress(received, totalBytes);
          }
        });

        response.on('end', () => {
          if (!settled) {
            stream.end();
          }
        });

        response.on('error', (error) => fail(error));
        stream.on('error', (error) => fail(error));
        stream.on('finish', () => {
          if (settled) {
            return;
          }
          settled = true;
          resolve({ bytes: received, sha256: hash.digest('hex') });
        });
      },
    );

    request.on('error', (error) => fail(error));
    request.setTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, () => {
      fail(new Error(`Timed out while fetching ${parsed.href}`));
    });

    const onAbort = (): void => fail(new Error('Download aborted'));
    if (options.signal) {
      if (options.signal.aborted) {
        onAbort();
        return;
      }
      options.signal.addEventListener('abort', onAbort, { once: true });
    }

    request.end();
  });
}

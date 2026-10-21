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
const DEFAULT_UA = 'Continuum/0.1 (Flashpoint Infinity mirroring extension)';

export class HttpStatusError extends Error {
  constructor(public readonly status: number, url: string) {
    super(`HTTP ${status} for ${url}`);
    this.name = 'HttpStatusError';
  }
}

export function isNotFound(error: unknown): boolean {
  return error instanceof HttpStatusError && error.status === 404;
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
          'User-Agent': options.userAgent || DEFAULT_UA,
          'Accept': '*/*',
        },
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
          fail(new HttpStatusError(status, parsed.href));
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

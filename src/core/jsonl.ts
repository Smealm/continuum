import * as fsp from 'fs/promises';

/**
 * Streaming reader for newline-delimited JSON that can report and resume from
 * an exact byte offset. The catalogue is a JSONL file so a 220k game index can
 * be walked without loading it all into memory.
 */
export class JsonlCursor<T> {
  private handle: fsp.FileHandle | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  /** Absolute file offset just past the end of `buffer`. */
  private position: number;
  private eof = false;

  constructor(
    private readonly filePath: string,
    startOffset = 0,
    private readonly chunkSize = 256 * 1024,
  ) {
    this.position = Math.max(0, startOffset);
  }

  /** Offset of the next unread record. Safe to persist for resuming. */
  get offset(): number {
    return this.position - this.buffer.length;
  }

  /** Reposition to an absolute byte offset. Used to jump to playlist games. */
  seek(offset: number): void {
    this.position = Math.max(0, offset);
    this.buffer = Buffer.alloc(0);
    this.eof = false;
  }

  async next(): Promise<{ value: T; offset: number; startOffset: number } | null> {
    if (!this.handle) {
      this.handle = await fsp.open(this.filePath, 'r');
    }
    for (;;) {
      const newline = this.buffer.indexOf(0x0a);
      if (newline >= 0) {
        const start = this.offset;
        const line = this.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        this.buffer = this.buffer.subarray(newline + 1);
        if (!line.trim()) {
          continue;
        }
        return { value: JSON.parse(line) as T, offset: this.offset, startOffset: start };
      }

      if (this.eof) {
        if (this.buffer.length === 0) {
          return null;
        }
        const start = this.offset;
        const line = this.buffer.toString('utf8').replace(/\r$/, '');
        this.buffer = Buffer.alloc(0);
        if (!line.trim()) {
          return null;
        }
        return { value: JSON.parse(line) as T, offset: this.offset, startOffset: start };
      }

      await this.fill();
    }
  }

  private async fill(): Promise<void> {
    if (!this.handle) {
      this.handle = await fsp.open(this.filePath, 'r');
    }
    const chunk = Buffer.alloc(this.chunkSize);
    const { bytesRead } = await this.handle.read(chunk, 0, chunk.length, this.position);
    if (bytesRead <= 0) {
      this.eof = true;
      return;
    }
    this.position += bytesRead;
    this.buffer = this.buffer.length === 0
      ? chunk.subarray(0, bytesRead)
      : Buffer.concat([this.buffer, chunk.subarray(0, bytesRead)]);
  }

  async close(): Promise<void> {
    if (this.handle) {
      const handle = this.handle;
      this.handle = null;
      await handle.close();
    }
  }
}

export async function appendJsonl(filePath: string, value: unknown): Promise<void> {
  await fsp.appendFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

export async function readJson<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fsp.readFile(filePath, 'utf8');
    return JSON.parse(raw) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
      return null;
    }
    throw error;
  }
}

export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const temp = `${filePath}.tmp`;
  await fsp.writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fsp.rename(temp, filePath);
}

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { JobResultFileSchema, RESULT_MAX_BYTES, type JobResultFile } from '@ducky/contracts';

export const RESULT_RELATIVE_PATH = path.join('.ducky', 'result.json');

export interface ResultReader {
  read(workspacePath: string): Promise<JobResultFile | undefined>;
}

/** Reads and validates `<workspace>/.ducky/result.json`, or returns undefined. */
export class FileResultReader implements ResultReader {
  async read(workspacePath: string): Promise<JobResultFile | undefined> {
    let raw: string;
    try {
      raw = await readFile(path.join(workspacePath, RESULT_RELATIVE_PATH), 'utf8');
    } catch {
      return undefined;
    }
    if (Buffer.byteLength(raw, 'utf8') > RESULT_MAX_BYTES) return undefined;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return undefined;
    }
    const result = JobResultFileSchema.safeParse(parsed);
    return result.success ? result.data : undefined;
  }
}

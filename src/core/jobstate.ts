import { readJson, writeJsonAtomic } from './jsonl';
import { JobState } from './types';

export const INTERRUPTED_MESSAGE =
  'Interrupted: the launcher closed while a download was running. Progress was kept.';

/**
 * A job that was running when the launcher was killed (or crashed) is left with
 * `status: "running"` in job.json, because the process never got to write a
 * terminal status. Rewrite it as stopped so the manager does not claim a
 * download is happening while nothing is running, and so auto-resume sees a
 * consistent state.
 *
 * Returns true when the file was changed.
 */
export async function markInterruptedJob(jobFile: string, now = Date.now()): Promise<boolean> {
  const job = await readJson<JobState>(jobFile);
  if (!job || job.status !== 'running') {
    return false;
  }
  const updated: JobState = {
    ...job,
    status: 'stopped',
    message: INTERRUPTED_MESSAGE,
    updatedAt: new Date(now).toISOString(),
  };
  await writeJsonAtomic(jobFile, updated);
  return true;
}

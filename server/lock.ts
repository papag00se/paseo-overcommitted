import { open, readFile, stat, unlink, type FileHandle } from "node:fs/promises";

// A lock with no readable owner is stale once it is older than any check could
// run (Git commands time out after two minutes each).
const UNREADABLE_LOCK_STALE_MS = 60 * 60_000;
// Linux reports process start in clock ticks; USER_HZ is 100 on every
// supported architecture.
const CLOCK_TICKS_PER_SECOND = 100;

// Start time (ms since epoch, rounded down) of a running process, or null.
export async function processStart(pid: number): Promise<number | null> {
  const stats = await readFile(`/proc/${pid}/stat`, "utf8").catch(() => null);
  if (!stats) return null;
  // Fields after the parenthesised command name; starttime is field 22.
  const ticks = Number(stats.slice(stats.lastIndexOf(")") + 2).split(" ")[19]);
  const boot = Number(/^btime (\d+)$/m.exec(await readFile("/proc/stat", "utf8"))?.[1]);
  return (boot + ticks / CLOCK_TICKS_PER_SECOND) * 1000;
}

// Stale when its owner is gone, or the PID now belongs to a process that
// started after the lock was written. This process never holds a lock it is
// trying to acquire, so its own PID also means stale.
export async function lockIsStale(path: string): Promise<boolean> {
  let owner: { pid?: unknown; at?: unknown } | null = null;
  try { owner = JSON.parse(await readFile(path, "utf8")); } catch { /* crashed before writing */ }
  if (!owner || !Number.isInteger(owner.pid) || typeof owner.at !== "string") return Date.now() - (await stat(path)).mtimeMs > UNREADABLE_LOCK_STALE_MS;
  if (owner.pid === process.pid) return true;
  const started = await processStart(owner.pid as number);
  return started === null || started > Date.parse(owner.at);
}

export async function acquireLock(path: string, root: string, removeStale: boolean): Promise<FileHandle> {
  const create = async () => {
    const lock = await open(path, "wx");
    await lock.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), root }));
    return lock;
  };
  try { return await create(); } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    if (!removeStale || !await lockIsStale(path)) throw new Error(`Repository already locked; inspect ${path} before removing a stale lock`);
    await unlink(path);
    return create();
  }
}

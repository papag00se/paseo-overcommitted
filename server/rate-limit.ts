import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export function rateLimitUntil(text: string, now = Date.now()): number {
  let until = 0;
  const seconds = (n: string) => { const value = Number(n); if (Number.isFinite(value) && value >= 0) until = Math.max(until, now + Math.ceil(value * 1000)); };
  for (const match of text.matchAll(/retry-after:\s*([^\r\n]+)/gi)) {
    const value = match[1].trim();
    if (/^\d+(\.\d+)?$/.test(value)) seconds(value);
    else { const date = Date.parse(value); if (Number.isFinite(date)) until = Math.max(until, date); }
  }
  for (const match of text.matchAll(/(?:^|\s)(?:x-ratelimit-reset-after|ratelimit-reset):\s*(\d+(?:\.\d+)?)/gi)) seconds(match[1]);
  if (/x-ratelimit-remaining:\s*0\b/i.test(text)) {
    for (const match of text.matchAll(/x-ratelimit-reset:\s*(\d+)/gi)) until = Math.max(until, Number(match[1]) * 1000);
  }
  for (const match of text.matchAll(/(?:retry_after["']?\s*[:=]\s*|retryDelay["']?\s*:\s*["']?)(\d+(?:\.\d+)?)/gi)) seconds(match[1]);
  if (!until && /(?:HTTP\/\S+\s+429|too many requests|rate limit exceeded)/i.test(text)) until = now + 3600_000;
  return until;
}

export class RateLimitGate {
  private until = 0;
  constructor(private path = join(process.env.PASEO_HOME || join(homedir(), ".paseo"), "plugin-data", "overcommitted-network-wait.json")) {}
  async check() {
    try { const data = JSON.parse(await readFile(this.path, "utf8")); if (!Number.isFinite(data.until)) throw new Error("Invalid network wait state"); this.until = Math.max(this.until, data.until); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    if (Date.now() < this.until) throw new Error(`Git network rate-limited until ${new Date(this.until).toISOString()}; no network request sent`);
  }
  async observe(text: string) {
    const until = rateLimitUntil(text);
    if (until <= this.until) return;
    this.until = until;
    await mkdir(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify({ until }), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}
export const networkGate = new RateLimitGate();

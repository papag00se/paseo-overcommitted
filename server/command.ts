import { execFile } from "node:child_process";
import { networkGate } from "./rate-limit";

// No shell expansion, interactive prompts, or automatic network retries.
export async function command(file: string, args: string[], cwd?: string, signal?: AbortSignal): Promise<string> {
  const network = file === "git" && args.some(a => ["push", "fetch", "ls-remote"].includes(a));
  if (network) await networkGate.check();
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", LC_ALL: "C",
    ...(network ? { GIT_TRACE_CURL: "1", GIT_TRACE_CURL_NO_DATA: "1", GIT_TRACE_REDACT: "1" } : {}) };
  delete env.PASEO_HOST;
  delete env.PASEO_AGENT_ID;
  return new Promise((resolve, reject) => {
    execFile(file, args, { cwd, env, signal, timeout: 120_000, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" }, async (error, stdout, stderr) => {
      try {
        if (network) await networkGate.observe(stderr + stdout);
        // Never expose curl traces (headers/credentials) in plugin logs or UI.
        const safe = stderr.split("\n").filter(s => !/http\.c:\d+|[<=>]= (Send|Recv)/.test(s)).join("\n")
          .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, "$1[redacted]@").trim();
        if (error) reject(new Error(`${file} ${args[0]} failed: ${safe || error.message}`));
        else resolve(stdout);
      } catch (e) { reject(e); }
    });
  });
}
export const git = (cwd: string, args: string[], signal?: AbortSignal) => command("git", args, cwd, signal);

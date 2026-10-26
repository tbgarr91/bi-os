import { MissingSecretError, type Host } from "../index";

/** Cloudflare Workers bindings arrive as an `env` object; secrets are string bindings. Queue binding name: JOBS. */
export interface CloudflareEnv {
  [key: string]: unknown;
  JOBS?: { send(message: unknown): Promise<void> };
}

export function createCloudflareHost(env: CloudflareEnv): Host {
  return {
    name: "cloudflare",
    secrets: {
      get(name) {
        const v = env[name];
        if (typeof v !== "string" || v === "") throw new MissingSecretError(name);
        return v;
      },
    },
    jobs: {
      async enqueue(job) {
        if (!env.JOBS) throw new Error("JOBS queue binding is not configured");
        await env.JOBS.send(job);
      },
    },
  };
}

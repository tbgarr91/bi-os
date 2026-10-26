import { MissingSecretError, type Host } from "../index";

/** In-memory host for tests and local development. */
export function createMemoryHost(secrets: Record<string, string> = {}) {
  const queued: Array<{ name: string; workspaceId: string; payload: Record<string, string | number | boolean> }> = [];
  const host: Host = {
    name: "memory",
    secrets: {
      get(name) {
        const v = secrets[name];
        if (v === undefined) throw new MissingSecretError(name);
        return v;
      },
    },
    jobs: {
      async enqueue(job) {
        queued.push(job);
      },
    },
  };
  return { host, queued };
}

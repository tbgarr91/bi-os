import { MissingSecretError, type Host } from "../index";

/** Vercel exposes secrets as process environment variables. Job dispatch is injected (queue/runner chosen when needed). */
export function createVercelHost(
  env: Record<string, string | undefined>,
  dispatch: (job: { name: string; workspaceId: string; payload: Record<string, string | number | boolean> }) => Promise<void>,
): Host {
  return {
    name: "vercel",
    secrets: {
      get(name) {
        const v = env[name];
        if (v === undefined || v === "") throw new MissingSecretError(name);
        return v;
      },
    },
    jobs: { enqueue: dispatch },
  };
}

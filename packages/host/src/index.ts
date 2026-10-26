/**
 * The ONLY place application code learns about its hosting platform.
 * Core logic depends on these interfaces, never on Cloudflare or Vercel APIs.
 */
export interface SecretStore {
  /** Returns the secret, or throws. Never logs the value. */
  get(name: string): string;
}

export interface JobDispatcher {
  /** Enqueue a named background job. The payload must contain identifiers only, never personal data or secrets. */
  enqueue(job: { name: string; workspaceId: string; payload: Record<string, string | number | boolean> }): Promise<void>;
}

export interface Host {
  readonly name: "cloudflare" | "vercel" | "memory";
  readonly secrets: SecretStore;
  readonly jobs: JobDispatcher;
}

export class MissingSecretError extends Error {
  constructor(name: string) {
    super(`Missing secret: ${name}`); // the name only, never a value
  }
}

export { createMemoryHost } from "./adapters/memory";
export { createCloudflareHost } from "./adapters/cloudflare";
export { createVercelHost } from "./adapters/vercel";

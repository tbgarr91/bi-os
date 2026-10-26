import { describe, expect, it, vi } from "vitest";
import { createCloudflareHost, createMemoryHost, createVercelHost, MissingSecretError, type Host } from "./index";

/** The same contract must hold for every adapter. */
function contract(name: string, make: () => { host: Host; sent: () => unknown[] }) {
  describe(`host contract: ${name}`, () => {
    it("returns a configured secret", () => {
      expect(make().host.secrets.get("API_KEY")).toBe("s3cr3t");
    });
    it("throws a name-only error for a missing secret (no value leakage)", () => {
      expect(() => make().host.secrets.get("NOPE")).toThrow(MissingSecretError);
      expect(() => make().host.secrets.get("NOPE")).toThrow("Missing secret: NOPE");
    });
    it("dispatches jobs with workspace id and identifier payload", async () => {
      const { host, sent } = make();
      await host.jobs.enqueue({ name: "import", workspaceId: "w1", payload: { fileId: "f1" } });
      expect(sent()).toHaveLength(1);
    });
  });
}

contract("memory", () => {
  const { host, queued } = createMemoryHost({ API_KEY: "s3cr3t" });
  return { host, sent: () => queued };
});
contract("cloudflare", () => {
  const send = vi.fn(async () => {});
  const host = createCloudflareHost({ API_KEY: "s3cr3t", JOBS: { send } });
  return { host, sent: () => send.mock.calls };
});
contract("vercel", () => {
  const dispatch = vi.fn(async () => {});
  const host = createVercelHost({ API_KEY: "s3cr3t" }, dispatch);
  return { host, sent: () => dispatch.mock.calls };
});

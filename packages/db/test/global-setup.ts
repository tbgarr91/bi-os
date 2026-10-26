import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pg from "pg";
import { migrations } from "../src/index";

const PORT = 54330;
let dir = "";
let bin = "";

/** Finds PostgreSQL server binaries: BIOS_PG_BIN, else the newest /usr/lib/postgresql/<n>/bin (preinstalled on GitHub runners). */
function findBin(): string {
  if (process.env.BIOS_PG_BIN) return process.env.BIOS_PG_BIN;
  const root = "/usr/lib/postgresql";
  if (existsSync(root)) {
    const v = readdirSync(root).filter((d) => /^\d+$/.test(d)).sort((a, b) => Number(b) - Number(a))[0];
    if (v) return join(root, v, "bin");
  }
  throw new Error("PostgreSQL server binaries not found. Install postgresql or set BIOS_PG_BIN.");
}

/** Runs a Postgres binary; as the `postgres` OS user when the runner is root (Postgres refuses to run as root). */
function run(cmd: string, args: string[]) {
  const asRoot = process.getuid?.() === 0;
  const [file, a] = asRoot ? ["runuser", ["-u", "postgres", "--", join(bin, cmd), ...args]] : [join(bin, cmd), args];
  return execFileSync(file, a, { stdio: ["ignore", "pipe", "pipe"] });
}

/** Starts a real, throwaway Postgres; applies the Supabase stand-in and every migration. Synthetic data only. */
export async function setup() {
  bin = findBin();
  dir = mkdtempSync(join(tmpdir(), "bios-pg-"));
  chmodSync(dir, 0o777);
  const data = join(dir, "data");
  run("initdb", ["-D", data, "-U", "postgres", "--auth=trust", "-E", "UTF8"]);
  run("pg_ctl", ["-D", data, "-o", `-p ${PORT} -k ${dir} -c listen_addresses=127.0.0.1 -c fsync=off`, "-l", join(dir, "log"), "-w", "start"]);
  const admin = new pg.Client({ host: "127.0.0.1", port: PORT, user: "postgres", database: "postgres" });
  await admin.connect();
  await admin.query(readFileSync(new URL("./shim-supabase.sql", import.meta.url), "utf8"));
  for (const m of migrations()) await admin.query(m.sql);
  await admin.end();
  process.env.BIOS_TEST_PG_PORT = String(PORT);
}

export async function teardown() {
  try { run("pg_ctl", ["-D", join(dir, "data"), "-m", "immediate", "stop"]); } catch { /* already stopped */ }
  if (dir) rmSync(dir, { recursive: true, force: true });
}

/** Idempotent import planning (Project file 16, section 9; Fixture G). Pure: the database layer stores the outcome. */
export async function sha256Hex(text: string): Promise<string> {
  const buf = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Canonical content of a row: keys sorted, so column order never changes the hash. */
export async function rowHash(row: Readonly<Record<string, string>>): Promise<string> {
  const keys = Object.keys(row).sort();
  return sha256Hex(JSON.stringify(keys.map((k) => [k, row[k] ?? ""])));
}

export interface StoredRecord { readonly externalKey: string; readonly contentSha256: string }
export interface IncomingRecord { readonly externalKey: string | null; readonly contentSha256: string; readonly sourceRow: number }

export interface ImportPlan {
  /** Not seen before: store as new evidence. */
  readonly added: readonly (IncomingRecord & { identity: string })[];
  /** Same identity and same content: nothing to do. */
  readonly unchanged: readonly string[];
  /** Same identity, different content: store a new version that supersedes the old; dependent results must be re-evaluated. */
  readonly revised: readonly (IncomingRecord & { identity: string })[];
  /** Same identity AND same content twice in one file when the source gives an identifier: second copy ignored and reported. */
  readonly duplicatesInFile: readonly number[];
  /** Same identifier, different content, inside one file: needs review, nothing stored for it. */
  readonly conflictsInFile: readonly number[];
}

/**
 * Rows with a source identifier are identified by it. Rows WITHOUT one are identified by content plus an occurrence
 * counter, so two genuinely identical sales stay two records while re-importing the same file adds nothing.
 */
export function planImport(existing: readonly StoredRecord[], incoming: readonly IncomingRecord[]): ImportPlan {
  const known = new Map(existing.map((r) => [r.externalKey, r.contentSha256]));
  const seenInFile = new Map<string, string>();
  const occurrence = new Map<string, number>();
  const added: ImportPlan["added"][number][] = [];
  const unchanged: string[] = [];
  const revised: ImportPlan["revised"][number][] = [];
  const duplicatesInFile: number[] = [];
  const conflictsInFile: number[] = [];
  for (const rec of incoming) {
    let identity: string;
    if (rec.externalKey !== null) {
      identity = `id:${rec.externalKey}`;
      const prior = seenInFile.get(identity);
      if (prior !== undefined) { (prior === rec.contentSha256 ? duplicatesInFile : conflictsInFile).push(rec.sourceRow); continue; }
      seenInFile.set(identity, rec.contentSha256);
    } else {
      const n = (occurrence.get(rec.contentSha256) ?? 0) + 1;
      occurrence.set(rec.contentSha256, n);
      identity = `h:${rec.contentSha256}#${n}`;
    }
    const stored = known.get(identity);
    if (stored === undefined) added.push({ ...rec, identity });
    else if (stored === rec.contentSha256) unchanged.push(identity);
    else revised.push({ ...rec, identity });
  }
  return { added, unchanged, revised, duplicatesInFile, conflictsInFile };
}

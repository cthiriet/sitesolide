import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { encodeProjection, PROJECTION_VERSION, type PasswordGrant, type Projection, type SiteAccess } from "../src/access";
import { DATA_DIR } from "../src/config";
import { createAccessReader, type AccessReader, type AccessReaderOptions } from "../src/projection";

if (!DATA_DIR.endsWith(".attempts")) throw new Error(`isolated tests expected, DATA_DIR is ${DATA_DIR}`);

/** When the tests' steward writes, unless a test says otherwise. */
export const WRITTEN_AT = 1_800_000_000_000;

/** One site's people with access, nobody unless the test says so. */
export function site(slug: string, rest: Partial<Omit<SiteAccess, "slug">> = {}): SiteAccess {
  return { slug, people: {}, domains: [], passwords: [], ...rest };
}

export function projection(sites: Record<string, SiteAccess>, writtenAt = WRITTEN_AT): Projection {
  return { version: PROJECTION_VERSION, writtenAt, sites };
}

export function grant(rest: Partial<PasswordGrant> = {}): PasswordGrant {
  return { id: "PaSsWoRdAcCeSs01", who: "alice@elsewhere.test", hash: "a".repeat(64), expiresAt: null, ...rest };
}

let folders = 0;

/**
 * A folder of its own under the diverted DATA_DIR, standing in for both
 * sides: the steward's `access.json`, and the portal's data folder where it
 * leaves its mark.
 */
export function accessFolder(name: string) {
  const folder = join(DATA_DIR, `access-${name}-${folders++}`);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(folder, { recursive: true });
  const file = join(folder, "access.json");
  const mark = join(folder, "access-from-steward");
  let writes = 0;

  return {
    folder,
    file,
    mark,
    /**
     * As the steward writes it: a whole new file renamed over the one in
     * place, never the same file written twice. Text is written as given,
     * to lay a file the portal must not believe.
     */
    write(content: Projection | string): void {
      const draft = join(folder, `.access.json.${writes++}`);
      writeFileSync(draft, typeof content === "string" ? content : encodeProjection(content));
      renameSync(draft, file);
    },
    remove(): void {
      rmSync(file, { force: true });
    },
    reader(legacy: AccessReaderOptions["legacy"] = null, log: (line: string) => void = () => {}, extra: Pick<AccessReaderOptions, "now" | "read"> = {}): AccessReader {
      return createAccessReader({ file, mark, legacy, log, ...extra });
    },
  };
}

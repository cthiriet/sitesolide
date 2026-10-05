/**
 * The kit a compiled binary carries, as bin/cli/kit.ts reads it.
 *
 * Null here, in the repository, which is its own kit. bin/build.ts swaps this
 * module, through a bundler plugin, for one that embeds the packed kit with
 * `with { type: "file" }` and names the hash of what it packed: the import of
 * a file that only exists during a build cannot sit in the source, or every
 * `bun bin/sitesolide.ts` would fail to resolve it.
 */
export const EMBEDDED_KIT: { path: string; hash: string } | null = null;

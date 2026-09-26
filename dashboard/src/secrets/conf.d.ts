/**
 * A `.conf` file imported `with { type: "text" }`: Bun reads it as a string,
 * and `bun build` embeds it as it stands in the bundle. TypeScript 5 types
 * these imports only by the extension, and `@types/bun` does not know this
 * one. Serves the secrets registry, which steward.ts embeds at build time.
 */
declare module "*.conf" {
  const text: string;
  export default text;
}

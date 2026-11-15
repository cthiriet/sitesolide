/**
 * The commands `sitesolide` knows, and what it says of one it does not:
 * its name first, then, for a command a release took away, what replaced
 * it. Judged before the configuration is read, so that a mistyped command
 * on a workstation where `init` never ran is not answered "missing
 * settings", and a removed one does not print the whole list without
 * saying what was wrong.
 *
 * Pure: returns values, touches nothing.
 */

/** Every command bin/sitesolide.ts runs, by the owner over SSH or with a token. */
export const COMMANDS: ReadonlySet<string> = new Set([
  "help",
  "version",
  "--version",
  "setup",
  "upgrade",
  "init",
  "machine",
  "login",
  "detect",
  "deploy",
  "status",
  "logs",
  "backups",
  "share",
  "passkey",
  "secrets",
  "restart",
  "lock",
  "unlock",
  "domain",
  "refresh",
  "remove",
  "rename",
  "disable",
  "enable",
  "run",
]);

/** A command a release took away, and what to run instead. */
export const REMOVED_COMMANDS: Readonly<Record<string, readonly string[]>> = {
  people: [
    "sitesolide people is gone, with company sign-in: the owner alone signs in to the dashboard",
    "a guest opens one site with a password: sitesolide share <email>, in the project's folder",
    "an agent or a CI deploys with a token the owner mints on the dashboard's Tokens page",
  ],
};

/** What to say of a command, or null for one this release runs. */
export function commandRefusal(command: string): { message: string; details: string[]; removed: boolean } | null {
  if (command === "" || COMMANDS.has(command)) return null;
  const removed = Object.hasOwn(REMOVED_COMMANDS, command) ? REMOVED_COMMANDS[command]! : null;
  return {
    message: `unknown command: ${command}`,
    details: removed === null ? ["run sitesolide with no argument to list the commands"] : [...removed],
    removed: removed !== null,
  };
}

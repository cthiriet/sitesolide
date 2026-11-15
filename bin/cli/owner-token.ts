/**
 * `sitesolide login --owner`: the owner's own token for every project,
 * minted over the owner's SSH access, straight into this workstation's vault.
 *
 * Every deployment goes through the dashboard's API with a token, the
 * owner's included: none goes over SSH any more. The owner's token is the one
 * that carries everything an SSH deploy could do (`scope.all`, see
 * dashboard/src/control/policy.ts, everyProject). It is minted in either of
 * two ways:
 *
 * - on the dashboard's Tokens page, under the unlock: New token, Every
 *   project, as you; then `sitesolide login` with it;
 * - here, by the steward's owner socket, `POST /tokens/owner`, which root
 *   alone opens: root over SSH is the proof the unlock stands for, whoever
 *   opens that socket already holds the machine.
 *
 * The second is what `sitesolide setup` points at once the machine is up. It
 * is a command of its own rather than a step of setup's checklist: a token is
 * a credential this workstation keeps, setup may run from a machine that is
 * not the one the owner deploys from, and the same command mints a new one
 * after a revocation or a lost laptop, without running setup again.
 *
 * The secret travels on the SSH session's standard output into this process,
 * and from it into the vault, 0600: it is never printed, never in an event,
 * never in an argument. A workstation whose vault already holds a token the
 * dashboard accepts keeps it, unless `--replace` asks for a new one; the old
 * one is then revoked from the Tokens page.
 */
import { hostname } from "node:os";
import { askSteward, ownerWriteCommand, type RunOnMachine } from "./access";
import { dashboardAddress } from "./config";
import { call, describeIdentity, keepToken, readRemote, report, type Environment, type Fetch, type Output, type RemoteIdentity } from "./remote";

export const OWNER_LOGIN_OPTIONS = ["--owner", "--replace", "--json"];

export type OwnerLoginDependencies = {
  environment: Environment;
  home: string;
  output: Output;
  /** A command as root on the machine, over the owner's SSH access, its JSON body on standard input. */
  run: RunOnMachine;
  zone: string;
  fetcher?: Fetch;
};

/** The token's label on the Tokens page: this workstation, so that the owner knows which to revoke. */
export function ownerTokenLabel(name = hostname()): string {
  const host = name.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return host === "" ? "Owner's workstation" : `Owner, ${host}`;
}

export async function ownerLogin(arguments_: string[], dependencies: OwnerLoginDependencies): Promise<number> {
  const { environment, home, output } = dependencies;
  const unknown = arguments_.slice(1).find((option) => !OWNER_LOGIN_OPTIONS.includes(option));
  if (unknown !== undefined) {
    return report(output, { error: "unknown-option", message: `${unknown}: not an option of sitesolide login --owner: nothing was minted`, details: ["it takes --replace, and --json"] });
  }
  const api = dashboardAddress(dependencies.zone);

  // A token already kept for this dashboard, which the dashboard accepts:
  // kept, unless --replace. One it refuses, revoked or expired, is replaced.
  const kept = readRemote({ ...environment, SITESOLIDE_TOKEN: undefined, SITESOLIDE_API: api }, home);
  if (!("missing" in kept) && !arguments_.includes("--replace")) {
    const who = await call<{ identity: RemoteIdentity }>(kept, "/api/v1/whoami", {}, dependencies.fetcher);
    if (who.ok && who.body.identity.scope.all === true) {
      output.say(`-> this workstation already holds the owner's token for every project, for ${api}`);
      for (const line of describeIdentity(who.body.identity)) output.say(line);
      output.say("   sitesolide login --owner --replace mints a new one; revoke the old one on the Tokens page then");
      output.succeeded("login", { api, identity: who.body.identity, minted: false });
      return 0;
    }
    if (who.ok) output.say("-> the token this workstation holds is not the owner's for every project: a new one is minted beside it on the machine");
    else if (who.failure.error !== "unauthenticated") return report(output, { ...who.failure, details: [...(who.failure.details ?? []), "the dashboard must answer to check the token this workstation holds: nothing was minted"] });
  }

  output.say("-> the owner's token for every project, minted by the steward over SSH");
  const label = ownerTokenLabel();
  const minted = await askSteward(dependencies.run, ownerWriteCommand("POST", "/tokens/owner"), JSON.stringify({ label, expiresAt: null }), {
    outdated: "the steward on the server does not mint the owner's token yet: run sitesolide upgrade first",
    unchanged: true,
  });
  if (!minted.ok) return report(output, minted.failure);
  const { token, secret } = minted.value as { token?: unknown; secret?: unknown };
  if (typeof secret !== "string" || !/^sst_[A-Za-z0-9_-]{43}$/.test(secret) || typeof token !== "object" || token === null) {
    return report(output, { error: "failure", message: "the steward's answer does not read: no token was kept", details: ["a token may have been minted all the same: revoke it on the Tokens page"] });
  }
  const { path } = keepToken(environment, home, api, secret);
  const identity = token as RemoteIdentity;
  output.say(`   token ${identity.id}, "${label}", kept in ${path}: never shown`);
  for (const line of describeIdentity({ ...identity, owned: identity.owned ?? [] })) output.say(line);
  output.say("   sitesolide deploy now goes through the dashboard with it; revoke it on the Tokens page");
  output.succeeded("login", { api, identity, minted: true, tokenFile: path });
  return 0;
}

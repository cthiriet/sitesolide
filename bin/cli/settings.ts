#!/usr/bin/env bun
/**
 * Prints the workstation's configuration in a form `bin/config.sh` evaluates.
 *
 * The scripts in `bin/` need the same settings as the CLI, and a second reader
 * written in shell would end up diverging from the first: it would have neither
 * tilde expansion nor the precedence of the environment over the file. They
 * call this one instead.
 *
 * Nothing is refused here. An incomplete configuration prints what it has, and
 * it is `bin/config.sh` that stops on what is missing: a script dying in the
 * middle of an `eval` would leave a half-configured shell, without saying
 * which half.
 */
import { homedir } from "node:os";
import { defaultPaths, deploymentAccount, expandHome, readConfigFile, type Config } from "./config";


/** A value quoted for a shell: everything but the single quote, which is recomposed. */
function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function settings(
  file: Partial<Config>,
  environment: Record<string, string | undefined>,
  home = homedir(),
): Record<string, string> {
  const defaults = defaultPaths(home);
  const path = (raw: string | undefined | null, fallback: string): string =>
    raw === undefined || raw === null || raw === "" ? fallback : expandHome(raw, home);

  const zone = environment.SITESOLIDE_ZONE ?? file.zone ?? "";
  const server = environment.SITESOLIDE_SERVER ?? file.server ?? "";
  const output: Record<string, string> = {
    SITESOLIDE_SERVER: server,
    // The account that connects, hence the owner of the served files. It is
    // derived from the server: declared separately, it would end up naming
    // another one, and the deployed files would be unreadable to Caddy. No
    // prefix: nobody declares it, it never leaves a script of bin/.
    DEPLOY_USER: server === "" ? "" : deploymentAccount(server),
    SITESOLIDE_ZONE: zone,
    SITESOLIDE_EMAIL: environment.SITESOLIDE_EMAIL ?? file.email ?? "",
    // The Caddy placeholder that carries the slug in `*.<zone>`. Caddy counts
    // labels from the right: `blog.example.com` has `com` at 0, `example` at 1,
    // `blog` at 2. The slug is therefore at the rank of the zone's label count,
    // and a three-label zone puts it at 3.
    SLUG_LABEL: zone === "" ? "" : `{labels.${zone.split(".").length}}`,
    SITESOLIDE_VAULT: path(environment.SITESOLIDE_VAULT ?? file.vault, defaults.vault),
    // Where Terraform finds the machine's values and keeps its state, outside
    // the repository: see bin/terraform.sh.
    SITESOLIDE_TERRAFORM_DIR: path(environment.SITESOLIDE_TERRAFORM_DIR, defaults.terraform),
  };

  // The contact address is optional: left empty, it makes the line disappear
  // from the door page rather than putting a stranger's address there.
  output.SITESOLIDE_CONTACT = environment.SITESOLIDE_CONTACT ?? file.contact ?? "";

  // The projects repository has no default: it only exists for those who have
  // one, and an invented value would look for projects in a missing directory.
  const sites = environment.SITESOLIDE_SITES_REPO ?? file.sites;
  if (sites !== undefined && sites !== null && sites !== "") output.SITESOLIDE_SITES_REPO = expandHome(sites, home);

  return output;
}

export function printSettings(values: Record<string, string>): string {
  return Object.entries(values)
    .map(([key, value]) => `${key}=${quote(value)}`)
    .join("\n");
}

if (import.meta.main) {
  console.log(printSettings(settings(readConfigFile(), process.env)));
}

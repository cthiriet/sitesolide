/**
 * The setup wizard with this workstation's prompts, providers, DNS and
 * setup: what `sitesolide setup` runs when typed alone at a terminal. Apart
 * from bin/cli/wizard.ts so that the tests drive the wizard without Clack.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { realWorkstation, sshLogin } from "./machine";
import { setupFromWorkstation } from "./setup";
import { runWizard } from "./wizard";
import { clackPrompter } from "./wizard-clack";

/** ssh-keygen at the terminal, its passphrase prompt included: whether the key is there after. */
async function keygen(home: string): Promise<boolean> {
  const path = join(home, ".ssh", "id_ed25519");
  const proc = Bun.spawn(["ssh-keygen", "-t", "ed25519", "-f", path, "-C", "sitesolide"], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0 && (await Bun.file(`${path}.pub`).exists());
}

/** ssh-add at the terminal, the key's passphrase typed there: whether it loaded the key. */
async function sshAdd(path: string): Promise<boolean> {
  const proc = Bun.spawn(["ssh-add", path], { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  return (await proc.exited) === 0;
}

export async function wizardCommand(): Promise<number> {
  const home = homedir();
  const environment = { ...process.env };
  return runWizard({
    prompter: clackPrompter(),
    environment,
    home,
    workstation: realWorkstation(environment, home),
    machine: { login: sshLogin },
    dnsApi: { environment },
    setup: setupFromWorkstation,
    keygen: () => keygen(home),
    sshAdd,
  });
}

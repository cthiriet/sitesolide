/**
 * The steward's passkey routes, seen from the dashboard: one method per
 * route, the response as it stands. See protocol.ts for the shapes.
 */
import { callSteward } from "../secrets/client";
import type { ChallengeRequest, RegisterRequest, SignInRequest } from "./protocol";

export type PasskeyStewardClient = {
  list: () => Promise<Response>;
  challenge: (requested: ChallengeRequest) => Promise<Response>;
  signIn: (requested: SignInRequest) => Promise<Response>;
  register: (requested: RegisterRequest) => Promise<Response>;
  remove: (requested: { token: string; id: string }) => Promise<Response>;
};

/** A ceremony waits in no queue of the steward's: five seconds are plenty. */
const TIMEOUT_MS = 5_000;

export function localPasskeySteward(socket: string): PasskeyStewardClient {
  const call = (method: string, path: string, requested?: object) => callSteward(socket, method, path, requested, TIMEOUT_MS);
  return {
    list: () => call("GET", "/passkeys"),
    challenge: (requested) => call("POST", "/passkeys/challenge", requested),
    signIn: (requested) => call("POST", "/passkeys/signin", requested),
    register: (requested) => call("POST", "/passkeys/register", requested),
    remove: (requested) => call("DELETE", "/passkeys/credential", requested),
  };
}

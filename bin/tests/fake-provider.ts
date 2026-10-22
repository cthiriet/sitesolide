/**
 * What every local fake of a provider's API offers, so that
 * bin/tests/cli-machine-providers.test.ts runs `sitesolide machine create`,
 * `list` and `destroy` against each of them the same way.
 *
 * A fake listens on a random port of the loopback, keeps an account in
 * memory, and answers the calls its provider makes in the shapes of the
 * provider's documentation, errors included. A request it does not recognise
 * answers 404 and is recorded all the same, so that a test sees it.
 */
export type FakeRequest = { method: string; path: string; search: string; body: unknown; headers: Record<string, string> };

export type FakeProvider = {
  /**
   * The environment a test runs the command with: the credentials, and the
   * variable(s) pointing the provider at this fake rather than its API.
   */
  environment: Record<string, string>;
  /** The values of `environment` that must never appear in what is printed. */
  secrets: string[];
  /** Every request received since the last reset, in order. */
  requests: FakeRequest[];
  /** Empties the account and the requests. */
  reset(): void;
  stop(): void;
};

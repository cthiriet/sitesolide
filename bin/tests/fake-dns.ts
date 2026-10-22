/**
 * What every local fake of a DNS provider's API offers, so that
 * bin/tests/dns-providers.test.ts runs setup's record engine
 * (ensureZoneRecords in bin/cli/dns/dns.ts) against each of them the same way.
 *
 * A fake listens on a random port of the loopback, holds one zone in memory,
 * `test-zone.invalid` unless told otherwise, and answers the calls its
 * provider makes in the shapes of the provider's documentation, errors
 * included. A request it does not recognise answers 404 and is recorded all
 * the same.
 */
import type { FakeProvider } from "./fake-provider";

export type FakeDns = FakeProvider & {
  /** The zone the fake holds, which the credentials of `environment` may edit. */
  zone: string;
  /** Puts a record in the zone, as an earlier owner left it. */
  addRecord(record: { name: string; type: string; content: string }): void;
  /** The zone's records as they stand, every type, names absolute without a trailing dot. */
  records(): { name: string; type: string; content: string }[];
};

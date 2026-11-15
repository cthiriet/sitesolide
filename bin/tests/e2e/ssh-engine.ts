/**
 * A preload of the end-to-end tests, `bun --preload` before bin/sitesolide.ts:
 * it lets `sitesolide deploy` drive the SSH engine with any project, against
 * the simulated machine of fake-vm.ts.
 *
 * Outside the tests, deploy goes over SSH for the platform's components
 * alone, the dashboard and the portal that setup and upgrade deploy from the
 * kit; every other project goes through the dashboard's API with a token
 * (deploysOverSsh in bin/cli/remote.ts). The engine is the same code for
 * both, and the sample projects of these tests exercise every branch of it
 * the components never reach. Neither the kit nor the binary carries this
 * file: tests/ is left out of both (LEFT_OUT in bin/build.ts).
 */
import { SSH_ENGINE_FOR_TESTS } from "../../cli/remote";

(globalThis as Record<symbol, unknown>)[SSH_ENGINE_FOR_TESTS] = true;

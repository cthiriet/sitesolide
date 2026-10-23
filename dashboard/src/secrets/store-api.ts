/**
 * The in-process contract between the control routes, which judge a token
 * (src/control/steward.ts), and the secrets steward, which works on a
 * project's store (src/secrets/steward.ts). Types only.
 */
import type { Who } from "../people/actions";
import type { StoreFileRemoveRequest, StoreFileRequest, StoreGenerateRequest } from "../../borrowed/store-protocol";

/** What the control routes hand the secrets steward once a token is judged. `creating`: the slug is not deployed, and this token may create it, so its store may be written ahead of its first deployment. */
export type StoreForToken = {
  list: (slug: string, who: Who, creating: boolean) => Promise<Response>;
  change: (req: Request, change: { slug: string; set: [string, string][]; remove: string[] }, who: Who, creating: boolean, still: () => Promise<Response | null>) => Promise<Response>;
  generate: (req: Request, request: StoreGenerateRequest, who: Who, creating: boolean, still: () => Promise<Response | null>) => Promise<Response>;
  setFile: (req: Request, request: StoreFileRequest, who: Who, creating: boolean, still: () => Promise<Response | null>) => Promise<Response>;
  removeFile: (req: Request, request: StoreFileRemoveRequest, who: Who, still: () => Promise<Response | null>) => Promise<Response>;
};

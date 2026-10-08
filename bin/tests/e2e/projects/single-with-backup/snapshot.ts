// The service's backup command: it asks the service, on its own port, for a
// snapshot of its index, which the service can only write into DATA_DIR, then
// copies it into BACKUP_DIR, which the backup component archives as `index`.
// A copy and not a rename: the two folders are different mounts of the unit.
import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";

const answer = await fetch(`http://127.0.0.1:${process.env.PORT}/snapshot`, { method: "POST" });
if (!answer.ok) throw new Error(`the service refused its snapshot: ${answer.status}`);
const written = join(process.env.DATA_DIR!, "index-snapshot");
cpSync(written, process.env.BACKUP_DIR!, { recursive: true });
rmSync(written, { recursive: true, force: true });

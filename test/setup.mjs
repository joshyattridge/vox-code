import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// Each test process gets its own state/credentials/log directory. Tests must
// never overwrite the status of a running, installed Voice daemon.
const root = mkdtempSync(join(tmpdir(), "vox-test-data-"))
process.env.XDG_DATA_HOME = root
delete process.env.VOICE_SOCK
process.on("exit", () => rmSync(root, { recursive: true, force: true }))

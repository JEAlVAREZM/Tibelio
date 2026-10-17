import { createBackup } from "./backup-db.mjs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
if (!process.env.BACKUP_DATABASE_URL || !process.env.BACKUP_OUTPUT_ROOT || !process.env.PRIVATE_STORAGE_ROOT)
  throw new Error("Backup requiere credenciales, volumen y destino separados.");
const outputBase = process.env.BACKUP_OUTPUT_ROOT;
let timer;
let stopping = false;
process.on("SIGTERM", () => { stopping = true; clearTimeout(timer); });
async function backup() {
  let delay = 86400000;
  try {
    await createBackup({ dbUrl: process.env.BACKUP_DATABASE_URL, storageDir: process.env.PRIVATE_STORAGE_ROOT, outputBase });
    await mkdir(outputBase, { recursive: true });
    await writeFile(join(outputBase, "last-success.json"), JSON.stringify({ completedAt: new Date().toISOString() }));
    console.log(JSON.stringify({ event: "backup_ok" }));
  } catch { console.error(JSON.stringify({ event: "backup_failed" })); delay = 60000; }
  if (!stopping) timer = setTimeout(backup, delay);
}
await backup();

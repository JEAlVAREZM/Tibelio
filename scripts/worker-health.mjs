import { readFile } from "node:fs/promises";
const backup = process.argv.includes("--backup");
const file = backup ? "/srv/tibelio/backups/last-success.json" : "/tmp/tibelio-scheduler-health.json";
try {
  const state = JSON.parse(await readFile(file,"utf8"));
  const age = Date.now()-new Date(state.completedAt).getTime();
  if (!Number.isFinite(age) || age<0 || age>(backup ? 25*3600000 : 180000)) process.exitCode=1;
} catch { process.exitCode=1; }

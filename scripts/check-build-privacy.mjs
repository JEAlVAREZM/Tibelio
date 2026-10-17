import { readdir, readFile } from "node:fs/promises";
import { resolve, join, dirname, relative, sep } from "node:path";
// Inspect manifests only; never read file contents or print private paths.
const root = process.cwd();
const build = resolve(".next");
let manifests = 0;
async function inspect(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "dev" && entry.name !== "cache") await inspect(path);
    else if (entry.isFile() && entry.name.endsWith(".nft.json")) {
      manifests++;
      const trace = JSON.parse(await readFile(path,"utf8"));
      for (const file of trace.files) {
        const rel = relative(root,resolve(dirname(path),file)).split(sep).join("/");
        if (rel === ".local" || rel.startsWith(".local/") || rel === ".git" || rel.startsWith(".git/") || /^\.env(?:\.|$)/.test(rel)) throw new Error("Private files included in build trace");
      }
    }
  }
}
await inspect(build);
if (!manifests) throw new Error("No build manifests found");
console.log(`Build privacy: ${manifests} manifests checked; no local files or credentials included.`);

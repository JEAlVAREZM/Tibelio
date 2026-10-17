import { mkdir, mkdtemp, readFile, writeFile, rename, rm, lstat } from "node:fs/promises";
import { resolve, join, dirname, basename, parse, relative, isAbsolute } from "node:path";

// Restore requires maintenance mode. Keep previous files until operator acceptance.
export async function prepareFilesRestore(backupDir, storageDir, files) {
  const target = resolve(storageDir);
  if (target === parse(target).root || target === process.cwd()) throw new Error("Unsafe restore destination");
  try { if ((await lstat(target)).isSymbolicLink()) throw new Error("Restore destination cannot be a symlink"); }
  catch (err) { if (err.code !== "ENOENT") throw err; }
  await mkdir(dirname(target), { recursive: true });
  const stage = await mkdtemp(join(dirname(target), `.${basename(target)}-restore-`));
  const previous = `${stage}-previous`;
  let activated=false, previousMoved=false;
  try {
    for (const f of files) {
      const path=resolve(stage,f.relativePath), rel=relative(stage,path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error("Unsafe restore file path");
      await mkdir(dirname(path), { recursive:true });
      await writeFile(path,await readFile(join(backupDir,"files",f.relativePath)));
    }
  } catch(err) { await rm(stage,{ recursive:true,force:true }); throw err; }
  return {
    async activate() {
      try { await rename(target,previous); previousMoved=true; } catch(err) { if(err.code!=="ENOENT") throw err; }
      await rename(stage,target); activated=true;
    },
    async rollback() {
      if (activated) await rm(target,{recursive:true,force:true});
      if (previousMoved) await rename(previous,target);
      await rm(stage,{recursive:true,force:true});
    },
    previousPath: previous,
  };
}

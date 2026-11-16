import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Writes through a temp file and a rename, so a crash never leaves a half-written file. Skips
 * identical content, so an unchanged file keeps its timestamp. Creates the parent folder.
 * With `mode`, the file gets exactly that mode (on Linux and macOS; Windows ignores it).
 */
export function writeFileAtomic(file: string, content: string, mode?: number): void {
  if (existsSync(file) && readFileSync(file, "utf8") === content) {
    if (mode !== undefined) chmodSync(file, mode);
    return;
  }
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, content, mode === undefined ? undefined : { mode });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

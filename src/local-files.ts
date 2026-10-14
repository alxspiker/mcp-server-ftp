import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";

// Local file transfer is opt-in. FTP_LOCAL_ROOTS lists the local directories that
// upload-local-file may read from and download-to-local may write into, separated by
// the platform path delimiter (":" on macOS/Linux, ";" on Windows). When it is unset,
// both tools refuse every path, so an agent cannot read or write arbitrary local files.

function expandHome(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith("~\\")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Parse FTP_LOCAL_ROOTS into canonical, existing directories. */
export function parseLocalRoots(raw: string | undefined): string[] {
  if (!raw || !raw.trim()) return [];
  const roots: string[] = [];
  for (const part of raw.split(path.delimiter)) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const expanded = path.resolve(expandHome(trimmed));
    let real: string;
    try {
      real = fs.realpathSync(expanded);
    } catch {
      throw new Error(`FTP_LOCAL_ROOTS entry does not exist: "${trimmed}"`);
    }
    if (!fs.statSync(real).isDirectory()) {
      throw new Error(`FTP_LOCAL_ROOTS entry is not a directory: "${trimmed}"`);
    }
    roots.push(real);
  }
  return roots;
}

function isInside(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function notAllowed(localPath: string, roots: string[]): Error {
  if (!roots.length) {
    return new Error(
      "Local file transfer is disabled. Set FTP_LOCAL_ROOTS to the local directories this server may read from and write to."
    );
  }
  return new Error(`Local path "${localPath}" is outside the allowed directories (FTP_LOCAL_ROOTS).`);
}

/**
 * Resolve a local file to read. Symlinks are followed before the check, so a link
 * inside an allowed directory cannot point outside it.
 */
export function resolveReadable(localPath: string, roots: string[]): string {
  if (!roots.length) throw notAllowed(localPath, roots);
  const expanded = path.resolve(expandHome(localPath));
  let real: string;
  try {
    real = fs.realpathSync(expanded);
  } catch {
    throw new Error(`Local file not found: "${localPath}"`);
  }
  if (!roots.some((root) => isInside(root, real))) throw notAllowed(localPath, roots);
  if (!fs.statSync(real).isFile()) throw new Error(`Local path is not a file: "${localPath}"`);
  return real;
}

/**
 * Resolve a local file to write. The parent directory must already exist inside an
 * allowed directory (after following symlinks), and an existing target that is a
 * symlink is refused so the write cannot be redirected elsewhere.
 */
export function resolveWritable(localPath: string, roots: string[], overwrite: boolean): string {
  if (!roots.length) throw notAllowed(localPath, roots);
  const expanded = path.resolve(expandHome(localPath));
  let parent: string;
  try {
    parent = fs.realpathSync(path.dirname(expanded));
  } catch {
    throw new Error(`Local directory does not exist: "${path.dirname(localPath)}"`);
  }
  const target = path.join(parent, path.basename(expanded));
  if (!roots.some((root) => isInside(root, target)) || target === parent) throw notAllowed(localPath, roots);
  let existing: fs.Stats | undefined;
  try {
    existing = fs.lstatSync(target);
  } catch {
    existing = undefined;
  }
  if (existing) {
    if (existing.isSymbolicLink()) throw new Error(`Refusing to write through a symbolic link: "${localPath}"`);
    if (!existing.isFile()) throw new Error(`Local path exists and is not a file: "${localPath}"`);
    if (!overwrite) throw new Error(`Local file already exists: "${localPath}". Pass overwrite: true to replace it.`);
  }
  return target;
}

/** SHA-256 of a local file, streamed so large files are not held in memory. */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream(filePath)
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

/** A temporary path beside the target, so the final rename stays on one filesystem. */
export function tempBeside(target: string): string {
  return path.join(path.dirname(target), `.${path.basename(target)}.part-${process.pid}-${Date.now()}`);
}

import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash, randomBytes } from "crypto";

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

/** The real path of the nearest existing ancestor, joined with the rest (no file system errors). */
function realParentOrSelf(p: string): string {
  let dir = p;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...rest.reverse());
    } catch {
      const up = path.dirname(dir);
      if (up === dir) return p;
      rest.push(path.basename(dir));
      dir = up;
    }
  }
}

/**
 * Refuse a path outside the roots before anything about it is looked up on disk, so the
 * reply is the same whether or not the path (or its parent) exists. The path is checked
 * as written and against the real path of its nearest existing ancestor (so 8.3 short
 * names and links inside the roots still resolve); symlinks in the final component are
 * checked again by the callers once the real path is known.
 */
function assertAllowed(localPath: string, roots: string[]): string {
  if (!roots.length) throw notAllowed(localPath, roots);
  const expanded = path.resolve(expandHome(localPath));
  if (!roots.some((root) => isInside(root, expanded)) && !roots.some((root) => isInside(root, realParentOrSelf(expanded)))) {
    throw notAllowed(localPath, roots);
  }
  return expanded;
}

/**
 * Resolve a local file to read. Symlinks are followed before the check, so a link
 * inside an allowed directory cannot point outside it.
 */
export function resolveReadable(localPath: string, roots: string[]): string {
  const expanded = assertAllowed(localPath, roots);
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
  // Authorise first: an outside path is refused the same way whether or not its parent exists.
  const expanded = assertAllowed(localPath, roots);
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

/** SHA-256 of an open file, read from the start without moving or closing the descriptor. */
export function sha256Fd(fd: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    fs.createReadStream("", { fd, start: 0, autoClose: false })
      .on("error", reject)
      .on("data", (chunk) => hash.update(chunk))
      .on("end", () => resolve(hash.digest("hex")));
  });
}

const O_NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

/** True when the open descriptor and the path name the same file (same device and inode). */
function sameFile(fd: number, filePath: string): boolean {
  const a = fs.fstatSync(fd, { bigint: true });
  const b = fs.lstatSync(filePath, { bigint: true });
  return !b.isSymbolicLink() && a.dev === b.dev && a.ino === b.ino;
}

/**
 * Open a file returned by resolveReadable for reading, without following a symlink that
 * was swapped in after the check (O_NOFOLLOW where the platform has it), and confirm the
 * descriptor is the checked file. The transfer then reads from this descriptor only.
 */
export function openReadable(real: string): { fd: number; size: number } {
  const fd = fs.openSync(real, fs.constants.O_RDONLY | O_NOFOLLOW);
  try {
    if (fs.realpathSync(real) !== real || !sameFile(fd, real)) {
      throw new Error(`Local file changed while it was being opened: "${real}"`);
    }
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error(`Local path is not a file: "${real}"`);
    return { fd, size: st.size };
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
}

export interface TempFile {
  path: string;
  fd: number;
}

/**
 * Create the download's temporary file beside the target, exclusively: a random,
 * unpredictable name opened with O_CREAT | O_EXCL (and O_NOFOLLOW where available), so a
 * pre-existing file or symlink at that name makes the open fail instead of being followed.
 * The transfer writes through the returned descriptor, never through the path.
 * `suffix` is only for tests.
 */
export function createTempFile(dir: string, baseName: string, suffix = randomBytes(12).toString("hex")): TempFile {
  const tempPath = path.join(dir, `.${baseName}.${suffix}.part`);
  const flags = O_NOFOLLOW
    ? fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | O_NOFOLLOW
    : "wx+"; // read access too: the hash is computed from the same descriptor
  const fd = fs.openSync(tempPath, flags, 0o600);
  try {
    // The directory itself must not have been swapped for a link to somewhere else.
    if (fs.realpathSync(dir) !== dir || !sameFile(fd, tempPath)) {
      throw new Error(`Local directory changed during the download: "${dir}"`);
    }
    return { path: tempPath, fd };
  } catch (error) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tempPath); } catch { /* already gone */ }
    throw error;
  }
}

/**
 * Move a completed temporary file to its target.
 * - overwrite false: hard-link the temp file to the target, which fails atomically with
 *   EEXIST if anything (file or symlink) appeared there during the transfer. Where the file
 *   system has no hard links, fall back to an exclusive copy (COPYFILE_EXCL), which is also
 *   no-replace. The temp file is removed by the caller either way.
 * - overwrite true: rename over the target, which replaces a symlink rather than following it.
 */
export function commitTemp(tempPath: string, target: string, overwrite: boolean): void {
  const dir = path.dirname(target);
  if (fs.realpathSync(dir) !== dir) throw new Error(`Local directory changed during the download: "${dir}"`);
  if (overwrite) {
    let existing: fs.Stats | undefined;
    try { existing = fs.lstatSync(target); } catch { existing = undefined; }
    if (existing && !existing.isFile() && !existing.isSymbolicLink()) {
      throw new Error(`Local path exists and is not a file: "${target}"`);
    }
    fs.renameSync(tempPath, target);
    return;
  }
  try {
    fs.linkSync(tempPath, target);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      throw new Error(`Local file already exists: "${target}" (it appeared during the download). Pass overwrite: true to replace it.`);
    }
    if (code !== "EPERM" && code !== "ENOTSUP" && code !== "ENOSYS" && code !== "EXDEV" && code !== "EOPNOTSUPP") throw error;
    try {
      fs.copyFileSync(tempPath, target, fs.constants.COPYFILE_EXCL);
    } catch (copyError) {
      if ((copyError as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error(`Local file already exists: "${target}" (it appeared during the download). Pass overwrite: true to replace it.`);
      }
      throw copyError;
    }
  }
}

import * as path from "path";

// FTP_ROOT is an optional prefix applied to every remote path a tool receives, sandboxing
// the server to a subtree of the remote file system. It is opt-in: unset, empty, or "/"
// leaves every remote path unchanged.

/** Parse FTP_ROOT into a normalized absolute root with no trailing slash, or "" when disabled. */
export function parseFtpRoot(raw: string | undefined): string {
  const trimmed = (raw || "").trim();
  if (trimmed === "" || trimmed === "/") return "";
  const absolute = trimmed.startsWith("/") ? trimmed : "/" + trimmed;
  return absolute.replace(/\/+$/, "") || "";
}

/**
 * Resolve a user-supplied remote path against `root`. The path is normalized as an absolute
 * path (relative to the root, whether or not it starts with "/") before being prefixed, so
 * ".." cannot climb above the root — "/../etc" becomes "<root>/etc", not a sibling of root.
 * "", "/", and "." resolve to the root itself, with no trailing slash. When `root` is ""
 * (FTP_ROOT disabled), `remotePath` passes through unchanged.
 */
export function resolveRemotePath(root: string, remotePath: string): string {
  if (!root) return remotePath;
  const normalized = path.posix.normalize("/" + remotePath);
  return normalized === "/" ? root : root + normalized;
}

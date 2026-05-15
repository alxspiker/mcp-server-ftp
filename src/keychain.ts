import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const KEYCHAIN_SERVICE = "mcp-server-ftp";
const KEYCHAIN_ACCOUNT = "FTP_ENCRYPTION_KEY";

// Shared type for errors thrown by execFileSync.
type ExecError = Error & { status?: number | null; stderr?: Buffer | string | null };

/** Extracts a human-readable string from an execFileSync stderr field. */
function extractStderr(err: ExecError): string {
  const raw = err.stderr;
  if (Buffer.isBuffer(raw)) return raw.toString("utf8").trim();
  if (typeof raw === "string") return raw.trim();
  return "";
}

// ---------------------------------------------------------------------------
// macOS `security` CLI — no native binary, works on any Node architecture
// ---------------------------------------------------------------------------

/**
 * Returns the stored key, or null when the item does not exist yet (exit 44).
 * Throws on real failures (keychain locked, ACL denied, `security` unavailable)
 * so the caller can distinguish "not set up yet" from "something is wrong".
 */
function macosGet(): string | null {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
    return out.trim() || null;
  } catch (err: unknown) {
    const execErr = err as ExecError;
    // Exit code 44 = errSecItemNotFound — key simply hasn't been stored yet.
    if (execErr.status === 44) return null;
    // Any other failure is a real error (keychain locked, ACL denied, etc.)
    const stderr = extractStderr(execErr);
    const detail = stderr || execErr.message || `exit code ${execErr.status ?? "unknown"}`;
    throw new Error(`Failed to read from macOS Keychain via \`security\` CLI: ${detail}`);
  }
}

function macosSet(key: string): void {
  // -U updates an existing entry; creates one if absent.
  //
  // Security note: the key is passed as a command-line argument, which means
  // it is briefly visible in process listings (e.g. `ps aux`) during the
  // fraction of a second this command runs. The `security` CLI provides no
  // stdin interface for `add-generic-password`, so there is no argv-free
  // alternative without shelling out to Swift/AppleScript. This exposure is
  // limited to the one-time `npm run store-key` setup step and does not
  // affect the server's read path (`find-generic-password` outputs to stdout).
  try {
    execFileSync(
      "security",
      ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key],
      { stdio: ["ignore", "ignore", "pipe"] }
    );
  } catch (err: unknown) {
    const execErr = err as ExecError;
    const stderr = extractStderr(execErr);
    // Prefer stderr from the CLI; fall back to the error's own message so
    // there is always something actionable in the thrown error.
    const detail = stderr || execErr.message || `exit code ${execErr.status ?? "unknown"}`;
    throw new Error(`Failed to write to macOS Keychain via \`security\` CLI: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// keytar fallback — Windows Credential Manager / Linux Secret Service
// ---------------------------------------------------------------------------

async function keytarGet(): Promise<string | null> {
  const mod = require("keytar");
  const keytar = mod.default ?? mod;
  return keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
}

async function keytarSet(key: string): Promise<void> {
  const mod = require("keytar");
  const keytar = mod.default ?? mod;
  await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, key);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Attempts to load FTP_ENCRYPTION_KEY from the OS keychain.
 *
 * Strategy (in order):
 *  1. macOS `security` CLI — arch-independent, no native module required
 *  2. keytar — Windows Credential Manager / Linux Secret Service
 *  3. Silent fall-through — caller can still supply via process environment
 *
 * Real keychain errors (e.g. locked keychain) are logged to stderr but do
 * not throw — the server can still start if the key is supplied via the
 * process environment.
 *
 * If the key is already present in process.env.FTP_ENCRYPTION_KEY it is left
 * untouched.
 */
export async function loadEncryptionKey(): Promise<void> {
  if (process.env.FTP_ENCRYPTION_KEY) return;

  if (process.platform === "darwin") {
    // Use security CLI exclusively on macOS — keytar is not attempted here to
    // avoid native-addon architecture conflicts on Apple Silicon / Rosetta.
    try {
      const key = macosGet();
      if (key) {
        process.env.FTP_ENCRYPTION_KEY = key;
      }
    } catch (err) {
      // macosGet() only throws on real errors (not "item not found").
      // Log a warning but do not crash — the caller can still supply the key
      // via the process environment.
      console.error(
        "Warning: macOS Keychain lookup failed:",
        err instanceof Error ? err.message : String(err)
      );
    }
    return;
  }

  try {
    const key = await keytarGet();
    if (key) {
      process.env.FTP_ENCRYPTION_KEY = key;
    }
  } catch {
    // keytar unavailable or keychain lookup failed — fall back to env var only
  }
}

/**
 * Stores the given key in the OS keychain.
 *
 * Strategy (in order):
 *  1. macOS `security` CLI
 *  2. keytar (Windows / Linux)
 */
export async function storeEncryptionKey(key: string): Promise<void> {
  if (process.platform === "darwin") {
    macosSet(key);
    return;
  }
  await keytarSet(key);
}

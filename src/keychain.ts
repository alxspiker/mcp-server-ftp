import { execSync, execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const KEYCHAIN_SERVICE = "mcp-server-ftp";
const KEYCHAIN_ACCOUNT = "FTP_ENCRYPTION_KEY";

// ---------------------------------------------------------------------------
// macOS `security` CLI — no native binary, works on any Node architecture
// ---------------------------------------------------------------------------

function macosGet(): string | null {
  try {
    const out = execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return out.trim() || null;
  } catch {
    return null;
  }
}

function macosSet(key: string): void {
  // -U updates an existing entry; creates one if absent
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", key],
    { stdio: "ignore" }
  );
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
 * If the key is already present in process.env.FTP_ENCRYPTION_KEY it is left
 * untouched.
 */
export async function loadEncryptionKey(): Promise<void> {
  if (process.env.FTP_ENCRYPTION_KEY) return;

  if (process.platform === "darwin") {
    const key = macosGet();
    if (key) {
      process.env.FTP_ENCRYPTION_KEY = key;
      return;
    }
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

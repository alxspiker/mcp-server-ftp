#!/usr/bin/env node
/**
 * Stores the FTP encryption key in the OS keychain so it does not need to be
 * embedded in the Claude Desktop config file.
 *
 * Build first:
 *   npm run build
 *
 * Usage:
 *   node scripts/store-key.js <64-char-hex-key>
 *
 * The key is then retrieved automatically at server start-up via the OS
 * keychain (macOS Keychain, Windows Credential Manager, or Linux Secret
 * Service) without needing FTP_ENCRYPTION_KEY in the MCP config env block.
 */
import { storeEncryptionKey } from "../build/keychain.js";

const USAGE =
  "Usage: run `npm run build` first, then: node scripts/store-key.js <64-char-hex-key>";

const key = process.argv[2];
if (!key) {
  console.error(USAGE);
  process.exit(1);
}

if (!/^[0-9a-fA-F]{64}$/.test(key)) {
  console.error("Invalid key: expected a 64-character hexadecimal string.");
  console.error(USAGE);
  process.exit(1);
}

try {
  await storeEncryptionKey(key);
  console.log("Encryption key stored in OS keychain.");
} catch (err) {
  console.error(
    "Failed to store encryption key. Ensure optional dependency keytar is installed and your OS keychain is available.",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
}

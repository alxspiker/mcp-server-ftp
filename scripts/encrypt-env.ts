#!/usr/bin/env node
/**
 * Utility to encrypt FTP credential env vars for use with mcp-server-ftp.
 *
 * Build first:
 *   npm run build
 *
 * Usage (key already stored in OS keychain via `npm run store-key`):
 *   npm run encrypt-env -- <value>
 *
 * Usage (key supplied via environment variable):
 *   FTP_ENCRYPTION_KEY=<64-char-hex> npm run encrypt-env -- <value>
 *
 * Generate a key:
 *   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
 */
import { loadEncryptionKey } from "../build/keychain.js";
import { encrypt } from "../build/crypto.js";

await loadEncryptionKey();

const value = process.argv[2];
if (!value) {
  console.error(
    "Usage: run `npm run build` first, then: npm run encrypt-env -- <plaintext>\n" +
    "The FTP_ENCRYPTION_KEY must be stored in the OS keychain (npm run store-key) or set as an environment variable."
  );
  process.exit(1);
}

try {
  console.log(encrypt(value));
} catch (err) {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
}


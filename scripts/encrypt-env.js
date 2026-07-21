#!/usr/bin/env node
/**
 * Encrypts a plaintext credential value using the AES-256-GCM key stored in
 * the OS keychain (or FTP_ENCRYPTION_KEY env var as fallback).
 *
 * Build first:
 *   npm run build
 *
 * Usage:
 *   node scripts/encrypt-env.js <plaintext-value>
 *   npm run encrypt-env -- <plaintext-value>
 *
 * Output is an `enc:<iv>:<tag>:<ciphertext>` string ready to paste into your
 * MCP config as FTP_USER, FTP_PASSWORD, or FTP_PASSPHRASE.
 */
import { loadEncryptionKey } from "../build/keychain.js";
import { encrypt } from "../build/crypto.js";

const USAGE =
  "Usage: run `npm run build` first, then: node scripts/encrypt-env.js <plaintext-value>";

const plaintext = process.argv[2];
if (!plaintext) {
  console.error(USAGE);
  process.exit(1);
}

try {
  await loadEncryptionKey();
  console.log(encrypt(plaintext));
} catch (err) {
  console.error(
    "Failed to encrypt value. Ensure FTP_ENCRYPTION_KEY is stored in the OS keychain or set as an environment variable.",
    err instanceof Error ? err.message : err
  );
  process.exit(1);
}

# Changelog

## 1.4.0 — 2026-11-09

### Added
- Optional `FTP_HOST_KEY_SHA256` pins the SFTP server host key to a SHA-256 fingerprint (base64; a leading `SHA256:` prefix is accepted). When it is unset, SFTP connections are not pinned, same as before. The MCPB manifest and the Cursor plugin expose the setting.
- Cursor plugin manifest (`.cursor-plugin/plugin.json`) and `mcp.json`, exposing every `FTP_*` setting as a plugin variable.
- Apify Actor (`.actor/`). Standby serves MCP at `/mcp` and adds `backup-directory`, `sync-directory`, and `compare-directories`. Any other run origin performs one `backup`, `sync`, or `compare` job and exits. npm/stdio tool names are unchanged. See [APIFY.md](APIFY.md).
- Suggested pay-per-event names `automation-run` and `automation-file-transferred`. They are charged only after the work succeeds and are not live prices until they are set in Apify Console.

### Changed
- `@modelcontextprotocol/sdk` is now `^1.32.2` (was `^1.12.0`).
- SFTP `list-directory` entries use `symlink` for symbolic links and `other` for anything that is not a regular file or directory. Those entries used to be reported as `file`. `fileCount` counts only regular files. FTP listings are unchanged.
- `apify` is a devDependency. Installing `mcp-server-ftp` from npm, including `npx`, no longer installs it. The stdio entry point does not import it. The Apify Actor image installs `apify` itself and still runs `build/apify.js`.

### Removed
- Smithery badge, directory link, and `@smithery/cli` install instructions. Smithery shut down its hosted URLs, API, accounts, API keys, and CLI on October 31, 2026. `smithery.yaml` and the Smithery-generated root `Dockerfile` are removed. The Apify Actor build uses `.actor/Dockerfile`.

## 1.3.0 — 2026-10-15

Thanks to @lunchboffin for the local file transfer feature and tests (#21).

### Added
- `upload-local-file` uploads a file from the computer running the server by path, and `download-to-local` downloads a remote file to a local path. Both stream the file instead of passing its contents through the tool call, so large files (built web apps, images, archives) no longer need to fit inside a request. Uploads report size and SHA-256 and check the remote size afterwards.
- `FTP_LOCAL_ROOTS` (and `ftp_local_roots` / `ftpLocalRoots` in the MCPB and Smithery configs) lists the local folders these tools may use. Local transfer is disabled when it is unset. Paths outside the roots are refused before they are looked up, so replies don't reveal what exists outside them; paths are checked after following symbolic links; uploads read through a descriptor opened after the check; downloads go to an exclusively created, randomly named temporary file and are committed with a no-replace operation unless `overwrite` is true.
- Tests for FTP and SFTP (an in-process SFTP server built on `ssh2`, now a dev dependency), covering uploads, downloads, refusals, failure clean-up, a planted symlink at the temporary name, a destination created during the download, and existing versus missing outside parents.

## 1.2.3 — 2026-09-28

### Added
- `FTP_TLS_REJECT_UNAUTHORIZED=false` explicitly permits FTPS connections to trusted servers with self-signed certificates. Certificate and hostname verification remain enabled by default. Exposed in the Smithery and MCPB configurations.

## 1.2.2 — 2026-09-10

### Fixed
- Preserve all nine advertised `outputSchema` definitions while rewriting the SDK's draft-07 `$schema` URI to JSON Schema 2020-12 on stdio responses. This keeps structured output metadata available to clients such as Smithery while avoiding rejection by clients that require 2020-12.

## 1.2.1 — 2026-08-07

### Added
- `FTP_PRIVATE_KEY_PATH` now accepts a 1Password secret reference (`op://vault/item/field`), resolved via the 1Password CLI (`op read`) so the SFTP private key never has to live in a file on disk. The key is cached in memory for the process lifetime; plain file paths and `~/.ssh` auto-detection are unchanged.

## 1.2.0 — 2026-07-21

### Added
- **Structured output**: every tool now declares an `outputSchema` and returns `structuredContent` alongside the human-readable text, so agents can consume results without parsing prose.
- **Tool annotations**: read-only, destructive, and idempotent hints on all tools, letting clients apply appropriate confirmation policies (e.g. `delete-file` is flagged destructive; `list-directory` and `download-file` are read-only).

### Changed
- All connection settings in the Smithery/MCPB manifest are now optional, matching the server's actual defaults (localhost, port 21, anonymous).

## 1.1.0 — 2026-07-21

### Fixed
- **Binary file corruption**: downloads and uploads previously forced `utf8` encoding, corrupting any binary file (zips, images, etc.). Downloads now detect binary content and return it base64-encoded; uploads accept an optional `encoding: "base64"` parameter.
- **FTP connection leak**: the FTP client leaked connections when an operation threw. Every operation now disconnects in a `finally` block (matching the SFTP client's behavior).
- **Temp file cleanup**: downloaded temp files are now always removed, including on error.
- **`build-windows.bat`**: removed the broken fallback that copied `.ts` files as `.js` when compilation failed; a failed build now exits with an error instead of producing a runtime-crashing "success".

- **Concurrent tool-call races**: the MCP SDK dispatches tool calls concurrently, so parallel calls could race each other (concurrent edits silently lost updates in testing). All tool calls now run through an operation queue, making each operation atomic. Ordering between calls issued in parallel is still the client's responsibility — await each result before a dependent call.
- **Temp-file name collisions**: temp files were named with `Date.now()`, so two operations in the same millisecond could share (and delete) each other's temp file. Names now use `randomUUID()`.

### Added
- `FTP_ENCRYPTION_KEY` can now be stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux Secret Service) instead of the config file, via `npm run store-key` — thanks @rencsaridogan ([#7](https://github.com/alxspiker/mcp-server-ftp/pull/7)). Falls back to the environment variable, so existing setups are unaffected.
- New `rename-file` tool to rename or move files and directories (FTP and SFTP).
- New `edit-file` tool: replaces an exact string in a text file so the model doesn't have to re-upload the entire file content. Requires the match to be unique (or `replaceAll: true`) and refuses binary files.
- New `append-file` tool: appends to a file (native `APPE` on FTP, append on SFTP); creates the file if missing.

### Changed
- Migrated tool registration to the current MCP SDK API (`registerTool` with titles); minimum SDK version is now `^1.12.0`.
- Minimum supported Node version is now 18.14.

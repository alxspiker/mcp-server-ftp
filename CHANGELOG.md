# Changelog

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

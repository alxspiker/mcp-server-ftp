# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-05-26

### Fixed

- SFTP connection leak that locked the MCP server after one operation. Each public method on `FtpClient` now creates a fresh `ssh2-sftp-client` and tears it down in a `finally` block, so the previous "An existing SFTP connection is already defined" failure on the second tool call is gone.

### Changed

- `FtpClient.downloadFile` returns `Promise<string>` directly instead of `Promise<{ filePath: string, content: string }>`. File content is transferred in-memory via `sftp.get` / `sftp.put` (`Buffer`-based), eliminating the `mcp-ftp-temp/` directory and its associated leaks (downloads were never cleaned up, uploads leaked their temp file on error).
- Default value of `FTP_PORT` is now `22` (was `21`). The previous default targeted plain FTP, which has been non-functional since the migration to `ssh2-sftp-client` — port 22 matches the only protocol this server actually speaks.

### Removed

- `FTP_SECURE` environment variable and the `secure` field on `FtpConfig`. `ssh2-sftp-client` is always SSH-encrypted, so the setting did nothing. Documentation in `README.md`, `smithery.yaml`, and `CLAUDE.md` updated accordingly.

[1.1.0]: https://github.com/seangoogoo/mcp-server-sftp/releases/tag/v1.1.0

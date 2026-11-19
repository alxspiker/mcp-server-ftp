# Security Policy

mcp-server-ftp connects AI agents to FTP, FTPS, and SFTP servers and handles the credentials for those connections, so security reports are taken seriously.

## Supported versions

Security fixes are released for the latest version published on [npm](https://www.npmjs.com/package/mcp-server-ftp). Older versions are not patched; upgrade to the latest release to receive fixes.

## Reporting a vulnerability

Please do not report security problems in public issues, pull requests, or discussions.

Report them privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability**. This creates a private advisory that only the maintainers can see.

If that option is not available, open an issue that asks for a private contact channel and leave out all details of the problem.

A useful report includes:

- the version of mcp-server-ftp and how it was installed (npm, source build, MCPB bundle, or the Apify Actor)
- the protocol in use (FTP, FTPS, or SFTP) and the relevant `FTP_*` settings, with secrets removed
- the steps to reproduce the problem and what an attacker gains from it

The project is maintained by volunteers, so reports are handled on a best-effort basis. Please allow time for a fix to be released before disclosing the problem publicly.

## What counts as a vulnerability

Examples of problems that belong here:

- credentials, passphrases, private keys, or the `FTP_ENCRYPTION_KEY` being exposed through logs, error messages, tool results, or files left on disk
- a local file transfer reading or writing outside the folders listed in `FTP_LOCAL_ROOTS`
- TLS certificate or hostname verification being skipped when `FTP_TLS_REJECT_UNAUTHORIZED=false` has not been set
- command injection through configuration values, such as the 1Password secret reference in `FTP_PRIVATE_KEY_PATH`
- a remote server being able to make the MCP server write to unintended local paths

The following are expected behavior and not vulnerabilities:

- plain FTP sending credentials and data unencrypted; use FTPS or SFTP instead
- an agent deleting or overwriting remote files it was given access to; restrict the account on the server or use a client-side approval layer
- anything inside a folder listed in `FTP_LOCAL_ROOTS` being available for upload

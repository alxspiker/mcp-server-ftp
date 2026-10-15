[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/alxspiker-mcp-server-ftp-badge.png)](https://mseep.ai/app/alxspiker-mcp-server-ftp)

# MCP Server for FTP, FTPS, and SFTP Access

[![smithery badge](https://smithery.ai/badge/alxspikers-team/mcp-server-ftp)](https://smithery.ai/servers/alxspikers-team/mcp-server-ftp)

This Model Context Protocol (MCP) server provides file-management tools for FTP, FTPS, and SFTP servers. It supports directory listing, binary-safe downloads/uploads, text edits, appends, renames/moves, directory creation, and deletion.

## Protocol support

- **FTP** — traditional FTP, normally on port 21.
- **FTPS** — FTP secured with TLS. Use `FTP_PROTOCOL=ftp` and `FTP_SECURE=true`.
- **SFTP** — SSH File Transfer Protocol, normally on port 22. SFTP is a different protocol from FTPS and is already encrypted by SSH, so `FTP_SECURE` does not apply to it.

## Features

- List files and directories
- Download and upload text or binary files
- Upload and download local files by path, streamed, so size is not limited by the request (opt-in)
- Edit exact text in remote files
- Append to files
- Rename or move files/directories
- Create and delete directories
- FTP, FTPS, and SFTP support
- SFTP password or SSH private-key authentication
- Optional 1Password CLI private-key resolution
- AES-256-GCM encrypted credential values
- OS-keychain support for the encryption key

## Installation

### Installing via Smithery

```bash
npx -y @smithery/cli install alxspikers-team/mcp-server-ftp --client claude
```

### Prerequisites

- Node.js 18.14 or newer
- An MCP-compatible client such as Claude Desktop

### Installing via npm

The server is published as [`mcp-server-ftp`](https://www.npmjs.com/package/mcp-server-ftp):

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "npx",
      "args": ["-y", "mcp-server-ftp"],
      "env": {
        "FTP_HOST": "ftp.example.com"
      }
    }
  }
}
```

### Building from source

```bash
git clone https://github.com/alxspiker/mcp-server-ftp.git
cd mcp-server-ftp
npm install
npm run build
```

## Configuration

### FTP example

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "ftp.example.com",
        "FTP_PORT": "21",
        "FTP_PROTOCOL": "ftp",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
      }
    }
  }
}
```

### FTPS example

FTPS uses the normal FTP client with TLS enabled:

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "ftps.example.com",
        "FTP_PORT": "21",
        "FTP_PROTOCOL": "ftp",
        "FTP_SECURE": "true",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
      }
    }
  }
}
```

`FTP_SECURE` is only meaningful when `FTP_PROTOCOL=ftp`. It is ignored by the SFTP path because SFTP is already encrypted over SSH.

For a trusted FTPS server with a self-signed certificate, add `"FTP_TLS_REJECT_UNAUTHORIZED": "false"` to the FTPS `env` object. This keeps TLS encryption but disables certificate and hostname verification, so use it only when you independently trust the server and network. Verification stays enabled by default. This setting requires `FTP_SECURE=true` and `FTP_PROTOCOL=ftp`.

### SFTP example

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "sftp.example.com",
        "FTP_PORT": "22",
        "FTP_PROTOCOL": "sftp",
        "FTP_USER": "your-username",
        "FTP_PRIVATE_KEY_PATH": "~/.ssh/id_ed25519",
        "FTP_PASSPHRASE": "your-key-passphrase"
      }
    }
  }
}
```

### Configuration options

| Environment variable | Applies to | Description | Default |
|---|---|---|---|
| `FTP_HOST` | all | Server hostname or IP address | `localhost` |
| `FTP_PORT` | all | Server port | `21` for FTP/FTPS, `22` for SFTP |
| `FTP_PROTOCOL` | all | `ftp` or `sftp` | `ftp` |
| `FTP_USER` | all | Username; supports encrypted `enc:` values | `anonymous` |
| `FTP_PASSWORD` | all | Password; supports encrypted `enc:` values | empty |
| `FTP_SECURE` | FTP/FTPS only | Enables TLS/FTPS for the FTP client | `false` |
| `FTP_TLS_REJECT_UNAUTHORIZED` | FTPS only | Verify the FTPS certificate and hostname; `false` allows a trusted self-signed certificate but disables identity checks | `true` |
| `FTP_PRIVATE_KEY_PATH` | SFTP only | SSH private-key path or `op://` 1Password secret reference | auto-detect |
| `FTP_PASSPHRASE` | SFTP only | SSH private-key passphrase; supports encrypted `enc:` values | empty |
| `FTP_ENCRYPTION_KEY` | encrypted credentials | 64-character hex AES-256 key. Prefer the OS keychain or a global environment variable for local installs. | disabled |
| `FTP_LOCAL_ROOTS` | local file tools | Local directories `upload-local-file` may read from and `download-to-local` may write into, separated by `:` (macOS/Linux) or `;` (Windows). `~` is expanded. | disabled |

## SFTP authentication

SFTP supports private-key and password authentication.

The server looks for a private key in this order:

1. `FTP_PRIVATE_KEY_PATH`, if set
2. `~/.ssh/id_ed25519`
3. `~/.ssh/id_rsa`
4. `~/.ssh/id_ecdsa`

If no key is found, `FTP_PASSWORD` is used.

### Reading an SFTP key from 1Password

`FTP_PRIVATE_KEY_PATH` may contain a 1Password secret reference instead of a filesystem path:

```json
"FTP_PRIVATE_KEY_PATH": "op://Private/my-server/private key"
```

Requirements:

- The 1Password CLI (`op`) must be installed and available on `PATH`.
- The CLI must already be able to authenticate, either through the desktop-app integration or `OP_SERVICE_ACCOUNT_TOKEN`.

The key is resolved lazily, cached in memory for the process, and is not written to disk.

If the SSH server rejects 1Password's default exported key format, request OpenSSH format:

```json
"FTP_PRIVATE_KEY_PATH": "op://Private/my-server/private key?ssh-format=openssh"
```

## Credential encryption

`FTP_USER`, `FTP_PASSWORD`, and `FTP_PASSPHRASE` may be stored as AES-256-GCM encrypted values using the `enc:` format.

### Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Store the key in the OS keychain (recommended for local installs)

```bash
npm run build
npm run store-key -- <your-64-char-hex-key>
```

The server loads the key from macOS Keychain, Windows Credential Manager, or Linux Secret Service when available.

Alternatively, set the key globally in the process environment:

```bash
export FTP_ENCRYPTION_KEY=<your-64-char-hex-key>
```

Do not place `FTP_ENCRYPTION_KEY` beside the encrypted credentials in the same local MCP config unless your deployment environment gives you no separate secret-storage mechanism.

### Encrypt a value

```bash
npm run build
FTP_ENCRYPTION_KEY=<your-64-char-hex-key> npm run encrypt-env -- <plaintext-value>
```

If the key is already available from the OS keychain or shell environment:

```bash
npm run encrypt-env -- <plaintext-value>
```

## Available tools

| Tool | Description |
|---|---|
| `list-directory` | List contents of a remote directory |
| `download-file` | Download a file; binary content is returned as base64 |
| `upload-file` | Upload text or base64-encoded binary content |
| `create-directory` | Create a directory |
| `delete-file` | Delete a file |
| `delete-directory` | Delete a directory |
| `rename-file` | Rename or move a file or directory |
| `edit-file` | Replace exact text in a remote text file |
| `append-file` | Append content to a file, creating it if needed |
| `upload-local-file` | Upload a local file by path, streamed; checks the remote size afterwards (needs `FTP_LOCAL_ROOTS`) |
| `download-to-local` | Download a remote file to a local path, streamed, without returning its contents (needs `FTP_LOCAL_ROOTS`) |

Tool calls return machine-readable `structuredContent`, and all eleven tools advertise output schemas. Version 1.2.2 introduced a compatibility shim that ensures advertised schemas use the JSON Schema 2020-12 dialect required by current MCP clients.

## Transferring local files

`upload-file` and `download-file` pass file contents through the tool call itself, which suits small text files. For anything larger, such as a built single-page app or an image, the agent would have to write the whole file into the request, which most clients cannot do. `upload-local-file` and `download-to-local` instead take a path on the computer running this server and stream the file directly, so size is limited only by the connection.

They are disabled until you list the folders they may use:

```json
"env": {
  "FTP_HOST": "ftp.example.com",
  "FTP_USER": "your-username",
  "FTP_PASSWORD": "your-password",
  "FTP_LOCAL_ROOTS": "~/Sites/build:~/Downloads/uploads"
}
```

- A path outside the allowed folders is refused before anything about it is looked up, so the reply is the same whether or not it, or its parent folder, exists.
- Paths are resolved after following symbolic links, so a link inside an allowed folder that points outside it is refused. Uploads read through a single file descriptor opened after that check (with `O_NOFOLLOW` where the platform has it), so the file can't be swapped between the check and the transfer.
- `download-to-local` writes to a temporary file with a random name, created exclusively (`O_CREAT | O_EXCL`, plus `O_NOFOLLOW` where available) beside the target, and writes through its descriptor only, so a file or symbolic link planted at that name can't redirect the download.
- With `overwrite` false (the default), the finished download is committed with a no-replace operation (a hard link, or an exclusive copy where the file system has no hard links), so a file that appears at the target during the download is never replaced. With `overwrite: true` it is renamed over the target. An existing symbolic link at the target is refused, and the temporary file is removed on success and on failure.
- `upload-local-file` reports the file's size and SHA-256, and compares the size the server reports afterwards (FTP `SIZE` or SFTP `stat`) with the local size.

## Optional HOL Guard protection

[HOL Guard](https://github.com/hashgraph-online/hol-guard) has an opt-in **FTP MCP** profile (`mcp.ftp`, catalog ID `command.mcp-ftp`), [merged in PR #4514](https://github.com/hashgraph-online/hol-guard/pull/4514). Use a HOL Guard release or source build that includes this contribution; releases published before the merge do not include it.

To use the profile:

1. Install HOL Guard and configure protection for your MCP client using its [setup instructions](https://github.com/hashgraph-online/hol-guard#readme).
2. Launch this server through `npx mcp-server-ftp`, as shown in the [npm configuration](#installing-via-npm).
3. Enable **FTP MCP** locally through HOL Guard's [Protection Center](https://github.com/hashgraph-online/hol-guard/blob/main/docs/guard/managed-controls-local-extensions.md).

When enabled, `delete-directory` requires human review before recursively deleting a remote directory and its contents. The other tools and unknown tools inherit the existing Guard policy. Custom grants on the device take precedence over the contributed defaults, and stronger protection requirements remain effective.

The profile is off by default. It matches npm package launches through `npx`; direct `node build/index.js` launches are outside this profile.

## Security notes

- Prefer SFTP when available; it uses SSH encryption and key authentication without FTPS certificate configuration.
- Use `FTP_SECURE=true` only for FTPS servers using the FTP protocol path.
- Use credential encryption when a client configuration would otherwise contain plaintext credentials.
- Local file transfer is off unless `FTP_LOCAL_ROOTS` is set. Keep the list to folders you are happy for the agent to publish from or download into; anything inside them can be uploaded to the server.
- FTP and SFTP transfers may use short-lived local temporary files for upload/download/append operations; those files are removed during cleanup after each operation.

## Troubleshooting Windows builds

1. Confirm Node.js 18.14 or newer and npm are installed.
2. Run `npm install`.
3. Run `npm run build` or `npx tsc`.
4. Start the compiled server with `node build/index.js`.

## License

MIT

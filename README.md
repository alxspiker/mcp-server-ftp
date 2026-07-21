[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/alxspiker-mcp-server-ftp-badge.png)](https://mseep.ai/app/alxspiker-mcp-server-ftp)

# MCP Server for FTP Access

[![smithery badge](https://smithery.ai/badge/@alxspiker/mcp-server-ftp)](https://smithery.ai/server/@alxspiker/mcp-server-ftp)

This Model Context Protocol (MCP) server provides tools for interacting with FTP servers. It allows Claude.app to list directories, download and upload files, create directories, and delete files/directories on FTP servers.

## Features

- **List Directory Contents**: View files and folders on the FTP server
- **Download Files**: Retrieve file content from the FTP server
- **Upload Files**: Create new files or update existing ones
- **Create Directories**: Make new folders on the FTP server
- **Delete Files/Directories**: Remove files or directories

## Installation

### Installing via Smithery

To install mcp-server-ftp for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@alxspiker/mcp-server-ftp):

```bash
npx -y @smithery/cli install @alxspiker/mcp-server-ftp --client claude
```

### Prerequisites

- Node.js 16 or higher
- Claude for Desktop (or other MCP-compatible client)

### Building from Source

#### Linux/macOS
```bash
# Clone the repository
git clone https://github.com/alxspiker/mcp-server-ftp.git
cd mcp-server-ftp

# Install dependencies
npm install

# Build the project
npm run build
```

#### Windows
```bash
# Clone the repository
git clone https://github.com/alxspiker/mcp-server-ftp.git
cd mcp-server-ftp

# Run the Windows build helper script
build-windows.bat
```

The `build-windows.bat` script handles dependency installation and building on Windows systems, with fallback options if the TypeScript compiler has issues.

## Configuration

To use this server with Claude for Desktop, add it to your configuration file:

### MacOS/Linux
Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "ftp.example.com",
        "FTP_PORT": "21",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password",
        "FTP_SECURE": "false"
      }
    }
  }
}
```

### Windows
Edit `%APPDATA%\Claude\claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-server-ftp\\build\\index.js"],
      "env": {
        "FTP_HOST": "ftp.example.com",
        "FTP_PORT": "21",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password",
        "FTP_SECURE": "false"
      }
    }
  }
}
```

## Troubleshooting Windows Build Issues

If you encounter build issues on Windows:

1. Use the provided `build-windows.bat` script which handles common build issues
2. Make sure Node.js and npm are properly installed
3. Try running the TypeScript compiler directly: `npx tsc`
4. If you still have issues, you can use the pre-compiled files in the `build` directory by running:
   ```
   node path\to\mcp-server-ftp\build\index.js
   ```

## Configuration Options

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `FTP_HOST` | FTP server hostname or IP address | localhost |
| `FTP_PORT` | FTP server port | 21 |
| `FTP_USER` | FTP username (supports encryption) | anonymous |
| `FTP_PASSWORD` | FTP password (supports encryption) | (empty string) |
| `FTP_SECURE` | Use secure FTP (FTPS), ignored when `FTP_PROTOCOL=sftp` | false |
| `FTP_PROTOCOL` | Protocol to use: `ftp` or `sftp` | ftp |
| `FTP_PRIVATE_KEY_PATH` | Path to SSH private key for SFTP (e.g. `~/.ssh/id_ed25519`) | (auto-detect) |
| `FTP_PASSPHRASE` | Passphrase for the SSH private key (supports encryption) | (empty string) |
| `FTP_ENCRYPTION_KEY` | 64-character hex AES-256 key for decrypting credentials | (disabled) |

## SSH / SFTP Support

In addition to plain FTP and FTPS, the server supports SFTP — the SSH File Transfer Protocol — which runs over an encrypted SSH connection and is unrelated to FTPS.

Set `FTP_PROTOCOL=sftp` to switch the server into SFTP mode. The default port changes to `22`.

### Authentication

SFTP supports two authentication methods, chosen automatically:

- **Private key** — if a key is found (see below), it is used for authentication. `FTP_PASSPHRASE` is used to decrypt the key if it is passphrase-protected.
- **Password** — if no key is found, `FTP_PASSWORD` is used for password authentication.

#### Key discovery

The server looks for a private key in this order:

1. The path in `FTP_PRIVATE_KEY_PATH` (if set)
2. `~/.ssh/id_ed25519`
3. `~/.ssh/id_rsa`
4. `~/.ssh/id_ecdsa`

### Configuration example

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

`FTP_PASSPHRASE` and `FTP_USER` both support the `enc:` encrypted format — see [Credential Encryption](#credential-encryption).

## Credential Encryption

Storing plaintext passwords in your Claude config file is a security risk. The server supports AES-256-GCM encryption for `FTP_USER` and `FTP_PASSWORD` so the config only ever contains ciphertext.

### 1. Generate an encryption key

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Keep this key secret — treat it like a master password.

### 2. Encrypt a credential value

```bash
npm run build
FTP_ENCRYPTION_KEY=<your-64-char-hex-key> npm run encrypt-env -- <plaintext-value>
```

The output is a self-contained encrypted string in the format `enc:<iv_hex>:<tag_hex>:<ciphertext_hex>`.

### 3. Use the encrypted values in your config

Set `FTP_ENCRYPTION_KEY` alongside the encrypted credentials. Values that do not start with `enc:` are treated as plaintext, so you can encrypt selectively.

```json
{
  "mcpServers": {
    "ftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-ftp/build/index.js"],
      "env": {
        "FTP_HOST": "ftp.example.com",
        "FTP_PORT": "21",
        "FTP_USER": "enc:aabbcc...:ddeeff...:112233...",
        "FTP_PASSWORD": "enc:aabbcc...:ddeeff...:112233...",
        "FTP_SECURE": "false",
        "FTP_ENCRYPTION_KEY": "<your-64-char-hex-key>"
      }
    }
  }
}
```

## Usage

After configuring and restarting Claude for Desktop, you can use natural language to perform FTP operations:

- "List the files in the /public directory on my FTP server"
- "Download the file /data/report.txt from the FTP server"
- "Upload this text as a file called notes.txt to the FTP server"
- "Create a new directory called 'backups' on the FTP server"
- "Delete the file obsolete.txt from the FTP server"
- "Remove the empty directory /old-project from the FTP server"

## Available Tools

| Tool Name | Description |
|-----------|-------------|
| `list-directory` | List contents of an FTP directory |
| `download-file` | Download a file from the FTP server (binary files are returned base64-encoded) |
| `upload-file` | Upload a file to the FTP server (pass `encoding: "base64"` for binary content) |
| `create-directory` | Create a new directory on the FTP server |
| `delete-file` | Delete a file from the FTP server |
| `delete-directory` | Delete a directory from the FTP server |
| `rename-file` | Rename or move a file or directory on the FTP server |
| `edit-file` | Replace an exact string in a text file without re-uploading the whole file content |
| `append-file` | Append content to a file (creates it if missing) |

## Security Considerations

- Use the [Credential Encryption](#credential-encryption) feature to avoid storing plaintext passwords in your config file.
- Prefer SFTP (`FTP_PROTOCOL=sftp`) over plain FTP or FTPS where possible — it uses SSH and does not require certificate management.
- Consider using FTPS (secure FTP) by setting `FTP_SECURE=true` if your server supports it but SFTP is unavailable.
- The server creates temporary files for uploads and downloads in your system's temp directory.

## License

MIT

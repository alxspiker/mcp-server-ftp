# MCP Server for FTP/SFTP Access

This Model Context Protocol (MCP) server provides tools for interacting with FTP and SFTP servers. It allows Claude.app to list directories, download and upload files, create directories, and delete files/directories on FTP/SFTP servers.

> **Fork of** [alxspiker/mcp-server-ftp](https://github.com/alxspiker/mcp-server-ftp) - enhanced with SFTP support via `ssh2-sftp-client`.

## Features

- **List Directory Contents**: View files and folders on the FTP/SFTP server
- **Download Files**: Retrieve file content from the FTP/SFTP server
- **Upload Files**: Create new files or update existing ones
- **Create Directories**: Make new folders on the FTP/SFTP server
- **Delete Files/Directories**: Remove files or directories
- **SFTP Support**: Connect to secure SFTP servers (SSH, port 22)

## Installation

### Prerequisites

- Node.js 16 or higher
- Claude for Desktop (or other MCP-compatible client)

### Building from Source

#### Linux/macOS
```bash
# Clone the repository
git clone https://github.com/seangoogoo/mcp-server-sftp.git
cd mcp-server-sftp

# Install dependencies
npm install

# Build the project
npm run build
```

#### Windows
```bash
# Clone the repository
git clone https://github.com/seangoogoo/mcp-server-sftp.git
cd mcp-server-sftp

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
    "sftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-sftp/build/index.js"],
      "env": {
        "FTP_HOST": "sftp.example.com",
        "FTP_PORT": "22",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
      }
    }
  }
}
```

#### SFTP Configuration (SSH, port 22)

For SFTP servers, use port 22. The connection is always secure via SSH:

```json
{
  "mcpServers": {
    "sftp-server": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server-sftp/build/index.js"],
      "env": {
        "FTP_HOST": "sftp.example.com",
        "FTP_PORT": "22",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
      }
    }
  }
}
```

### Windows
Edit `%APPDATA%\Claude\claude_desktop_config.json`:

#### SFTP Configuration
```json
{
  "mcpServers": {
    "sftp-server": {
      "command": "node",
      "args": ["C:\\path\\to\\mcp-server-sftp\\build\\index.js"],
      "env": {
        "FTP_HOST": "sftp.example.com",
        "FTP_PORT": "22",
        "FTP_USER": "your-username",
        "FTP_PASSWORD": "your-password"
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
   node path\to\mcp-server-sftp\build\index.js
   ```

## Configuration Options

| Environment Variable | Description | Default |
|---------------------|-------------|---------|
| `FTP_HOST` | SFTP server hostname or IP address | localhost |
| `FTP_PORT` | SFTP server port | 22 |
| `FTP_USER` | SFTP username | anonymous |
| `FTP_PASSWORD` | SFTP password | (empty string) |

**Protocol:** This server speaks SFTP (SSH File Transfer Protocol) only. Connect on port 22 (default).

## Usage

After configuring and restarting Claude for Desktop, you can use natural language to perform FTP/SFTP operations:

- "List the files in the /public directory on my SFTP server"
- "Download the file /data/report.txt from the FTP server"
- "Upload this text as a file called notes.txt to the SFTP server"
- "Create a new directory called 'backups' on the server"
- "Delete the file obsolete.txt from the FTP server"
- "Remove the empty directory /old-project from the SFTP server"

## Available Tools

| Tool Name | Description |
|-----------|-------------|
| `list-directory` | List contents of an FTP/SFTP directory |
| `download-file` | Download a file from the FTP/SFTP server |
| `upload-file` | Upload a file to the FTP/SFTP server |
| `create-directory` | Create a new directory on the FTP/SFTP server |
| `delete-file` | Delete a file from the FTP/SFTP server |
| `delete-directory` | Delete a directory from the FTP/SFTP server |

## Security Considerations

- SFTP credentials are stored in the Claude configuration file. Ensure this file has appropriate permissions.
- All connections are secured via SSH encryption.
- The server creates temporary files for uploads and downloads in your system's temp directory.

## Contributors

- **[@seangoogoo](https://github.com/seangoogoo)** - SFTP support implementation (migration from `basic-ftp` to `ssh2-sftp-client`)

## License

MIT

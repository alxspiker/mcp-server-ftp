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
| `FTP_USER` | FTP username | anonymous |
| `FTP_PASSWORD` | FTP password | (empty string) |
| `FTP_SECURE` | Use secure FTP (FTPS) | false |

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
| `download-file` | Download a file from the FTP server |
| `upload-file` | Upload a file to the FTP server |
| `create-directory` | Create a new directory on the FTP server |
| `delete-file` | Delete a file from the FTP server |
| `delete-directory` | Delete a directory from the FTP server |

## Security Considerations

- FTP credentials are stored in the Claude configuration file. Ensure this file has appropriate permissions.
- Consider using FTPS (secure FTP) by setting `FTP_SECURE=true` if your server supports it.
- The server creates temporary files for uploads and downloads in your system's temp directory.

## License

MIT

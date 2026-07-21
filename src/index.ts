#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { FtpClient, FtpConfig } from "./ftp-client.js";
import { SftpClient, SftpConfig } from "./sftp-client.js";
import { decrypt } from "./crypto.js";
import { ConnectionType } from "./connection-type.js";
import { loadEncryptionKey } from "./keychain.js";

function resolveSecure(raw: string | undefined): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1" || v === "yes") return true;
  if (v === "false" || v === "0" || v === "no" || v === undefined) return false;
  throw new Error(`Invalid value for FTP_SECURE: "${raw}". Expected one of: true/false, 1/0, yes/no.`);
}

function resolveProtocol(raw: string | undefined): ConnectionType {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "") return ConnectionType.FTP;
  if (v === ConnectionType.FTP) return ConnectionType.FTP;
  if (v === ConnectionType.SFTP) return ConnectionType.SFTP;
  throw new Error(
    `Invalid value for FTP_PROTOCOL: "${raw}". Expected one of: ${ConnectionType.FTP}, ${ConnectionType.SFTP}.`
  );
}

// Client initialized inside main() so decryption/config errors are caught gracefully
type AnyFtpClient = FtpClient | SftpClient;
let ftpClient: AnyFtpClient;

// Create server instance
const server = new McpServer({
  name: "mcp-server-ftp",
  version: "1.0.0",
});

// Register list-directory tool
server.tool(
  "list-directory",
  "List contents of an FTP directory",
  {
    remotePath: z.string().describe("Path of the directory on the FTP server"),
  },
  async ({ remotePath }) => {
    try {
      const listing = await ftpClient.listDirectory(remotePath);
      
      // Format the output
      const formatted = listing.map((item) => 
        `${item.type === "directory" ? "[DIR]" : "[FILE]"} ${item.name} ${item.type === "file" ? `(${formatSize(item.size)})` : ""} - ${item.modifiedDate}`
      ).join("\n");
      
      const summary = `Total: ${listing.length} items (${listing.filter(i => i.type === "directory").length} directories, ${listing.filter(i => i.type === "file").length} files)`;
      
      return {
        content: [
          {
            type: "text",
            text: `Directory listing for: ${remotePath}\n\n${formatted}\n\n${summary}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error listing directory: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Register download-file tool
server.tool(
  "download-file",
  "Download a file from the FTP server",
  {
    remotePath: z.string().describe("Path of the file on the FTP server"),
  },
  async ({ remotePath }) => {
    try {
      const { content } = await ftpClient.downloadFile(remotePath);
      
      return {
        content: [
          {
            type: "text",
            text: `File content of ${remotePath}:\n\n${content}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error downloading file: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Register upload-file tool
server.tool(
  "upload-file",
  "Upload a file to the FTP server",
  {
    remotePath: z.string().describe("Destination path on the FTP server"),
    content: z.string().describe("Content to upload to the file"),
  },
  async ({ remotePath, content }) => {
    try {
      await ftpClient.uploadFile(remotePath, content);
      
      return {
        content: [
          {
            type: "text",
            text: `File successfully uploaded to ${remotePath}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error uploading file: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Register create-directory tool
server.tool(
  "create-directory",
  "Create a new directory on the FTP server",
  {
    remotePath: z.string().describe("Path of the directory to create"),
  },
  async ({ remotePath }) => {
    try {
      await ftpClient.createDirectory(remotePath);
      
      return {
        content: [
          {
            type: "text",
            text: `Directory successfully created at ${remotePath}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error creating directory: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Register delete-file tool
server.tool(
  "delete-file",
  "Delete a file from the FTP server",
  {
    remotePath: z.string().describe("Path of the file to delete"),
  },
  async ({ remotePath }) => {
    try {
      await ftpClient.deleteFile(remotePath);
      
      return {
        content: [
          {
            type: "text",
            text: `File successfully deleted from ${remotePath}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error deleting file: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Register delete-directory tool
server.tool(
  "delete-directory",
  "Delete a directory from the FTP server",
  {
    remotePath: z.string().describe("Path of the directory to delete"),
  },
  async ({ remotePath }) => {
    try {
      await ftpClient.deleteDirectory(remotePath);
      
      return {
        content: [
          {
            type: "text",
            text: `Directory successfully deleted from ${remotePath}`
          }
        ]
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Error deleting directory: ${error instanceof Error ? error.message : String(error)}`
          }
        ]
      };
    }
  }
);

// Helper function to format file sizes
function formatSize(bytes: number): string {
  if (bytes < 1024) return bytes + " B";
  else if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(2) + " KB";
  else if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  else return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

// Initialize and run the server
async function main() {
  // Load encryption key from OS keychain before decrypting any credentials
  await loadEncryptionKey();
  try {
    const protocol = resolveProtocol(process.env.FTP_PROTOCOL);
    const host = process.env.FTP_HOST || "localhost";
    const user = decrypt(process.env.FTP_USER || "anonymous");
    const password = decrypt(process.env.FTP_PASSWORD || "");

    if (protocol === ConnectionType.SFTP) {
      const passphrase = decrypt(process.env.FTP_PASSPHRASE || "");
      const sftpConfig: SftpConfig = {
        host,
        port: parseInt(process.env.FTP_PORT || "22", 10),
        user,
        password,
        passphrase,
        privateKeyPath: process.env.FTP_PRIVATE_KEY_PATH || "",
      };
      ftpClient = new SftpClient(sftpConfig);
    } else {
      const ftpConfig: FtpConfig = {
        host,
        port: parseInt(process.env.FTP_PORT || "21", 10),
        user,
        password,
        secure: resolveSecure(process.env.FTP_SECURE),
      };
      ftpClient = new FtpClient(ftpConfig);
    }
  } catch (error) {
    console.error(
      "Failed to initialize connection config:",
      error instanceof Error ? error.message : String(error)
    );
    process.exit(1);
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("FTP MCP Server running on stdio");
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
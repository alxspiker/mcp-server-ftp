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
  version: "1.2.0",
});

// The MCP SDK dispatches tool calls concurrently, but concurrent FTP operations
// race each other (read-modify-write edits can silently lose updates, and many
// FTP servers cap simultaneous connections). Queue every tool call so each
// operation runs to completion before the next starts. Note this makes
// operations atomic but does not guarantee ordering between calls issued in
// parallel — clients needing ordering must await each result before the next call.
let operationQueue: Promise<unknown> = Promise.resolve();
function serialized<Args extends unknown[], R>(handler: (...args: Args) => Promise<R>): (...args: Args) => Promise<R> {
  return (...args: Args) => {
    const run = () => handler(...args);
    const result = operationQueue.then(run, run);
    operationQueue = result.catch(() => {});
    return result;
  };
}

function errorResult(prefix: string, error: unknown) {
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: `${prefix}: ${error instanceof Error ? error.message : String(error)}`
      }
    ]
  };
}

const fileEntrySchema = z.object({
  name: z.string(),
  type: z.string(),
  size: z.number(),
  modifiedDate: z.string(),
});

// Register list-directory tool
server.registerTool(
  "list-directory",
  {
    title: "List Directory",
    description: "List contents of an FTP directory",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory on the FTP server"),
    },
    outputSchema: {
      path: z.string().describe("The directory that was listed"),
      entries: z.array(fileEntrySchema).describe("Directory entries"),
      totalCount: z.number(),
      directoryCount: z.number(),
      fileCount: z.number(),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath }) => {
    try {
      const listing = await ftpClient.listDirectory(remotePath);

      // Format the output
      const formatted = listing.map((item) =>
        `${item.type === "directory" ? "[DIR]" : "[FILE]"} ${item.name} ${item.type === "file" ? `(${formatSize(item.size)})` : ""} - ${item.modifiedDate}`
      ).join("\n");

      const directoryCount = listing.filter(i => i.type === "directory").length;
      const fileCount = listing.filter(i => i.type === "file").length;
      const summary = `Total: ${listing.length} items (${directoryCount} directories, ${fileCount} files)`;

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory listing for: ${remotePath}\n\n${formatted}\n\n${summary}`
          }
        ],
        structuredContent: {
          path: remotePath,
          entries: listing,
          totalCount: listing.length,
          directoryCount,
          fileCount,
        },
      };
    } catch (error) {
      return errorResult("Error listing directory", error);
    }
  })
);

// Register download-file tool
server.registerTool(
  "download-file",
  {
    title: "Download File",
    description: "Download a file from the FTP server. Text files are returned as-is; binary files are returned base64-encoded.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
    },
    outputSchema: {
      remotePath: z.string(),
      content: z.string().describe("File content, encoded per the encoding field"),
      encoding: z.enum(["utf8", "base64"]).describe("utf8 for text files, base64 for binary files"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath }) => {
    try {
      const { content, encoding } = await ftpClient.downloadFile(remotePath);

      const header = encoding === "base64"
        ? `File content of ${remotePath} (binary, base64-encoded):`
        : `File content of ${remotePath}:`;

      return {
        content: [
          {
            type: "text" as const,
            text: `${header}\n\n${content}`
          }
        ],
        structuredContent: { remotePath, content, encoding },
      };
    } catch (error) {
      return errorResult("Error downloading file", error);
    }
  })
);

// Register upload-file tool
server.registerTool(
  "upload-file",
  {
    title: "Upload File",
    description: "Upload a file to the FTP server. Pass encoding \"base64\" to upload binary content.",
    inputSchema: {
      remotePath: z.string().describe("Destination path on the FTP server"),
      content: z.string().describe("Content to upload to the file"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of the provided content (default: utf8)"),
    },
    outputSchema: {
      remotePath: z.string(),
      bytesWritten: z.number(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath, content, encoding }) => {
    try {
      const enc = encoding ?? "utf8";
      await ftpClient.uploadFile(remotePath, content, enc);

      return {
        content: [
          {
            type: "text" as const,
            text: `File successfully uploaded to ${remotePath}`
          }
        ],
        structuredContent: { remotePath, bytesWritten: Buffer.byteLength(content, enc) },
      };
    } catch (error) {
      return errorResult("Error uploading file", error);
    }
  })
);

// Register create-directory tool
server.registerTool(
  "create-directory",
  {
    title: "Create Directory",
    description: "Create a new directory on the FTP server",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory to create"),
    },
    outputSchema: {
      remotePath: z.string(),
      created: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath }) => {
    try {
      await ftpClient.createDirectory(remotePath);

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory successfully created at ${remotePath}`
          }
        ],
        structuredContent: { remotePath, created: true },
      };
    } catch (error) {
      return errorResult("Error creating directory", error);
    }
  })
);

// Register delete-file tool
server.registerTool(
  "delete-file",
  {
    title: "Delete File",
    description: "Delete a file from the FTP server",
    inputSchema: {
      remotePath: z.string().describe("Path of the file to delete"),
    },
    outputSchema: {
      remotePath: z.string(),
      deleted: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath }) => {
    try {
      await ftpClient.deleteFile(remotePath);

      return {
        content: [
          {
            type: "text" as const,
            text: `File successfully deleted from ${remotePath}`
          }
        ],
        structuredContent: { remotePath, deleted: true },
      };
    } catch (error) {
      return errorResult("Error deleting file", error);
    }
  })
);

// Register delete-directory tool
server.registerTool(
  "delete-directory",
  {
    title: "Delete Directory",
    description: "Delete a directory from the FTP server",
    inputSchema: {
      remotePath: z.string().describe("Path of the directory to delete"),
    },
    outputSchema: {
      remotePath: z.string(),
      deleted: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  serialized(async ({ remotePath }) => {
    try {
      await ftpClient.deleteDirectory(remotePath);

      return {
        content: [
          {
            type: "text" as const,
            text: `Directory successfully deleted from ${remotePath}`
          }
        ],
        structuredContent: { remotePath, deleted: true },
      };
    } catch (error) {
      return errorResult("Error deleting directory", error);
    }
  })
);

// Register rename-file tool
server.registerTool(
  "rename-file",
  {
    title: "Rename / Move",
    description: "Rename or move a file or directory on the FTP server",
    inputSchema: {
      fromPath: z.string().describe("Current path of the file or directory"),
      toPath: z.string().describe("New path for the file or directory"),
    },
    outputSchema: {
      fromPath: z.string(),
      toPath: z.string(),
      renamed: z.boolean(),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ fromPath, toPath }) => {
    try {
      await ftpClient.rename(fromPath, toPath);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully renamed ${fromPath} to ${toPath}`
          }
        ],
        structuredContent: { fromPath, toPath, renamed: true },
      };
    } catch (error) {
      return errorResult("Error renaming", error);
    }
  })
);

// Register edit-file tool
server.registerTool(
  "edit-file",
  {
    title: "Edit File",
    description: "Edit a text file on the FTP server by replacing an exact string, without re-uploading the whole file content. oldText must match exactly (including whitespace) and be unique in the file unless replaceAll is set.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      oldText: z.string().describe("Exact text to find in the file"),
      newText: z.string().describe("Text to replace it with"),
      replaceAll: z.boolean().optional().describe("Replace every occurrence instead of requiring oldText to be unique (default: false)"),
    },
    outputSchema: {
      remotePath: z.string(),
      replacements: z.number().describe("Number of occurrences replaced"),
      fileSize: z.number().describe("Size of the file in bytes after the edit"),
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ remotePath, oldText, newText, replaceAll }) => {
    try {
      if (oldText === "") {
        return errorResult("Error editing file", new Error("oldText must not be empty"));
      }
      if (oldText === newText) {
        return errorResult("Error editing file", new Error("oldText and newText are identical; nothing to change"));
      }

      const { content, encoding } = await ftpClient.downloadFile(remotePath);
      if (encoding === "base64") {
        return errorResult(
          "Error editing file",
          new Error(`${remotePath} is a binary file and cannot be text-edited. Use download-file/upload-file with base64 encoding instead.`)
        );
      }

      const occurrences = content.split(oldText).length - 1;
      if (occurrences === 0) {
        return errorResult(
          "Error editing file",
          new Error(`oldText not found in ${remotePath}. It must match the file content exactly, including whitespace and line breaks.`)
        );
      }
      if (occurrences > 1 && !replaceAll) {
        return errorResult(
          "Error editing file",
          new Error(`oldText matches ${occurrences} places in ${remotePath}. Include more surrounding context to make it unique, or set replaceAll to true.`)
        );
      }

      const updated = replaceAll ? content.split(oldText).join(newText) : content.replace(oldText, newText);
      await ftpClient.uploadFile(remotePath, updated, "utf8");
      const fileSize = Buffer.byteLength(updated, "utf8");

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully edited ${remotePath}: replaced ${occurrences} occurrence${occurrences === 1 ? "" : "s"} (file is now ${formatSize(fileSize)})`
          }
        ],
        structuredContent: { remotePath, replacements: occurrences, fileSize },
      };
    } catch (error) {
      return errorResult("Error editing file", error);
    }
  })
);

// Register append-file tool
server.registerTool(
  "append-file",
  {
    title: "Append to File",
    description: "Append content to the end of a file on the FTP server (creates the file if it does not exist). Pass encoding \"base64\" for binary content.",
    inputSchema: {
      remotePath: z.string().describe("Path of the file on the FTP server"),
      content: z.string().describe("Content to append to the file"),
      encoding: z.enum(["utf8", "base64"]).optional().describe("Encoding of the provided content (default: utf8)"),
    },
    outputSchema: {
      remotePath: z.string(),
      appendedBytes: z.number(),
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  serialized(async ({ remotePath, content, encoding }) => {
    try {
      const enc = encoding ?? "utf8";
      await ftpClient.appendFile(remotePath, content, enc);
      const appendedBytes = Buffer.byteLength(content, enc);

      return {
        content: [
          {
            type: "text" as const,
            text: `Successfully appended ${formatSize(appendedBytes)} to ${remotePath}`
          }
        ],
        structuredContent: { remotePath, appendedBytes },
      };
    } catch (error) {
      return errorResult("Error appending to file", error);
    }
  })
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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const DRAFT_7 = "http://json-schema.org/draft-07/schema#";
const DRAFT_2020_12 = "https://json-schema.org/draft/2020-12/schema";

const outputSchemas: Record<string, Record<string, unknown>> = {
  "list-directory": {
    type: "object",
    properties: {
      path: { type: "string" },
      entries: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string" },
            type: { type: "string" },
            size: { type: "number" },
            modifiedDate: { type: "string" },
          },
          required: ["name", "type", "size", "modifiedDate"],
        },
      },
      totalCount: { type: "number" },
      directoryCount: { type: "number" },
      fileCount: { type: "number" },
    },
    required: ["path", "entries", "totalCount", "directoryCount", "fileCount"],
  },
  "download-file": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      content: { type: "string" },
      encoding: { type: "string", enum: ["utf8", "base64"] },
    },
    required: ["remotePath", "content", "encoding"],
  },
  "upload-file": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      bytesWritten: { type: "number" },
    },
    required: ["remotePath", "bytesWritten"],
  },
  "create-directory": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      created: { type: "boolean" },
    },
    required: ["remotePath", "created"],
  },
  "delete-file": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      deleted: { type: "boolean" },
    },
    required: ["remotePath", "deleted"],
  },
  "delete-directory": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      deleted: { type: "boolean" },
    },
    required: ["remotePath", "deleted"],
  },
  "rename-file": {
    type: "object",
    properties: {
      fromPath: { type: "string" },
      toPath: { type: "string" },
      renamed: { type: "boolean" },
    },
    required: ["fromPath", "toPath", "renamed"],
  },
  "edit-file": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      replacements: { type: "number" },
      fileSize: { type: "number" },
    },
    required: ["remotePath", "replacements", "fileSize"],
  },
  "append-file": {
    type: "object",
    properties: {
      remotePath: { type: "string" },
      appendedBytes: { type: "number" },
    },
    required: ["remotePath", "appendedBytes"],
  },
};

function rewriteDialect(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(rewriteDialect);
  if (!value || typeof value !== "object") return value;

  const rewritten: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    rewritten[key] = key === "$schema" && child === DRAFT_7
      ? DRAFT_2020_12
      : rewriteDialect(child);
  }
  return rewritten;
}

const originalSend = StdioServerTransport.prototype.send;
StdioServerTransport.prototype.send = function(message) {
  const rewritten = rewriteDialect(message) as Record<string, unknown>;
  const result = rewritten.result as Record<string, unknown> | undefined;
  const tools = result?.tools;

  if (Array.isArray(tools)) {
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      const typedTool = tool as Record<string, unknown>;
      const name = typedTool.name;
      if (typeof name !== "string" || typedTool.outputSchema) continue;

      const schema = outputSchemas[name];
      if (schema) {
        typedTool.outputSchema = { $schema: DRAFT_2020_12, ...schema };
      }
    }
  }

  return originalSend.call(this, rewritten as Parameters<typeof originalSend>[0]);
};

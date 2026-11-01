import { createServer, type Server as HttpServer } from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

export interface Input {
  protocol: "ftp" | "ftps" | "sftp";
  host: string;
  port?: number;
  username: string;
  password?: string;
  privateKey?: string;
  passphrase?: string;
  hostKeySha256?: string;
}
export type Charge = (eventName: string) => Promise<void | { eventChargeLimitReached?: boolean }>;
export type AutomationRunner = (tool: string, args: unknown) => Promise<{ text: string; structured: Record<string, unknown> }>;

const automationTools = [
  {
    name: "backup-directory",
    description: "Download a remote directory recursively into a persistent Apify key-value store snapshot. Include and exclude are glob patterns. A file over maxFileBytes fails the job.",
    inputSchema: {
      type: "object" as const,
      properties: {
        remotePath: { type: "string", description: "Remote directory. Defaults to /." },
        include: { type: "array", items: { type: "string" }, description: "Glob patterns to include. Empty includes every file." },
        exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to skip." },
        snapshotName: { type: "string", description: "Snapshot name in the key-value store. Defaults to backup." },
        maxFileBytes: { type: "integer", minimum: 1, description: "Per-file cap in bytes. Cannot exceed 100 MiB." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "sync-directory",
    description: "Mirror a remote directory and a key-value store snapshot. direction is remote-to-store or store-to-remote. dryRun reports the plan without writing. deleteExtraneous defaults to false.",
    inputSchema: {
      type: "object" as const,
      properties: {
        remotePath: { type: "string", description: "Remote directory. Defaults to /." },
        direction: { type: "string", enum: ["remote-to-store", "store-to-remote"], description: "Defaults to remote-to-store." },
        dryRun: { type: "boolean", description: "Report changes without copying or deleting." },
        deleteExtraneous: { type: "boolean", description: "Delete destination files that are not in the source. Defaults to false." },
        include: { type: "array", items: { type: "string" }, description: "Glob patterns to include." },
        exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to skip." },
        snapshotName: { type: "string", description: "Snapshot name. Defaults to backup." },
        maxFileBytes: { type: "integer", minimum: 1, description: "Per-file cap in bytes. Cannot exceed 100 MiB." },
      },
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "compare-directories",
    description: "Diff a remote directory against a backup snapshot or a second server. Writes added, changed, and removed rows. It does not modify either side.",
    inputSchema: {
      type: "object" as const,
      properties: {
        remotePath: { type: "string", description: "Remote directory. Defaults to /." },
        baseline: { type: "string", enum: ["snapshot", "server"], description: "Compare with a snapshot (default) or a second server." },
        snapshotName: { type: "string", description: "Snapshot name when baseline is snapshot. Defaults to backup." },
        include: { type: "array", items: { type: "string" }, description: "Glob patterns to include." },
        exclude: { type: "array", items: { type: "string" }, description: "Glob patterns to skip." },
        compareProtocol: { type: "string", enum: ["ftp", "ftps", "sftp"] },
        compareHost: { type: "string" },
        comparePort: { type: "integer" },
        compareUsername: { type: "string" },
        comparePassword: { type: "string" },
        comparePrivateKey: { type: "string" },
        comparePassphrase: { type: "string" },
        compareHostKeySha256: { type: "string" },
        compareRemotePath: { type: "string", description: "Directory on the second server. Defaults to remotePath." },
        maxFileBytes: { type: "integer", minimum: 1 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

function isBillingFailure(error: unknown): error is { message: string; billingFailed: true; completed?: boolean; structured?: Record<string, unknown> } {
  return !!error && typeof error === "object" && (error as { billingFailed?: unknown }).billingFailed === true && typeof (error as { message?: unknown }).message === "string";
}

export function validateInput(input: Input): void {
  if (!input || !["ftp", "ftps", "sftp"].includes(input.protocol)) throw new Error("protocol must be ftp, ftps, or sftp");
  if (typeof input.host !== "string" || !input.host.trim() || /[\s/]/.test(input.host)) throw new Error("host must be a hostname or IP address");
  if (typeof input.username !== "string" || !input.username) throw new Error("username is required");
  if (input.port !== undefined && (!Number.isInteger(input.port) || input.port < 1 || input.port > 65535)) throw new Error("port must be between 1 and 65535");
  if (input.protocol !== "sftp" && (input.privateKey || input.passphrase || input.hostKeySha256)) throw new Error("SSH settings require SFTP");
  if (input.protocol === "sftp" && (!input.hostKeySha256 || !/^(?:SHA256:)?[A-Za-z0-9+/]{43}=?$/.test(input.hostKeySha256))) throw new Error("SFTP requires the server's SHA256 host key fingerprint");
  if (input.protocol === "sftp" && !input.privateKey && !input.password) throw new Error("SFTP requires a password or private key");
}

const events: Record<string, string> = {
  "list-directory": "list-directory", "download-file": "read-file", "upload-file": "write-file",
  "edit-file": "write-file", "append-file": "write-file", "delete-file": "manage-files",
  "create-directory": "manage-files", "delete-directory": "manage-files", "rename-file": "manage-files",
};
const maxBodyBytes = 12 * 1024 * 1024;

/** A single-tenant process. The Apify platform must isolate each customer's run. */
export async function startServer(input: Input, charge: Charge, port: number, host = "0.0.0.0", runAutomation?: AutomationRunner): Promise<{ server: HttpServer; close: () => Promise<void> }> {
  validateInput(input);
  const temp = await mkdtemp(join(tmpdir(), "ftp-mcp-"));
  const env: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin", HOME: temp,
    FTP_PROTOCOL: input.protocol === "sftp" ? "sftp" : "ftp", FTP_HOST: input.host,
    FTP_PORT: String(input.port ?? (input.protocol === "sftp" ? 22 : 21)), FTP_USER: input.username,
    FTP_PASSWORD: input.password || "", FTP_SECURE: String(input.protocol === "ftps"),
    FTP_TLS_REJECT_UNAUTHORIZED: "true", FTP_PASSPHRASE: input.passphrase || "",
    FTP_HOST_KEY_SHA256: (input.hostKeySha256 || "").replace(/^SHA256:/, ""),
  };
  if (input.privateKey) {
    const keyPath = join(temp, "key");
    await writeFile(keyPath, input.privateKey, { mode: 0o600 });
    env.FTP_PRIVATE_KEY_PATH = keyPath;
  }
  const client = new Client({ name: "apify-ftp-adapter", version: "1.0.0" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL("./index.js", import.meta.url))], env, stderr: "pipe" });
  transport.stderr?.on("data", () => {}); // Never copy child logs, which can contain remote server messages.
  try { await client.connect(transport); } catch (error) { await rm(temp, { recursive: true, force: true }); throw error; }
  const available = (await client.listTools()).tools.filter((tool) => Object.prototype.hasOwnProperty.call(events, tool.name));
  if (available.length !== Object.keys(events).length) throw new Error("FTP tool set does not match the hosted adapter");
  let queue: Promise<unknown> = Promise.resolve();
  let closed = false;
  let billingFailed = false;
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/" && req.headers["x-apify-container-server-readiness-probe"]) { res.writeHead(200).end("ready"); return; }
    if (req.url?.split("?")[0] !== "/mcp") { res.writeHead(404).end(); return; }
    if (req.method !== "POST") { res.writeHead(405, { Allow: "POST" }).end(); return; }
    let bytes = 0;
    const chunks: Buffer[] = [];
    try {
      for await (const chunk of req) {
        const buffer = Buffer.from(chunk); bytes += buffer.length;
        if (bytes > maxBodyBytes) { res.writeHead(413).end(); return; }
        chunks.push(buffer);
      }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const mcp = new Server({ name: "ftp-mcp-apify", version: "1.0.0" }, { capabilities: { tools: {} } });
      mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...available, ...automationTools] }));
      mcp.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const automationTool = automationTools.some((tool) => tool.name === name);
        if (!automationTool && !Object.prototype.hasOwnProperty.call(events, name)) throw new Error("Unknown or unavailable tool");
        const run = async () => {
          if (billingFailed) throw new Error("Billing is unavailable; no operation was attempted. Restart the Actor after resolving billing.");
          if (automationTool) {
            if (!runAutomation) return { isError: true, content: [{ type: "text" as const, text: "Automation jobs are not available in this run." }] };
            try {
              const outcome = await runAutomation(name, request.params.arguments);
              return { content: [{ type: "text" as const, text: outcome.text }], structuredContent: outcome.structured };
            } catch (error) {
              if (isBillingFailure(error)) {
                billingFailed = true;
                if (error.completed) return { content: [{ type: "text" as const, text: error.message }], structuredContent: error.structured };
                return { isError: true, content: [{ type: "text" as const, text: error.message }] };
              }
              return { isError: true, content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }] };
            }
          }
          const result = await client.callTool({ name, arguments: request.params.arguments });
          if (!result.isError) {
            try { await charge(events[name]); }
            catch {
              billingFailed = true;
              console.error(`Billing failed after ${name} completed; operation was not retried.`);
              if (Array.isArray(result.content)) result.content.push({ type: "text", text: "The operation completed, but billing failed. Further operations are disabled until this run is restarted." });
            }
          }
          return result;
        };
        const result = queue.then(run, run); queue = result.catch(() => {}); return result;
      });
      // The server only emits JSON; permit JSON-only HTTP clients such as Apify Console.
      if (req.headers.accept === "application/json") req.headers.accept = "application/json, text/event-stream";
      const httpTransport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => { void mcp.close(); });
      await mcp.connect(httpTransport);
      await httpTransport.handleRequest(req, res, body);
    } catch {
      if (!res.headersSent) res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "Invalid request" }));
      else res.end();
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, host, () => { server.off("error", reject); resolve(); }); });
  return { server, close: async () => {
    if (closed) return; closed = true;
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await queue; await client.close(); await rm(temp, { recursive: true, force: true });
  } };
}

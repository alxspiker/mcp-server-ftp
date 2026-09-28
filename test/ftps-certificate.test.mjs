import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import selfsigned from "selfsigned";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { FtpClient } from "../build/ftp-client.js";

const require = createRequire(import.meta.url);
const FtpSrv = require("ftp-srv");

test("FTPS verifies certificates by default and connects to a self-signed server only when explicitly configured", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ftps-test-"));
  const pems = await selfsigned.generate([{ name: "commonName", value: "unrelated.example" }], { algorithm: "sha256" });
  const server = new FtpSrv({
    url: "ftp://127.0.0.1:0",
    pasv_url: "127.0.0.1",
    tls: { key: pems.private, cert: pems.cert }
  });
  server.on("login", ({ username, password }, resolve, reject) => {
    if (username === "tester" && password === "secret") resolve({ root });
    else reject(new Error("Invalid test credentials"));
  });

  try {
    await writeFile(join(root, "hello.txt"), "hello");
    await server.listen();
    const config = { host: "127.0.0.1", port: server.server.address().port, user: "tester", password: "secret", secure: true };

    await assert.rejects(new FtpClient(config).listDirectory("/"), /self-signed certificate/);
    const list = await new FtpClient({ ...config, rejectUnauthorized: false }).listDirectory("/");
    assert.equal(list.find(item => item.name === "hello.txt")?.size, 5);

    async function listThroughMcp(rejectUnauthorized) {
      const client = new Client({ name: "ftps-test", version: "1.0.0" });
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["build/index.js"],
        env: {
          ...process.env,
          FTP_PROTOCOL: "ftp",
          FTP_SECURE: "true",
          ...(rejectUnauthorized === undefined ? {} : { FTP_TLS_REJECT_UNAUTHORIZED: rejectUnauthorized }),
          FTP_HOST: config.host,
          FTP_PORT: String(config.port),
          FTP_USER: config.user,
          FTP_PASSWORD: config.password
        },
        stderr: "pipe"
      });
      try {
        await client.connect(transport);
        return await client.callTool({ name: "list-directory", arguments: { remotePath: "/" } });
      } finally {
        await client.close();
      }
    }

    const defaultResult = await listThroughMcp(undefined);
    assert.equal(defaultResult.isError, true);
    assert.match(defaultResult.content[0].text, /self-signed certificate/);
    const allowedResult = await listThroughMcp("false");
    assert.equal(allowedResult.isError, undefined);
    assert.equal(allowedResult.structuredContent.entries.find(item => item.name === "hello.txt")?.size, 5);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects certificate bypass when FTPS is not enabled", () => {
  const result = spawnSync(process.execPath, ["build/index.js"], {
    env: {
      ...process.env,
      FTP_PROTOCOL: "ftp",
      FTP_SECURE: "false",
      FTP_TLS_REJECT_UNAUTHORIZED: "false"
    },
    encoding: "utf8",
    timeout: 5000
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /FTP_TLS_REJECT_UNAUTHORIZED=false requires FTP_PROTOCOL=ftp and FTP_SECURE=true/);
});

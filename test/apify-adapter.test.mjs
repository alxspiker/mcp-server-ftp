import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startServer, validateInput } from "../build/apify-server.js";
import { startFtp, startSftp, USER, PASSWORD } from "./helpers/servers.mjs";

for (const protocol of ["ftp", "sftp"]) test(`hosted ${protocol}: MCP calls, billing and tool isolation`, async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-test-"));
  await writeFile(join(root, "hello.txt"), "hello");
  const target = await (protocol === "ftp" ? startFtp(root) : startSftp(root));
  const charges = [];
  const app = await startServer({protocol, host: "127.0.0.1", port: target.port, username: USER, password: PASSWORD, hostKeySha256: target.fingerprint}, async (name) => charges.push(name), 0, "127.0.0.1");
  const client = new Client({name: "test", version: "1"});
  try {
    const probe = await fetch(`http://127.0.0.1:${app.server.address().port}/`, {headers:{"x-apify-container-server-readiness-probe":"1"}});
    assert.equal(probe.status, 200);
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.address().port}/mcp`)));
    const tools = await client.listTools();
    assert.equal(tools.tools.length, 9);
    assert(!tools.tools.some(x => x.name === "upload-local-file" || x.name === "download-to-local"));
    const read = await client.callTool({name: "download-file", arguments: {remotePath: "/hello.txt"}});
    assert.equal(read.isError, undefined);
    assert.match(read.content[0].text, /hello/);
    const missing = await client.callTool({name: "download-file", arguments: {remotePath: "/missing.txt"}});
    assert.equal(missing.isError, true);
    const write = await client.callTool({name: "upload-file", arguments: {remotePath: "/new.txt", content: "world"}});
    assert.equal(write.isError, undefined);
    assert.deepEqual(charges, ["read-file", "write-file"]);
  } finally { await client.close(); await app.close(); await target.close(); await rm(root, {recursive: true, force: true}); }
});

test("SFTP rejects untrusted host keys", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-test-"));
  const target = await startSftp(root);
  const app = await startServer({protocol: "sftp", host: "127.0.0.1", port: target.port, username: USER, password: PASSWORD, hostKeySha256: "SHA256:" + "A".repeat(43)}, async () => { throw new Error("must not bill"); }, 0, "127.0.0.1");
  const client = new Client({name:"test",version:"1"});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.address().port}/mcp`)));
    const result = await client.callTool({name: "list-directory", arguments: {remotePath: "/"}});
    assert.equal(result.isError, true);
  } finally { await client.close(); await app.close(); await target.close(); await rm(root, {recursive:true,force:true}); }
});

test("SFTP fingerprint and connection configuration are required", () => {
  assert.throws(() => validateInput({ protocol: "sftp", host: "example.com", username:"x", password:"x" }), /fingerprint/);
});

test("billing failure preserves the completed result and stops further operations", async () => {
  const root = await mkdtemp(join(tmpdir(), "actor-test-"));
  const target = await startFtp(root);
  const app = await startServer({protocol:"ftp",host:"127.0.0.1",port:target.port,username:USER,password:PASSWORD}, async () => { throw new Error("billing offline"); }, 0, "127.0.0.1");
  const client = new Client({name:"test",version:"1"});
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.address().port}/mcp`)));
    const first = await client.callTool({name:"upload-file",arguments:{remotePath:"/done.txt",content:"saved"}});
    assert.equal(first.isError, undefined);
    assert.match(first.content.at(-1).text, /operation completed.*billing failed/i);
    await assert.rejects(client.callTool({name:"upload-file",arguments:{remotePath:"/not-done.txt",content:"no"}}), /Billing is unavailable/);
  } finally { await client.close(); await app.close(); await target.close(); await rm(root,{recursive:true,force:true}); }
});

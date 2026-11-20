import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import selfsigned from "selfsigned";
import { Client } from "basic-ftp";
import { FtpClient } from "../build/ftp-client.js";

const require = createRequire(import.meta.url);
const FtpSrv = require("ftp-srv");

// 192.0.2.1 is a documentation address nothing answers on. A function pasv_url keeps
// ftp-srv from replacing it with the client's own address for local connections.
const ADVERTISED_HOST = "192.0.2.1";

async function startNatLikeServer(root, { tls } = {}) {
  const server = new FtpSrv({
    url: "ftp://127.0.0.1:0",
    pasv_url: () => ADVERTISED_HOST,
    blacklist: ["EPSV"],
    ...(tls ? { tls } : {})
  });
  server.on("login", ({ username, password }, resolve, reject) => {
    if (username === "tester" && password === "secret") resolve({ root });
    else reject(new Error("Invalid test credentials"));
  });
  await server.listen();
  return { server, port: server.server.address().port };
}

test("without EPSV, transfers use the control host instead of the host advertised in PASV", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ftp-pasv-test-"));
  const { server, port } = await startNatLikeServer(root);
  try {
    await writeFile(join(root, "hello.txt"), "hello");
    const ftp = new FtpClient({ host: "127.0.0.1", port, user: "tester", password: "secret", secure: false });

    const list = await ftp.listDirectory("/");
    assert.equal(list.find((item) => item.name === "hello.txt")?.size, 5);
    assert.deepEqual(await ftp.downloadFile("/hello.txt"), { content: "hello", encoding: "utf8" });
    await ftp.uploadFile("/uploaded.txt", "via control host");
    assert.equal(await readFile(join(root, "uploaded.txt"), "utf8"), "via control host");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("FTPS transfers without EPSV also use the control host", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ftp-pasv-test-"));
  const pems = await selfsigned.generate([{ name: "commonName", value: "localhost" }], { algorithm: "sha256" });
  const { server, port } = await startNatLikeServer(root, { tls: { key: pems.private, cert: pems.cert } });
  try {
    await writeFile(join(root, "secure.txt"), "over tls");
    const ftp = new FtpClient({ host: "127.0.0.1", port, user: "tester", password: "secret", secure: true, rejectUnauthorized: false });

    const list = await ftp.listDirectory("/");
    assert.equal(list.find((item) => item.name === "secure.txt")?.size, 8);
    assert.deepEqual(await ftp.downloadFile("/secure.txt"), { content: "over tls", encoding: "utf8" });
    await ftp.uploadFile("/uploaded-tls.txt", "tls upload");
    assert.equal(await readFile(join(root, "uploaded-tls.txt"), "utf8"), "tls upload");
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("the same server fails with basic-ftp's default transfer strategy", async () => {
  const root = await mkdtemp(join(tmpdir(), "mcp-ftp-pasv-test-"));
  const { server, port } = await startNatLikeServer(root);
  const client = new Client();
  try {
    await client.access({ host: "127.0.0.1", port, user: "tester", password: "secret" });
    await assert.rejects(client.list("/"), /PASV returned another host \(192\.0\.2\.1\)/);
  } finally {
    client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});

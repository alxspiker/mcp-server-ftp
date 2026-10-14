import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const require = createRequire(import.meta.url);
const FtpSrv = require("ftp-srv");

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

async function withServer(fn) {
  const serverRoot = await mkdtemp(join(tmpdir(), "mcp-ftp-remote-"));
  const localRoot = await mkdtemp(join(tmpdir(), "mcp-ftp-local-"));
  const outside = await mkdtemp(join(tmpdir(), "mcp-ftp-outside-"));
  const server = new FtpSrv({ url: "ftp://127.0.0.1:0", pasv_url: "127.0.0.1" });
  server.on("login", ({ username, password }, resolve, reject) => {
    if (username === "tester" && password === "secret") resolve({ root: serverRoot });
    else reject(new Error("Invalid test credentials"));
  });
  await server.listen();
  const port = server.server.address().port;

  async function connect(env = {}) {
    const client = new Client({ name: "local-files-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["build/index.js"],
      env: {
        ...process.env,
        FTP_HOST: "127.0.0.1",
        FTP_PORT: String(port),
        FTP_USER: "tester",
        FTP_PASSWORD: "secret",
        ...env
      },
      stderr: "pipe"
    });
    await client.connect(transport);
    return client;
  }

  try {
    await fn({ serverRoot, localRoot, outside, connect });
  } finally {
    await server.close();
    await Promise.all([serverRoot, localRoot, outside].map((d) => rm(d, { recursive: true, force: true })));
  }
}

const text = (result) => result.content.map((c) => c.text).join("\n");

test("local transfer tools are refused when FTP_LOCAL_ROOTS is not set", async () => {
  await withServer(async ({ localRoot, connect }) => {
    await writeFile(join(localRoot, "a.txt"), "hello");
    const client = await connect();
    try {
      const up = await client.callTool({ name: "upload-local-file", arguments: { localPath: join(localRoot, "a.txt"), remotePath: "/a.txt" } });
      assert.equal(up.isError, true);
      assert.match(text(up), /disabled/);
      const down = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/a.txt", localPath: join(localRoot, "b.txt") } });
      assert.equal(down.isError, true);
      assert.match(text(down), /disabled/);
    } finally {
      await client.close();
    }
  });
});

test("upload-local-file streams a large binary file byte for byte", async () => {
  await withServer(async ({ serverRoot, localRoot, connect }) => {
    const data = randomBytes(3 * 1024 * 1024 + 17);
    await writeFile(join(localRoot, "big.bin"), data);
    const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
    try {
      const result = await client.callTool({ name: "upload-local-file", arguments: { localPath: join(localRoot, "big.bin"), remotePath: "/big.bin" } });
      assert.notEqual(result.isError, true, text(result));
      assert.equal(result.structuredContent.bytesWritten, data.length);
      assert.equal(result.structuredContent.sha256, sha256(data));
      const remote = await readFile(join(serverRoot, "big.bin"));
      assert.equal(remote.length, data.length);
      assert.equal(sha256(remote), sha256(data));
    } finally {
      await client.close();
    }
  });
});

test("upload-local-file refuses paths outside FTP_LOCAL_ROOTS, traversal and escaping symlinks", async () => {
  await withServer(async ({ serverRoot, localRoot, outside, connect }) => {
    await writeFile(join(outside, "secret.txt"), "top secret");
    await symlink(join(outside, "secret.txt"), join(localRoot, "link.txt"));
    const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
    try {
      for (const localPath of [join(outside, "secret.txt"), join(localRoot, "..", "x", "..", outside.split("/").pop(), "secret.txt"), join(localRoot, "link.txt")]) {
        const result = await client.callTool({ name: "upload-local-file", arguments: { localPath, remotePath: "/leak.txt" } });
        assert.equal(result.isError, true, `expected refusal for ${localPath}`);
        assert.match(text(result), /outside the allowed directories|not found/);
      }
      await assert.rejects(readFile(join(serverRoot, "leak.txt")));
    } finally {
      await client.close();
    }
  });
});

test("download-to-local writes inside the root, respects overwrite and refuses symlink targets", async () => {
  await withServer(async ({ serverRoot, localRoot, outside, connect }) => {
    const data = randomBytes(256 * 1024);
    await writeFile(join(serverRoot, "file.bin"), data);
    await mkdir(join(localRoot, "sub"));
    const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
    try {
      const target = join(localRoot, "sub", "file.bin");
      const first = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", localPath: target } });
      assert.notEqual(first.isError, true, text(first));
      assert.equal(sha256(await readFile(target)), sha256(data));
      assert.equal(first.structuredContent.sha256, sha256(data));

      const again = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", localPath: target } });
      assert.equal(again.isError, true);
      assert.match(text(again), /already exists/);

      const replaced = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", localPath: target, overwrite: true } });
      assert.notEqual(replaced.isError, true, text(replaced));

      const out = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", localPath: join(outside, "file.bin") } });
      assert.equal(out.isError, true);
      assert.match(text(out), /outside the allowed directories/);

      await writeFile(join(outside, "victim.txt"), "keep me");
      await symlink(join(outside, "victim.txt"), join(localRoot, "victim-link.txt"));
      const viaLink = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", localPath: join(localRoot, "victim-link.txt"), overwrite: true } });
      assert.equal(viaLink.isError, true);
      assert.match(text(viaLink), /symbolic link/);
      assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "keep me");

      const missing = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/nope.bin", localPath: join(localRoot, "nope.bin") } });
      assert.equal(missing.isError, true);
      await assert.rejects(readFile(join(localRoot, "nope.bin")));
      assert.deepEqual((await readdir(localRoot)).filter((n) => n.includes(".part-")), [], "no partial files left behind");
    } finally {
      await client.close();
    }
  });
});

test("tools/list advertises output schemas for the new tools", async () => {
  await withServer(async ({ localRoot, connect }) => {
    const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
    try {
      const { tools } = await client.listTools();
      for (const name of ["upload-local-file", "download-to-local"]) {
        const tool = tools.find((t) => t.name === name);
        assert.ok(tool, `${name} listed`);
        assert.ok(tool.outputSchema, `${name} has an output schema`);
      }
    } finally {
      await client.close();
    }
  });
});

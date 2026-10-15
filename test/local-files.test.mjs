import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, symlink, rename } from "node:fs/promises";
import { closeSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFtp, startSftp, createGate, USER, PASSWORD } from "./helpers/servers.mjs";
import {
  parseLocalRoots,
  resolveReadable,
  resolveWritable,
  createTempFile,
  commitTemp,
} from "../build/local-files.js";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const text = (result) => result.content.map((c) => c.text).join("\n");
const OUTSIDE = /outside the allowed directories/;

// Windows only lets ordinary users create symbolic links in Developer Mode; elsewhere this
// always works. Where it isn't allowed, skip just the symlink checks and say so.
async function trySymlink(t, target, link, type) {
  try {
    await symlink(target, link, type);
    return true;
  } catch (error) {
    if (error.code !== "EPERM" && error.code !== "EACCES") throw error;
    t.diagnostic(`symlink checks skipped: this account cannot create symbolic links (${error.code})`);
    return false;
  }
}

async function tempDirs() {
  const dirs = {
    serverRoot: await mkdtemp(join(tmpdir(), "mcp-ftp-remote-")),
    localRoot: await mkdtemp(join(tmpdir(), "mcp-ftp-local-")),
    outside: await mkdtemp(join(tmpdir(), "mcp-ftp-outside-")),
  };
  // Canonical paths (macOS /var -> /private/var, Windows short names), as the server sees them.
  for (const k of Object.keys(dirs)) dirs[k] = parseLocalRoots(dirs[k])[0];
  return dirs;
}

const removeAll = (dirs) => Promise.all(Object.values(dirs).map((d) => rm(d, { recursive: true, force: true })));
const partFiles = async (dir) => (await readdir(dir)).filter((n) => n.endsWith(".part"));

async function withServer(protocol, fn, { gate } = {}) {
  const dirs = await tempDirs();
  const server = protocol === "sftp" ? await startSftp(dirs.serverRoot, { gate }) : await startFtp(dirs.serverRoot, { gate });

  async function connect(env = {}) {
    const client = new Client({ name: "local-files-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["build/index.js"],
      env: {
        ...process.env,
        FTP_PROTOCOL: protocol,
        FTP_HOST: "127.0.0.1",
        FTP_PORT: String(server.port),
        FTP_USER: USER,
        FTP_PASSWORD: PASSWORD,
        ...env,
      },
      stderr: "pipe",
    });
    await client.connect(transport);
    return client;
  }

  try {
    await fn({ ...dirs, connect });
  } finally {
    await server.close();
    await removeAll(dirs);
  }
}

// ---------------------------------------------------------------- helper-level regressions

test("temporary files are created exclusively and never follow a planted symlink", async (t) => {
  const dirs = await tempDirs();
  try {
    const victim = join(dirs.outside, "victim.txt");
    await writeFile(victim, "keep me");
    // A file already at the temporary name: exclusive creation fails instead of reusing it.
    await writeFile(join(dirs.localRoot, ".a.txt.fixed.part"), "planted");
    assert.throws(() => createTempFile(dirs.localRoot, "a.txt", "fixed"), { code: "EEXIST" });
    // A symlink at the temporary name pointing outside the roots: not followed.
    if (await trySymlink(t, victim, join(dirs.localRoot, ".b.txt.fixed.part"))) {
      assert.throws(() => createTempFile(dirs.localRoot, "b.txt", "fixed"), (e) => e.code === "EEXIST" || e.code === "ELOOP");
      assert.equal(await readFile(victim, "utf8"), "keep me");
    }
    // Names are random, so they can't be planted in advance.
    const a = createTempFile(dirs.localRoot, "c.txt");
    const b = createTempFile(dirs.localRoot, "c.txt");
    closeSync(a.fd);
    closeSync(b.fd);
    assert.notEqual(a.path, b.path);
    assert.match(basename(a.path), /^\.c\.txt\.[0-9a-f]{24}\.part$/);
  } finally {
    await removeAll(dirs);
  }
});

test("a directory swapped for a symlink during the transfer is detected", async (t) => {
  const dirs = await tempDirs();
  try {
    const sub = join(dirs.localRoot, "sub");
    await mkdir(sub);
    const target = resolveWritable(join(sub, "file.txt"), [dirs.localRoot], false);
    // Swap sub for a link to a directory outside the roots after the check.
    await rename(sub, join(dirs.localRoot, "sub-moved"));
    if (!(await trySymlink(t, dirs.outside, sub, "dir"))) return;
    assert.throws(() => createTempFile(sub, basename(target)), /changed during the download/);
    assert.deepEqual(await readdir(dirs.outside), [], "nothing created outside the roots");
  } finally {
    await removeAll(dirs);
  }
});

test("overwrite: false commits atomically and never replaces a file that appeared meanwhile", async () => {
  const dirs = await tempDirs();
  try {
    const target = resolveWritable(join(dirs.localRoot, "file.txt"), [dirs.localRoot], false);
    const tmp = createTempFile(dirs.localRoot, "file.txt");
    closeSync(tmp.fd);
    await writeFile(tmp.path, "downloaded");
    await writeFile(target, "created during the download");
    assert.throws(() => commitTemp(tmp.path, target, false), /already exists/);
    assert.equal(await readFile(target, "utf8"), "created during the download");
    // With overwrite it is replaced.
    commitTemp(tmp.path, target, true);
    assert.equal(await readFile(target, "utf8"), "downloaded");
  } finally {
    await removeAll(dirs);
  }
});

test("outside paths get the same refusal whether or not they or their parent exist", async () => {
  const dirs = await tempDirs();
  try {
    await writeFile(join(dirs.outside, "exists.txt"), "x");
    const roots = [dirs.localRoot];
    const messages = [
      () => resolveWritable(join(dirs.outside, "new.txt"), roots, false), // existing outside parent
      () => resolveWritable(join(dirs.outside, "missing-dir", "new.txt"), roots, false), // missing outside parent
      () => resolveWritable(join(dirs.outside, "a", "b", "c", "new.txt"), roots, false),
      () => resolveReadable(join(dirs.outside, "exists.txt"), roots),
      () => resolveReadable(join(dirs.outside, "missing.txt"), roots),
      () => resolveReadable(join(dirs.outside, "missing-dir", "missing.txt"), roots),
    ].map((fn) => {
      try {
        fn();
        return "no error";
      } catch (error) {
        return error.message.replace(/"[^"]*"/, '"…"');
      }
    });
    for (const m of messages) assert.match(m, OUTSIDE);
    assert.equal(new Set(messages).size, 1, `all refusals identical: ${messages.join(" | ")}`);
    // Inside the roots, a missing directory is still reported plainly.
    assert.throws(() => resolveWritable(join(dirs.localRoot, "nope", "x.txt"), roots, false), /does not exist/);
  } finally {
    await removeAll(dirs);
  }
});

// ---------------------------------------------------------------- end to end, FTP and SFTP

for (const protocol of ["ftp", "sftp"]) {
  test(`${protocol}: local transfer tools are refused when FTP_LOCAL_ROOTS is not set`, async () => {
    await withServer(protocol, async ({ localRoot, connect }) => {
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

  test(`${protocol}: upload-local-file streams a large binary file byte for byte`, async () => {
    await withServer(protocol, async ({ serverRoot, localRoot, connect }) => {
      const data = randomBytes(3 * 1024 * 1024 + 17);
      await writeFile(join(localRoot, "big.bin"), data);
      const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
      try {
        const result = await client.callTool({ name: "upload-local-file", arguments: { localPath: join(localRoot, "big.bin"), remotePath: "/big.bin" } });
        assert.notEqual(result.isError, true, text(result));
        assert.equal(result.structuredContent.bytesWritten, data.length);
        assert.equal(result.structuredContent.remoteSize, data.length);
        assert.equal(result.structuredContent.sha256, sha256(data));
        assert.equal(sha256(await readFile(join(serverRoot, "big.bin"))), sha256(data));
      } finally {
        await client.close();
      }
    });
  });

  test(`${protocol}: upload-local-file refusals and failures`, async (t) => {
    await withServer(protocol, async ({ serverRoot, localRoot, outside, connect }) => {
      await writeFile(join(outside, "secret.txt"), "top secret");
      await writeFile(join(localRoot, "ok.txt"), "fine");
      const linked = await trySymlink(t, join(outside, "secret.txt"), join(localRoot, "link.txt"));
      const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
      try {
        const attempts = [
          join(outside, "secret.txt"),
          join(outside, "no-such-file.txt"),
          join(outside, "no-such-dir", "no-such-file.txt"),
          join(localRoot, "..", basename(outside), "secret.txt"),
        ];
        if (linked) attempts.push(join(localRoot, "link.txt"));
        for (const localPath of attempts) {
          const result = await client.callTool({ name: "upload-local-file", arguments: { localPath, remotePath: "/leak.txt" } });
          assert.equal(result.isError, true, `expected refusal for ${localPath}`);
          assert.match(text(result), OUTSIDE);
        }
        assert.equal(existsSync(join(serverRoot, "leak.txt")), false);
        // A remote failure (directory that doesn't exist) is reported, not swallowed.
        // (SFTP only: the in-process ftp-srv throws an unhandled error of its own for this case.)
        if (protocol === "sftp") {
          const failed = await client.callTool({ name: "upload-local-file", arguments: { localPath: join(localRoot, "ok.txt"), remotePath: "/no/such/dir/ok.txt" } });
          assert.equal(failed.isError, true);
        }
      } finally {
        await client.close();
      }
    });
  });

  test(`${protocol}: download-to-local writes inside the root, refuses unsafe targets and cleans up failures`, async (t) => {
    await withServer(protocol, async ({ serverRoot, localRoot, outside, connect }) => {
      const data = randomBytes(256 * 1024);
      await writeFile(join(serverRoot, "file.bin"), data);
      await mkdir(join(localRoot, "sub"));
      const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
      const call = (args) => client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", ...args } });
      try {
        const target = join(localRoot, "sub", "file.bin");
        const first = await call({ localPath: target });
        assert.notEqual(first.isError, true, text(first));
        assert.equal(sha256(await readFile(target)), sha256(data));
        assert.equal(first.structuredContent.sha256, sha256(data));

        const again = await call({ localPath: target });
        assert.equal(again.isError, true);
        assert.match(text(again), /already exists/);

        const replaced = await call({ localPath: target, overwrite: true });
        assert.notEqual(replaced.isError, true, text(replaced));

        // Outside the roots: the same refusal whether or not the parent exists.
        for (const localPath of [join(outside, "file.bin"), join(outside, "missing-dir", "file.bin")]) {
          const out = await call({ localPath });
          assert.equal(out.isError, true);
          assert.match(text(out), OUTSIDE);
        }
        assert.deepEqual(await readdir(outside), []);

        await writeFile(join(outside, "victim.txt"), "keep me");
        if (await trySymlink(t, join(outside, "victim.txt"), join(localRoot, "victim-link.txt"))) {
          const viaLink = await call({ localPath: join(localRoot, "victim-link.txt"), overwrite: true });
          assert.equal(viaLink.isError, true);
          assert.match(text(viaLink), /symbolic link/);
          assert.equal(await readFile(join(outside, "victim.txt"), "utf8"), "keep me");
        }

        // Failure cleanup: a missing remote file leaves no target and no partial file.
        const missing = await client.callTool({ name: "download-to-local", arguments: { remotePath: "/nope.bin", localPath: join(localRoot, "nope.bin") } });
        assert.equal(missing.isError, true);
        assert.equal(existsSync(join(localRoot, "nope.bin")), false);
        assert.deepEqual(await partFiles(localRoot), [], "no partial files left behind");
        assert.deepEqual(await partFiles(join(localRoot, "sub")), []);
      } finally {
        await client.close();
      }
    });
  });

  test(`${protocol}: a destination created during the download is not replaced when overwrite is false`, async () => {
    const gate = createGate();
    await withServer(
      protocol,
      async ({ serverRoot, localRoot, connect }) => {
        await writeFile(join(serverRoot, "file.bin"), randomBytes(64 * 1024));
        const client = await connect({ FTP_LOCAL_ROOTS: localRoot });
        try {
          const target = join(localRoot, "file.bin");
          const pending = client.callTool({ name: "download-to-local", arguments: { remotePath: "/file.bin", localPath: target } });
          await gate.waiting; // the server is holding the transfer; the temp file exists by now
          assert.equal((await partFiles(localRoot)).length, 1);
          await writeFile(target, "created during the download");
          gate.release();
          const result = await pending;
          assert.equal(result.isError, true);
          assert.match(text(result), /already exists/);
          assert.equal(await readFile(target, "utf8"), "created during the download");
          assert.deepEqual(await partFiles(localRoot), [], "temporary file removed");
        } finally {
          await client.close();
        }
      },
      { gate }
    );
  });
}

test("tools/list advertises output schemas for the new tools", async () => {
  await withServer("ftp", async ({ localRoot, connect }) => {
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

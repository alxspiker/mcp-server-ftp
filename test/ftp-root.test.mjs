import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile, readFile, readdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { startFtp, startSftp, USER, PASSWORD } from "./helpers/servers.mjs";
import { parseFtpRoot, resolveRemotePath } from "../build/remote-root.js";

const text = (result) => result.content.map((c) => c.text).join("\n");

// ---------------------------------------------------------------- unit tests

test("parseFtpRoot: unset, empty, and \"/\" all disable the prefix", () => {
  assert.equal(parseFtpRoot(undefined), "");
  assert.equal(parseFtpRoot(""), "");
  assert.equal(parseFtpRoot("/"), "");
});

test("parseFtpRoot: trailing slashes are stripped and the root is made absolute", () => {
  assert.equal(parseFtpRoot("/www"), "/www");
  assert.equal(parseFtpRoot("/www/"), "/www");
  assert.equal(parseFtpRoot("/www///"), "/www");
  assert.equal(parseFtpRoot("www"), "/www");
  assert.equal(parseFtpRoot("www/"), "/www");
});

test("resolveRemotePath: disabled root passes every path through unchanged", () => {
  assert.equal(resolveRemotePath("", "/a/b.txt"), "/a/b.txt");
  assert.equal(resolveRemotePath("", "relative.txt"), "relative.txt");
  assert.equal(resolveRemotePath("", "/../etc/passwd"), "/../etc/passwd");
});

test("resolveRemotePath: a path is resolved relative to the root whether or not it starts with /", () => {
  assert.equal(resolveRemotePath("/www", "/foo.txt"), "/www/foo.txt");
  assert.equal(resolveRemotePath("/www", "foo.txt"), "/www/foo.txt");
  assert.equal(resolveRemotePath("/www", "sub/foo.txt"), "/www/sub/foo.txt");
});

test("resolveRemotePath: \"\", \"/\", and \".\" resolve to the root itself with no trailing slash", () => {
  assert.equal(resolveRemotePath("/www", ""), "/www");
  assert.equal(resolveRemotePath("/www", "/"), "/www");
  assert.equal(resolveRemotePath("/www", "."), "/www");
});

test("resolveRemotePath: \"..\" cannot climb above the root", () => {
  assert.equal(resolveRemotePath("/www", "/../etc"), "/www/etc");
  assert.equal(resolveRemotePath("/www", "../../etc/passwd"), "/www/etc/passwd");
  assert.equal(resolveRemotePath("/www", "../../../../"), "/www");
});

// ---------------------------------------------------------------- end to end, FTP and SFTP

async function tempDirs() {
  const dirs = {
    serverRoot: await mkdtemp(join(tmpdir(), "mcp-ftp-root-remote-")),
    localRoot: await mkdtemp(join(tmpdir(), "mcp-ftp-root-local-")),
  };
  // Canonical paths (macOS /var -> /private/var, Windows short names), as the server sees them.
  for (const k of Object.keys(dirs)) dirs[k] = await realpath(dirs[k]);
  return dirs;
}

const removeAll = (dirs) => Promise.all(Object.values(dirs).map((d) => rm(d, { recursive: true, force: true })));

async function withServer(protocol, fn) {
  const dirs = await tempDirs();
  const server = protocol === "sftp" ? await startSftp(dirs.serverRoot) : await startFtp(dirs.serverRoot);

  async function connect(env = {}) {
    const client = new Client({ name: "ftp-root-test", version: "1.0.0" });
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
        FTP_ROOT: "/www",
        FTP_LOCAL_ROOTS: dirs.localRoot,
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

for (const protocol of ["ftp", "sftp"]) {
  test(`${protocol}: FTP_ROOT confines every remote-path tool to the root subtree`, async () => {
    await withServer(protocol, async ({ serverRoot, localRoot, connect }) => {
      await mkdir(join(serverRoot, "www", "sub"), { recursive: true });
      await writeFile(join(serverRoot, "www", "hello.txt"), "hello from www");
      // A sibling outside the root; nothing below should ever touch it.
      await writeFile(join(serverRoot, "outside.txt"), "do not touch");

      const client = await connect();
      try {
        // list-directory "/" lists the root subtree's own contents, not the real top level.
        const listing = await client.callTool({ name: "list-directory", arguments: { remotePath: "/" } });
        assert.notEqual(listing.isError, true, text(listing));
        assert.match(text(listing), /hello\.txt/);
        assert.match(text(listing), /sub/);
        assert.doesNotMatch(text(listing), /outside\.txt/);

        // download-file reads from inside the root.
        const download = await client.callTool({ name: "download-file", arguments: { remotePath: "/hello.txt" } });
        assert.notEqual(download.isError, true, text(download));
        assert.equal(download.structuredContent.content, "hello from www");

        // upload-file writes inside the root, not at the real top level.
        const upload = await client.callTool({ name: "upload-file", arguments: { remotePath: "/new.txt", content: "created" } });
        assert.notEqual(upload.isError, true, text(upload));
        assert.equal(await readFile(join(serverRoot, "www", "new.txt"), "utf8"), "created");
        assert.equal(await readFile(join(serverRoot, "outside.txt"), "utf8"), "do not touch");

        // create-directory creates inside the root.
        const mkdirResult = await client.callTool({ name: "create-directory", arguments: { remotePath: "/newdir" } });
        assert.notEqual(mkdirResult.isError, true, text(mkdirResult));
        assert.equal((await readdir(join(serverRoot, "www"))).includes("newdir"), true);

        // append-file appends inside the root.
        const append = await client.callTool({ name: "append-file", arguments: { remotePath: "/new.txt", content: " appended" } });
        assert.notEqual(append.isError, true, text(append));
        assert.equal(await readFile(join(serverRoot, "www", "new.txt"), "utf8"), "created appended");

        // edit-file edits inside the root.
        const edit = await client.callTool({ name: "edit-file", arguments: { remotePath: "/new.txt", oldText: "created", newText: "edited" } });
        assert.notEqual(edit.isError, true, text(edit));
        assert.equal(await readFile(join(serverRoot, "www", "new.txt"), "utf8"), "edited appended");

        // rename-file renames inside the root; the sibling outside is untouched.
        const rename = await client.callTool({ name: "rename-file", arguments: { fromPath: "/new.txt", toPath: "/renamed.txt" } });
        assert.notEqual(rename.isError, true, text(rename));
        assert.equal(await readFile(join(serverRoot, "www", "renamed.txt"), "utf8"), "edited appended");
        assert.equal(await readFile(join(serverRoot, "outside.txt"), "utf8"), "do not touch");

        // delete-file deletes inside the root.
        const delFile = await client.callTool({ name: "delete-file", arguments: { remotePath: "/renamed.txt" } });
        assert.notEqual(delFile.isError, true, text(delFile));
        assert.equal((await readdir(join(serverRoot, "www"))).includes("renamed.txt"), false);

        // delete-directory deletes inside the root.
        const delDir = await client.callTool({ name: "delete-directory", arguments: { remotePath: "/newdir" } });
        assert.notEqual(delDir.isError, true, text(delDir));
        assert.equal((await readdir(join(serverRoot, "www"))).includes("newdir"), false);

        // ".." cannot climb out of the root: this resolves to <root>/outside.txt (which
        // does not exist), never to the real sibling file.
        const escape = await client.callTool({ name: "download-file", arguments: { remotePath: "/../outside.txt" } });
        assert.equal(escape.isError, true);
        assert.equal(await readFile(join(serverRoot, "outside.txt"), "utf8"), "do not touch");

        // upload-local-file / download-to-local use FTP_LOCAL_ROOTS verbatim; FTP_ROOT
        // only affects the remote side.
        await writeFile(join(localRoot, "local.bin"), "local bytes");
        const uploadLocal = await client.callTool({
          name: "upload-local-file",
          arguments: { localPath: join(localRoot, "local.bin"), remotePath: "/uploaded.bin" },
        });
        assert.notEqual(uploadLocal.isError, true, text(uploadLocal));
        assert.equal(await readFile(join(serverRoot, "www", "uploaded.bin"), "utf8"), "local bytes");
        assert.equal(uploadLocal.structuredContent.localPath, join(localRoot, "local.bin"));

        const downloadLocal = await client.callTool({
          name: "download-to-local",
          arguments: { remotePath: "/uploaded.bin", localPath: join(localRoot, "downloaded.bin") },
        });
        assert.notEqual(downloadLocal.isError, true, text(downloadLocal));
        assert.equal(await readFile(join(localRoot, "downloaded.bin"), "utf8"), "local bytes");
        assert.equal(downloadLocal.structuredContent.localPath, join(localRoot, "downloaded.bin"));
      } finally {
        await client.close();
      }
    });
  });
}

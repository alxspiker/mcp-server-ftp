import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { actorRunMode } from "../build/actor-mode.js";
import { startServer } from "../build/apify-server.js";
import { manifestRecordKey, matchGlob, runAutomation, runAutomationTool } from "../build/automation.js";
import { startFtp, startSftp, USER, PASSWORD } from "./helpers/servers.mjs";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function memoryBackend() {
  const files = new Map();
  const json = new Map();
  const items = [];
  const store = {
    async putJson(key, value) { json.set(key, JSON.parse(JSON.stringify(value))); },
    async getJson(key) { return json.has(key) ? JSON.parse(JSON.stringify(json.get(key))) : null; },
    async putFile(key, source) {
      const chunks = [];
      for await (const chunk of source) chunks.push(Buffer.from(chunk));
      files.set(key, Buffer.concat(chunks));
    },
    async getFile(key) {
      const buf = files.get(key);
      return buf ? Readable.from(buf) : null;
    },
    async delete(key) { files.delete(key); json.delete(key); },
  };
  return { files, json, items, store };
}

function servicesFor(backend, charge) {
  return {
    openStore: async () => backend.store,
    dataset: { async push(item) { backend.items.push(JSON.parse(JSON.stringify(item))); } },
    charge,
  };
}

function connectionOf(target) {
  return {
    protocol: target.protocol,
    host: "127.0.0.1",
    port: target.port,
    username: USER,
    password: PASSWORD,
    ...(target.fingerprint ? { hostKeySha256: target.fingerprint } : {}),
  };
}

async function writeTree(root, entries) {
  for (const [relative, content] of Object.entries(entries)) {
    const full = join(root, relative);
    await mkdir(dirname(full), { recursive: true });
    await writeFile(full, content);
  }
}

function fileBodies(backend, snapshotName = "backup") {
  const manifest = backend.json.get(manifestRecordKey(snapshotName));
  assert.ok(manifest, "snapshot manifest");
  return Object.fromEntries(manifest.files.map((file) => [file.path, backend.files.get(file.key).toString("utf8")]));
}

function copyFiles(backend) {
  return new Map([...backend.files].map(([key, value]) => [key, Buffer.from(value)]));
}

test("standby mode is only APIFY_META_ORIGIN=STANDBY", () => {
  assert.equal(actorRunMode({ APIFY_META_ORIGIN: "STANDBY" }), "standby");
  assert.equal(actorRunMode({}), "automation");
  for (const origin of ["DEVELOPMENT", "WEB", "API", "SCHEDULER", "TEST", "WEBHOOK", "ACTOR", "CLI", "CI", "MCP", "APIFY_AI", "standby", ""]) {
    assert.equal(actorRunMode({ APIFY_META_ORIGIN: origin }), "automation", origin);
  }
});

test("glob filters match file names and directory trees", () => {
  assert.equal(matchGlob("*.log", "skip.log"), true);
  assert.equal(matchGlob("*.log", "sub/skip.log"), true);
  assert.equal(matchGlob("*.log", "notes/secret.txt"), false);
  assert.equal(matchGlob("notes/**", "notes/secret.txt"), true);
  assert.equal(matchGlob("notes/**", "notes"), true);
  assert.equal(matchGlob("sub/*.txt", "sub/keep.txt"), true);
  assert.equal(matchGlob("sub/*.txt", "sub/nested/keep.txt"), false);
  assert.equal(matchGlob("**/*.txt", "sub/keep.txt"), true);
});

test("backup downloads a filtered tree and bills after the snapshot is saved", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-backup-"));
  await writeTree(root, {
    "keep.txt": "alpha",
    "skip.log": "nope",
    "sub/keep.txt": "beta",
    "sub/skip.log": "nope2",
    "notes/secret.txt": "hidden",
  });
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  try {
    const result = await runAutomation({
      ...connectionOf(target),
      operation: "backup",
      exclude: ["*.log", "notes/**"],
    }, servicesFor(backend, async (name) => { charges.push(name); }));
    assert.match(result.summary, /Backed up 2 files/);
    assert.deepEqual(fileBodies(backend), { "keep.txt": "alpha", "sub/keep.txt": "beta" });
    const manifest = backend.json.get(manifestRecordKey("backup"));
    assert.equal(manifest.files.find((file) => file.path === "keep.txt").sha256, sha256("alpha"));
    assert.equal(manifest.protocol, "ftp");
    assert.equal(manifest.host, "127.0.0.1");
    assert.equal(JSON.stringify(manifest).includes(PASSWORD), false);
    assert.deepEqual(charges, ["automation-file-transferred", "automation-file-transferred", "automation-run"]);
    assert.equal(backend.items.at(-1).fileCount, 2);
    assert.equal(backend.items.at(-1).bytes, Buffer.byteLength("alpha") + Buffer.byteLength("beta"));
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup works over SFTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-sftp-"));
  await writeTree(root, { "nested/hello.txt": "ssh-hello" });
  const target = await startSftp(root);
  const backend = memoryBackend();
  const charges = [];
  try {
    await runAutomation({ ...connectionOf(target), operation: "backup" }, servicesFor(backend, async (name) => { charges.push(name); }));
    assert.deepEqual(fileBodies(backend), { "nested/hello.txt": "ssh-hello" });
    assert.deepEqual(charges, ["automation-file-transferred", "automation-run"]);
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup refuses a file larger than the cap before storing or charging", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-cap-"));
  await writeFile(join(root, "big.txt"), "x".repeat(80));
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  try {
    await assert.rejects(
      () => runAutomation({ ...connectionOf(target), operation: "backup", maxFileBytes: 40 }, servicesFor(backend, async (name) => { charges.push(name); })),
      /exceeds the maximum file size of 40 bytes/,
    );
    assert.deepEqual(charges, []);
    assert.equal(backend.files.size, 0);
    assert.equal(backend.json.size, 0);
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("backup stops when streamed bytes exceed the cap even if the listing size is small", async () => {
  const backend = memoryBackend();
  const charges = [];
  const fake = {
    async listDirectory() { return [{ name: "big.bin", type: "file", size: 0, modifiedDate: "" }]; },
    async downloadToStream(_remotePath, destination) {
      destination.write(Buffer.alloc(50, 7));
      destination.end();
    },
    async uploadLocalStream() { throw new Error("should not upload"); },
    async createDirectory() { return true; },
    async deleteFile() { return true; },
  };
  await assert.rejects(() => runAutomation({
    operation: "backup", protocol: "ftp", host: "127.0.0.1", username: USER, password: PASSWORD, maxFileBytes: 20,
  }, {
    ...servicesFor(backend, async (name) => { charges.push(name); }),
    openClient: async () => ({ client: fake, close: async () => {} }),
  }), /exceeds the maximum file size/);
  assert.deepEqual(charges, []);
  assert.equal(backend.files.size, 0);
});

test("sync dry-run reports the plan and does not change the snapshot or the server", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-sync-"));
  await writeTree(root, { "a.txt": "one", "b.txt": "two" });
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  const charge = async (name) => { charges.push(name); };
  try {
    await runAutomation({ ...connectionOf(target), operation: "backup" }, servicesFor(backend, charge));
    await writeFile(join(root, "a.txt"), "ONE");
    await writeFile(join(root, "c.txt"), "three");
    const manifestBefore = JSON.stringify(backend.json.get(manifestRecordKey("backup")));
    const filesBefore = copyFiles(backend);
    const chargeCount = charges.length;
    const result = await runAutomation({
      ...connectionOf(target), operation: "sync", direction: "remote-to-store", dryRun: true, deleteExtraneous: false,
    }, servicesFor(backend, charge));
    assert.match(result.summary, /Dry run/);
    assert.equal(JSON.stringify(backend.json.get(manifestRecordKey("backup"))), manifestBefore);
    assert.equal(backend.files.size, filesBefore.size);
    for (const [key, value] of filesBefore) assert.deepEqual(backend.files.get(key), value);
    assert.equal(await readFile(join(root, "a.txt"), "utf8"), "ONE");
    const actions = backend.items.filter((item) => item.operation === "sync" && item.action !== "summary");
    const byPath = Object.fromEntries(actions.map((item) => [item.path, item.action]));
    assert.equal(byPath["a.txt"], "transfer");
    assert.equal(byPath["b.txt"], "skip");
    assert.equal(byPath["c.txt"], "transfer");
    assert.equal(actions.some((item) => item.action === "delete"), false);
    assert.deepEqual(charges.slice(chargeCount), ["automation-run"]);

    await rm(join(root, "b.txt"));
    const kept = copyFiles(backend);
    const beforeDelete = backend.items.length;
    await runAutomation({
      ...connectionOf(target), operation: "sync", dryRun: true, deleteExtraneous: true,
    }, servicesFor(backend, charge));
    for (const [key, value] of kept) assert.deepEqual(backend.files.get(key), value);
    const deleteActions = backend.items.slice(beforeDelete).filter((item) => item.action === "delete");
    assert.deepEqual(deleteActions.map((item) => item.path), ["b.txt"]);
    assert.equal(await readFile(join(root, "c.txt"), "utf8"), "three");
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("store-to-remote sync restores a deleted file and a dry-run does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-push-"));
  await writeTree(root, { "nested/hello.txt": "hello" });
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  const charge = async (name) => { charges.push(name); };
  try {
    await runAutomation({ ...connectionOf(target), operation: "backup" }, servicesFor(backend, charge));
    await rm(join(root, "nested", "hello.txt"));
    const before = charges.length;
    await runAutomation({
      ...connectionOf(target), operation: "sync", direction: "store-to-remote", dryRun: true,
    }, servicesFor(backend, charge));
    await assert.rejects(readFile(join(root, "nested", "hello.txt")));
    assert.deepEqual(charges.slice(before), ["automation-run"]);
    await runAutomation({
      ...connectionOf(target), operation: "sync", direction: "store-to-remote",
    }, servicesFor(backend, charge));
    assert.equal(await readFile(join(root, "nested", "hello.txt"), "utf8"), "hello");
    assert.deepEqual(charges.slice(before), ["automation-run", "automation-file-transferred", "automation-run"]);
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("compare reports added, changed, and removed paths against a snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-diff-"));
  await writeTree(root, { "a.txt": "one", "b.txt": "two" });
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  const charge = async (name) => { charges.push(name); };
  try {
    await runAutomation({ ...connectionOf(target), operation: "backup" }, servicesFor(backend, charge));
    const manifestBefore = JSON.stringify(backend.json.get(manifestRecordKey("backup")));
    await writeFile(join(root, "a.txt"), "ONE");
    await rm(join(root, "b.txt"));
    await writeFile(join(root, "c.txt"), "three");
    const before = charges.length;
    const result = await runAutomation({ ...connectionOf(target), operation: "compare" }, servicesFor(backend, charge));
    assert.match(result.summary, /1 added, 1 changed, 1 removed/);
    const changes = Object.fromEntries(backend.items.filter((item) => item.operation === "compare" && item.status !== "summary").map((item) => [item.path, item.status]));
    assert.deepEqual(changes, { "a.txt": "changed", "b.txt": "removed", "c.txt": "added" });
    assert.equal(JSON.stringify(backend.json.get(manifestRecordKey("backup"))), manifestBefore);
    assert.deepEqual(charges.slice(before), ["automation-run"]);
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("compare can use a second server as the baseline", async () => {
  const leftRoot = await mkdtemp(join(tmpdir(), "auto-left-"));
  const rightRoot = await mkdtemp(join(tmpdir(), "auto-right-"));
  await writeTree(leftRoot, { "a.txt": "one", "b.txt": "same" });
  await writeTree(rightRoot, { "a.txt": "two", "c.txt": "new" });
  const left = await startFtp(leftRoot);
  const right = await startFtp(rightRoot);
  const backend = memoryBackend();
  try {
    await runAutomation({
      ...connectionOf(left),
      operation: "compare",
      baseline: "server",
      compareProtocol: "ftp",
      compareHost: "127.0.0.1",
      comparePort: right.port,
      compareUsername: USER,
      comparePassword: PASSWORD,
    }, servicesFor(backend, async () => {}));
    const changes = Object.fromEntries(backend.items.filter((item) => item.status && item.status !== "summary").map((item) => [item.path, item.status]));
    assert.deepEqual(changes, { "a.txt": "changed", "b.txt": "added", "c.txt": "removed" });
  } finally {
    await left.close();
    await right.close();
    await rm(leftRoot, { recursive: true, force: true });
    await rm(rightRoot, { recursive: true, force: true });
  }
});

test("a billing failure after a saved backup does not retry the transfer", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-bill-"));
  await writeFile(join(root, "done.txt"), "saved");
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  try {
    await assert.rejects(() => runAutomation({ ...connectionOf(target), operation: "backup" }, servicesFor(backend, async (name) => {
      charges.push(name);
      if (name === "automation-run") throw new Error("billing offline");
    })), /Billing failed and the operation was not retried/);
    assert.deepEqual(fileBodies(backend), { "done.txt": "saved" });
    assert.deepEqual(charges, ["automation-file-transferred", "automation-run"]);
    const again = charges.length;
    await assert.rejects(() => runAutomation({ ...connectionOf(target), operation: "backup", snapshotName: "second" }, servicesFor(backend, async (name) => {
      charges.push(name);
      if (name === "automation-file-transferred") throw new Error("billing offline");
    })), /was saved/);
    assert.deepEqual(charges.slice(again), ["automation-file-transferred"]);
    assert.equal(fileBodies(backend, "second")["done.txt"], "saved");
  } finally {
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a normal run without operation explains how Standby is selected", async () => {
  await assert.rejects(() => runAutomation({
    operation: "", protocol: "ftp", host: "127.0.0.1", username: "x", password: "y",
  }, servicesFor(memoryBackend(), async () => { throw new Error("must not bill"); })), /APIFY_META_ORIGIN is "STANDBY"/);
});

test("Standby exposes backup-directory and the npm server does not", async () => {
  const root = await mkdtemp(join(tmpdir(), "auto-tool-"));
  await writeFile(join(root, "tool.txt"), "from-tool");
  const target = await startFtp(root);
  const backend = memoryBackend();
  const charges = [];
  const services = servicesFor(backend, async (name) => { charges.push(name); });
  const connection = connectionOf(target);
  const app = await startServer(connection, services.charge, 0, "127.0.0.1", (tool, args) => runAutomationTool(connection, tool, args, services));
  const remote = new Client({ name: "tool-test", version: "1" });
  const stdio = new Client({ name: "stdio-test", version: "1" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    env: { ...process.env, FTP_PROTOCOL: "ftp", FTP_HOST: "127.0.0.1", FTP_PORT: "21", FTP_USER: "anonymous", FTP_PASSWORD: "" },
    stderr: "pipe",
  });
  try {
    await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${app.server.address().port}/mcp`)));
    const hosted = await remote.listTools();
    assert.equal(hosted.tools.some((tool) => tool.name === "backup-directory"), true);
    assert.equal(hosted.tools.some((tool) => tool.name === "upload-local-file"), false);
    const backedUp = await remote.callTool({ name: "backup-directory", arguments: { remotePath: "/" } });
    assert.equal(backedUp.isError, undefined);
    assert.match(backedUp.content[0].text, /tool\.txt|Backed up 1 file/);
    assert.equal(fileBodies(backend)["tool.txt"], "from-tool");
    assert.deepEqual(charges, ["automation-file-transferred", "automation-run"]);

    await stdio.connect(transport);
    const local = await stdio.listTools();
    assert.equal(local.tools.some((tool) => tool.name === "backup-directory" || tool.name === "compare-directories" || tool.name === "sync-directory"), false);
    assert.equal(local.tools.some((tool) => tool.name === "list-directory"), true);
    assert.equal(local.tools.some((tool) => tool.name === "upload-local-file"), true);
  } finally {
    await stdio.close();
    await remote.close();
    await app.close();
    await target.close();
    await rm(root, { recursive: true, force: true });
  }
});

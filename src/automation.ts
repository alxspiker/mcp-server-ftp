import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Transform, Writable } from "node:stream";
import { finished } from "node:stream/promises";
import { validateInput, type Charge, type Input as ConnectionInput } from "./apify-server.js";
import { FtpClient } from "./ftp-client.js";
import { SftpClient } from "./sftp-client.js";

/** One file may not exceed 100 MiB. Callers can set a lower maxFileBytes, not a higher one. */
export const HARD_MAX_FILE_BYTES = 100 * 1024 * 1024;
export const AUTOMATION_RUN_EVENT = "automation-run";
export const AUTOMATION_FILE_EVENT = "automation-file-transferred";

const SNAPSHOT_NAME = /^[a-zA-Z0-9!\-_.'()]{1,40}$/;
const TOOL_FIELDS = [
  "remotePath", "include", "exclude", "direction", "dryRun", "deleteExtraneous", "snapshotName", "keyValueStoreId",
  "maxFileBytes", "baseline", "compareProtocol", "compareHost", "comparePort", "compareUsername", "comparePassword",
  "comparePrivateKey", "comparePassphrase", "compareHostKeySha256", "compareRemotePath",
] as const;

export interface AutomationInput extends ConnectionInput {
  operation?: string;
  remotePath?: string;
  include?: unknown;
  exclude?: unknown;
  direction?: string;
  dryRun?: unknown;
  deleteExtraneous?: unknown;
  snapshotName?: string;
  keyValueStoreId?: string;
  maxFileBytes?: unknown;
  baseline?: string;
  compareProtocol?: string;
  compareHost?: string;
  comparePort?: number;
  compareUsername?: string;
  comparePassword?: string;
  comparePrivateKey?: string;
  comparePassphrase?: string;
  compareHostKeySha256?: string;
  compareRemotePath?: string;
}

export interface RemoteClient {
  listDirectory(remotePath: string): Promise<Array<{ name: string; type: string; size: number; modifiedDate: string }>>;
  downloadToStream(remotePath: string, destination: Writable): Promise<void>;
  uploadLocalStream(source: Readable, remotePath: string): Promise<number | null>;
  createDirectory(remotePath: string): Promise<boolean>;
  deleteFile(remotePath: string): Promise<boolean>;
}

export interface SnapshotStore {
  putJson(key: string, value: unknown): Promise<void>;
  getJson<T = unknown>(key: string): Promise<T | null>;
  putFile(key: string, source: Readable): Promise<void>;
  getFile(key: string): Promise<Readable | null>;
  delete(key: string): Promise<void>;
}

export interface ResultDataset {
  push(item: Record<string, unknown>): Promise<void>;
}

export interface OpenRemote {
  client: RemoteClient;
  close: () => Promise<void>;
}

export interface AutomationServices {
  openStore(storeId?: string): Promise<SnapshotStore>;
  dataset: ResultDataset;
  charge: Charge;
  /** Tests can substitute a fake client. Production uses FTP, FTPS, or SFTP. */
  openClient?: (input: ConnectionInput) => Promise<OpenRemote>;
}

export interface AutomationResult {
  summary: string;
  structured: Record<string, unknown>;
}

export class FileTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileTooLargeError";
  }
}

/** The file work finished (or a single upload did). It was not repeated. */
export class BillingFailedError extends Error {
  readonly billingFailed = true;
  readonly completed: boolean;
  readonly structured?: Record<string, unknown>;
  constructor(message: string, options: { completed: boolean; structured?: Record<string, unknown> }) {
    super(message);
    this.name = "BillingFailedError";
    this.completed = options.completed;
    this.structured = options.structured;
  }
}

interface SnapshotFile {
  path: string;
  size: number;
  sha256: string;
  modifiedDate: string;
  key: string;
}

interface SnapshotManifest {
  version: 1;
  snapshotName: string;
  remotePath: string;
  protocol: string;
  host: string;
  createdAt: string;
  files: SnapshotFile[];
}

interface RemoteFile {
  path: string;
  remotePath: string;
  size: number;
  modifiedDate: string;
}

interface HashedFile extends RemoteFile {
  sha256: string;
}

interface SyncAction {
  path: string;
  action: "transfer" | "delete" | "skip";
  reason: string;
  size: number;
}

interface NormalizedJob {
  connection: ConnectionInput;
  operation: "backup" | "sync" | "compare";
  remotePath: string;
  include: string[];
  exclude: string[];
  direction: "remote-to-store" | "store-to-remote";
  dryRun: boolean;
  deleteExtraneous: boolean;
  snapshotName: string;
  storeId?: string;
  maxFileBytes: number;
  baseline: "snapshot" | "server";
  compare?: { connection: ConnectionInput; remotePath: string };
}

interface MirrorResult {
  files: SnapshotFile[];
  actions: SyncAction[];
  writtenKeys: string[];
  transferred: number;
}

interface ChangeRow {
  status: "added" | "changed" | "removed";
  path: string;
  size: number | null;
  baselineSize: number | null;
  sha256: string | null;
  baselineSha256: string | null;
}

export function manifestRecordKey(snapshotName: string): string {
  return `backup-${snapshotName}-manifest`;
}

/** `*` stays in one path segment. `**` crosses directories. A pattern with no slash also matches a file name in any directory. */
export function matchGlob(pattern: string, relativePath: string): boolean {
  const glob = pattern.trim().replace(/\\/g, "/").replace(/^\.\//, "");
  const target = relativePath.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!glob || !target) return false;
  if (globToRegExp(glob).test(target)) return true;
  if (glob.endsWith("/**")) {
    const prefix = glob.slice(0, -3).replace(/\/+$/, "");
    if (prefix && (target === prefix || target.startsWith(`${prefix}/`))) return true;
  }
  if (!glob.includes("/")) {
    const base = target.slice(target.lastIndexOf("/") + 1);
    if (globToRegExp(glob).test(base)) return true;
  }
  return false;
}

export async function runAutomation(input: AutomationInput, services: AutomationServices): Promise<AutomationResult> {
  const job = normalizeJob(input);
  if (job.operation === "backup") return backup(job, services);
  if (job.operation === "sync") return sync(job, services);
  return compare(job, services);
}

export async function runAutomationTool(
  base: AutomationInput,
  tool: string,
  args: unknown,
  services: AutomationServices,
): Promise<{ text: string; structured: Record<string, unknown> }> {
  const operation = tool === "backup-directory" ? "backup" : tool === "sync-directory" ? "sync" : tool === "compare-directories" ? "compare" : "";
  if (!operation) throw new Error(`Unknown automation tool "${tool}".`);
  const extra = asRecord(args);
  const input: AutomationInput = { ...base, operation };
  for (const key of TOOL_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(extra, key)) (input as unknown as Record<string, unknown>)[key] = extra[key];
  }
  const result = await runAutomation(input, services);
  return { text: result.summary, structured: result.structured };
}

export async function openRemoteClient(input: ConnectionInput): Promise<OpenRemote> {
  validateInput(input);
  if (input.protocol === "sftp") {
    const dir = await mkdtemp(join(tmpdir(), "ftp-mcp-key-"));
    try {
      let privateKeyPath = "";
      if (input.privateKey) {
        privateKeyPath = join(dir, "key");
        await writeFile(privateKeyPath, input.privateKey, { mode: 0o600 });
      }
      const client = new SftpClient({
        host: input.host,
        port: input.port ?? 22,
        user: input.username,
        password: input.password ?? "",
        passphrase: input.passphrase ?? "",
        privateKeyPath,
        hostKeySha256: (input.hostKeySha256 ?? "").replace(/^SHA256:/, ""),
      });
      return { client, close: async () => { await rm(dir, { recursive: true, force: true }); } };
    } catch (error) {
      await rm(dir, { recursive: true, force: true });
      throw error;
    }
  }
  return {
    client: new FtpClient({
      host: input.host,
      port: input.port ?? 21,
      user: input.username,
      password: input.password ?? "",
      secure: input.protocol === "ftps",
      rejectUnauthorized: true,
    }),
    close: async () => {},
  };
}

async function backup(job: NormalizedJob, services: AutomationServices): Promise<AutomationResult> {
  const store = await services.openStore(job.storeId);
  const previous = await loadManifest(store, job.snapshotName);
  const mirrored = await withRemote(job.connection, services, (client) => mirrorFromRemote(client, store, { ...job, dryRun: false }, previous, true));
  return commitMirror({ ...job, dryRun: false }, services, store, previous, mirrored, "backup");
}

async function sync(job: NormalizedJob, services: AutomationServices): Promise<AutomationResult> {
  const store = await services.openStore(job.storeId);
  if (job.direction === "store-to-remote") return syncStoreToRemote(job, services, store);
  const previous = await loadManifest(store, job.snapshotName);
  const mirrored = await withRemote(job.connection, services, (client) => mirrorFromRemote(client, store, job, previous, false));
  return commitMirror(job, services, store, previous, mirrored, "sync");
}

async function mirrorFromRemote(
  client: RemoteClient,
  store: SnapshotStore,
  job: NormalizedJob,
  previous: SnapshotManifest | null,
  replaceSnapshot: boolean,
): Promise<MirrorResult> {
  const remoteFiles = await walk(client, job.remotePath, job.include, job.exclude);
  assertListedSizes(remoteFiles, job.maxFileBytes);
  const previousByPath = new Map((previous?.files ?? []).map((file) => [file.path, file]));
  const seen = new Set<string>();
  const files: SnapshotFile[] = [];
  const actions: SyncAction[] = [];
  const writtenKeys: string[] = [];
  let transferred = 0;
  try {
    for (const remote of remoteFiles) {
      seen.add(remote.path);
      const hashed = await readToTemp(client, remote.remotePath, remote.path, job.maxFileBytes);
      try {
        const prior = previousByPath.get(remote.path);
        if (prior && prior.size === hashed.size && prior.sha256 === hashed.sha256) {
          files.push({ ...prior, modifiedDate: remote.modifiedDate });
          actions.push({ path: remote.path, action: "skip", reason: "same size and checksum", size: hashed.size });
          continue;
        }
        actions.push({ path: remote.path, action: "transfer", reason: prior ? "content differs" : "new file", size: hashed.size });
        const key = job.dryRun ? "" : newFileKey(job.snapshotName, remote.path);
        if (!job.dryRun) {
          writtenKeys.push(key);
          const source = createReadStream(hashed.filePath);
          try {
            await store.putFile(key, source);
          } finally {
            source.destroy();
          }
          transferred += 1;
        }
        files.push({ path: remote.path, size: hashed.size, sha256: hashed.sha256, modifiedDate: remote.modifiedDate, key });
      } finally {
        await rm(hashed.dir, { recursive: true, force: true });
      }
    }
  } catch (error) {
    await rollback(store, writtenKeys, error);
  }
  for (const prior of previous?.files ?? []) {
    if (seen.has(prior.path)) continue;
    const drop = replaceSnapshot || (job.deleteExtraneous && selected(prior.path, job.include, job.exclude));
    if (drop) {
      actions.push({
        path: prior.path,
        action: "delete",
        reason: replaceSnapshot ? "not included in this backup" : "not on the remote server",
        size: prior.size,
      });
    } else {
      files.push(prior);
      actions.push({
        path: prior.path,
        action: "skip",
        reason: selected(prior.path, job.include, job.exclude)
          ? "extra snapshot file kept because delete extraneous is off"
          : "outside the current filters",
        size: prior.size,
      });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  actions.sort((a, b) => a.path.localeCompare(b.path) || a.action.localeCompare(b.action));
  return { files, actions, writtenKeys, transferred };
}

async function commitMirror(
  job: NormalizedJob,
  services: AutomationServices,
  store: SnapshotStore,
  previous: SnapshotManifest | null,
  mirrored: MirrorResult,
  operation: "backup" | "sync",
): Promise<AutomationResult> {
  const warnings: string[] = [];
  if (!job.dryRun) {
    try {
      await store.putJson(manifestRecordKey(job.snapshotName), manifestOf(job, mirrored.files));
    } catch (error) {
      await rollback(store, mirrored.writtenKeys, error);
    }
    const keep = new Set(mirrored.files.map((file) => file.key));
    for (const old of previous?.files ?? []) {
      if (keep.has(old.key)) continue;
      try {
        await store.delete(old.key);
      } catch {
        warnings.push(`Could not delete the previous record for ${old.path}.`);
      }
    }
  }
  const transferred = job.dryRun ? mirrored.actions.filter((action) => action.action === "transfer").length : mirrored.transferred;
  const deleted = mirrored.actions.filter((action) => action.action === "delete").length;
  const skipped = mirrored.actions.filter((action) => action.action === "skip").length;
  const bytes = mirrored.files.reduce((sum, file) => sum + file.size, 0);
  const summary = summarizeMirror(operation, job, mirrored.files.length, bytes, transferred, deleted, skipped, warnings);
  const summaryRow: Record<string, unknown> = operation === "backup"
    ? {
      operation, snapshotName: job.snapshotName, remotePath: job.remotePath, fileCount: mirrored.files.length, bytes,
      transferred, unchanged: skipped, removed: deleted, manifestKey: manifestRecordKey(job.snapshotName), warnings,
    }
    : {
      operation, action: "summary", direction: job.direction, dryRun: job.dryRun, deleteExtraneous: job.deleteExtraneous,
      remotePath: job.remotePath, snapshotName: job.snapshotName, transferred, deleted, skipped, warnings,
    };
  const rows = operation === "sync"
    ? [...mirrored.actions.map((action) => ({ operation, direction: job.direction, dryRun: job.dryRun, remotePath: job.remotePath, snapshotName: job.snapshotName, ...action })), summaryRow]
    : [summaryRow];
  const structured: Record<string, unknown> = {
    ...summaryRow,
    paths: mirrored.files.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
    ...(operation === "sync" ? { actions: mirrored.actions } : {}),
  };
  await pushRows(services.dataset, rows);
  if (!job.dryRun) {
    for (let i = 0; i < mirrored.transferred; i += 1) {
      await chargeEvent(services.charge, AUTOMATION_FILE_EVENT, `Snapshot "${job.snapshotName}" was saved.`, true, structured);
    }
  }
  await chargeEvent(services.charge, AUTOMATION_RUN_EVENT, summary, true, structured);
  return { summary, structured };
}

async function syncStoreToRemote(job: NormalizedJob, services: AutomationServices, store: SnapshotStore): Promise<AutomationResult> {
  const manifest = await loadManifest(store, job.snapshotName);
  if (!manifest) throw new Error(`No snapshot "${job.snapshotName}" in the key-value store. Run a backup first.`);
  const sourceFiles = manifest.files.filter((file) => selected(file.path, job.include, job.exclude));
  assertListedSizes(sourceFiles.map((file) => ({ ...file, remotePath: file.path })), job.maxFileBytes);
  return withRemote(job.connection, services, async (client) => {
    const remoteFiles = await walk(client, job.remotePath, job.include, job.exclude);
    assertListedSizes(remoteFiles, job.maxFileBytes);
    const remoteByPath = new Map(remoteFiles.map((file) => [file.path, file]));
    const actions: SyncAction[] = [];
    const made = new Set<string>();
    let transferred = 0;
    for (const file of sourceFiles) {
      const remote = remoteByPath.get(file.path);
      let same = false;
      if (remote && remote.size === file.size) {
        const hashed = await readToTemp(client, remote.remotePath, remote.path, job.maxFileBytes);
        same = hashed.size === file.size && hashed.sha256 === file.sha256;
        await rm(hashed.dir, { recursive: true, force: true });
      }
      if (same) {
        actions.push({ path: file.path, action: "skip", reason: "same size and checksum", size: file.size });
        continue;
      }
      actions.push({ path: file.path, action: "transfer", reason: remote ? "content differs" : "new file", size: file.size });
      if (job.dryRun) continue;
      const body = await store.getFile(file.key);
      if (!body) throw new Error(`Snapshot "${job.snapshotName}" is missing data for "${file.path}".`);
      const destination = joinRemote(job.remotePath, file.path);
      const parent = parentRemote(destination);
      if (parent && !made.has(parent)) {
        await client.createDirectory(parent);
        made.add(parent);
      }
      const remoteSize = await client.uploadLocalStream(limitReadable(body, job.maxFileBytes, file.path), destination);
      if (remoteSize !== null && remoteSize !== file.size) {
        throw new Error(`Size mismatch after uploading "${file.path}": snapshot ${file.size} bytes, server reported ${remoteSize} bytes.`);
      }
      transferred += 1;
      await chargeEvent(services.charge, AUTOMATION_FILE_EVENT, `Uploaded "${file.path}" to ${destination}.`, false);
    }
    const sourcePaths = new Set(sourceFiles.map((file) => file.path));
    let deleted = 0;
    for (const remote of remoteFiles) {
      if (sourcePaths.has(remote.path)) continue;
      if (job.deleteExtraneous) {
        actions.push({ path: remote.path, action: "delete", reason: "not in the snapshot", size: remote.size });
        if (!job.dryRun) {
          await client.deleteFile(remote.remotePath);
          deleted += 1;
        }
      } else {
        actions.push({ path: remote.path, action: "skip", reason: "extra remote file kept because delete extraneous is off", size: remote.size });
      }
    }
    actions.sort((a, b) => a.path.localeCompare(b.path) || a.action.localeCompare(b.action));
    const wouldTransfer = actions.filter((action) => action.action === "transfer").length;
    const wouldDelete = actions.filter((action) => action.action === "delete").length;
    const skipped = actions.filter((action) => action.action === "skip").length;
    const summary = job.dryRun
      ? `Dry run (store-to-remote): would transfer ${count(wouldTransfer, "file")}, delete ${count(wouldDelete, "file")}, and skip ${count(skipped, "file")} for snapshot "${job.snapshotName}".`
      : `Synced store-to-remote snapshot "${job.snapshotName}": transferred ${count(transferred, "file")}, deleted ${count(deleted, "file")}, skipped ${count(skipped, "file")}.`;
    const summaryRow: Record<string, unknown> = {
      operation: "sync", action: "summary", direction: job.direction, dryRun: job.dryRun, deleteExtraneous: job.deleteExtraneous,
      remotePath: job.remotePath, snapshotName: job.snapshotName,
      transferred: job.dryRun ? wouldTransfer : transferred,
      deleted: job.dryRun ? wouldDelete : deleted,
      skipped, warnings: [],
    };
    const structured = { ...summaryRow, actions };
    await pushRows(services.dataset, [...actions.map((action) => ({ operation: "sync", direction: job.direction, dryRun: job.dryRun, remotePath: job.remotePath, snapshotName: job.snapshotName, ...action })), summaryRow]);
    await chargeEvent(services.charge, AUTOMATION_RUN_EVENT, summary, true, structured);
    return { summary, structured };
  });
}

async function compare(job: NormalizedJob, services: AutomationServices): Promise<AutomationResult> {
  const remote = await withRemote(job.connection, services, async (client) => hashTree(client, job.remotePath, job.include, job.exclude, job.maxFileBytes));
  let baseline: Array<{ path: string; size: number; sha256: string }>;
  let baselineLabel: string;
  if (job.baseline === "server") {
    const other = job.compare;
    if (!other) throw new Error('Compare baseline "server" requires compareProtocol, compareHost, and compareUsername.');
    baseline = await withRemote(other.connection, services, async (client) => hashTree(client, other.remotePath, job.include, job.exclude, job.maxFileBytes));
    baselineLabel = `server ${other.connection.host}`;
  } else {
    const store = await services.openStore(job.storeId);
    const manifest = await loadManifest(store, job.snapshotName);
    if (!manifest) throw new Error(`No snapshot "${job.snapshotName}" in the key-value store. Run a backup first, or set baseline to "server".`);
    baseline = manifest.files.filter((file) => selected(file.path, job.include, job.exclude));
    baselineLabel = `snapshot "${job.snapshotName}"`;
  }
  const changes = diffTrees(remote, baseline);
  const added = changes.filter((change) => change.status === "added").length;
  const changed = changes.filter((change) => change.status === "changed").length;
  const removed = changes.filter((change) => change.status === "removed").length;
  const summary = `Compared ${job.remotePath} with ${baselineLabel}: ${added} added, ${changed} changed, ${removed} removed.`;
  const summaryRow: Record<string, unknown> = {
    operation: "compare", status: "summary", added, changed, removed, remotePath: job.remotePath,
    baseline: job.baseline, snapshotName: job.snapshotName, baselineLabel,
  };
  const structured = { ...summaryRow, changes };
  await pushRows(services.dataset, [...changes.map((change) => ({ operation: "compare", ...change })), summaryRow]);
  await chargeEvent(services.charge, AUTOMATION_RUN_EVENT, summary, true, structured);
  return { summary, structured };
}

function summarizeMirror(
  operation: "backup" | "sync",
  job: NormalizedJob,
  fileCount: number,
  bytes: number,
  transferred: number,
  deleted: number,
  skipped: number,
  warnings: string[],
): string {
  const warningText = warnings.length ? ` ${warnings.slice(0, 5).join(" ")}` : "";
  if (operation === "backup") {
    return `Backed up ${count(fileCount, "file")} (${bytes} bytes) from ${job.remotePath} into snapshot "${job.snapshotName}". Copied ${count(transferred, "file")}.${warningText}`;
  }
  if (job.dryRun) {
    return `Dry run (${job.direction}): would transfer ${count(transferred, "file")}, delete ${count(deleted, "file")}, and skip ${count(skipped, "file")} for snapshot "${job.snapshotName}".${warningText}`;
  }
  return `Synced ${job.direction} snapshot "${job.snapshotName}": transferred ${count(transferred, "file")}, deleted ${count(deleted, "file")}, skipped ${count(skipped, "file")}.${warningText}`;
}

function count(amount: number, word: string): string {
  return `${amount} ${word}${amount === 1 ? "" : "s"}`;
}

async function hashTree(client: RemoteClient, remotePath: string, include: string[], exclude: string[], maxBytes: number): Promise<HashedFile[]> {
  const files = await walk(client, remotePath, include, exclude);
  assertListedSizes(files, maxBytes);
  const hashed: HashedFile[] = [];
  for (const file of files) {
    const local = await readToTemp(client, file.remotePath, file.path, maxBytes);
    hashed.push({ ...file, size: local.size, sha256: local.sha256 });
    await rm(local.dir, { recursive: true, force: true });
  }
  return hashed;
}

function diffTrees(remote: HashedFile[], baseline: Array<{ path: string; size: number; sha256: string }>): ChangeRow[] {
  const base = new Map(baseline.map((file) => [file.path, file]));
  const seen = new Set<string>();
  const changes: ChangeRow[] = [];
  for (const file of remote) {
    seen.add(file.path);
    const prior = base.get(file.path);
    if (!prior) {
      changes.push({ status: "added", path: file.path, size: file.size, baselineSize: null, sha256: file.sha256, baselineSha256: null });
    } else if (prior.size !== file.size || prior.sha256 !== file.sha256) {
      changes.push({ status: "changed", path: file.path, size: file.size, baselineSize: prior.size, sha256: file.sha256, baselineSha256: prior.sha256 });
    }
  }
  for (const prior of baseline) {
    if (seen.has(prior.path)) continue;
    changes.push({ status: "removed", path: prior.path, size: null, baselineSize: prior.size, sha256: null, baselineSha256: prior.sha256 });
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

async function walk(client: RemoteClient, root: string, include: string[], exclude: string[]): Promise<RemoteFile[]> {
  const files: RemoteFile[] = [];
  async function descend(dir: string, relative: string): Promise<void> {
    const listing = await client.listDirectory(dir);
    for (const item of listing) {
      if (!item.name || item.name === "." || item.name === ".." || /[/\\\0]/.test(item.name)) continue;
      const path = relative ? `${relative}/${item.name}` : item.name;
      if (item.type === "directory") {
        if (exclude.some((pattern) => matchGlob(pattern, path))) continue;
        await descend(joinRemote(dir, item.name), path);
      } else if (item.type === "file") {
        if (!selected(path, include, exclude)) continue;
        files.push({
          path,
          remotePath: joinRemote(dir, item.name),
          size: Number.isFinite(item.size) ? item.size : 0,
          modifiedDate: item.modifiedDate || "",
        });
      }
    }
  }
  await descend(root, "");
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

function selected(relativePath: string, include: string[], exclude: string[]): boolean {
  if (exclude.some((pattern) => matchGlob(pattern, relativePath))) return false;
  if (include.length === 0) return true;
  return include.some((pattern) => matchGlob(pattern, relativePath));
}

function assertListedSizes(files: Array<{ path: string; size: number }>, maxBytes: number): void {
  for (const file of files) {
    if (file.size > maxBytes) throw new FileTooLargeError(fileTooLarge(file.path, file.size, maxBytes, false));
  }
}

async function readToTemp(client: RemoteClient, remotePath: string, label: string, maxBytes: number): Promise<{ dir: string; filePath: string; size: number; sha256: string }> {
  const dir = await mkdtemp(join(tmpdir(), "ftp-auto-"));
  const filePath = join(dir, "object");
  const hash = createHash("sha256");
  let size = 0;
  const file = createWriteStream(filePath);
  let finishedWriting = false;
  const writer = new Writable({
    write(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) {
        callback(new FileTooLargeError(fileTooLarge(label, size, maxBytes, true)));
        return;
      }
      hash.update(buf);
      if (!file.write(buf)) file.once("drain", () => callback());
      else callback();
    },
    final(callback) {
      file.end(() => {
        finishedWriting = true;
        callback();
      });
    },
  });
  writer.on("error", () => {});
  file.on("error", (error) => writer.destroy(error));
  const writerDone = finished(writer);
  const writerSettled = writerDone.then(() => undefined, () => undefined);
  try {
    await client.downloadToStream(remotePath, writer);
    await writerDone;
    if (!finishedWriting) throw new Error(`Download of "${label}" ended before the file was flushed.`);
    return { dir, filePath, size, sha256: hash.digest("hex") };
  } catch (error) {
    writer.destroy();
    file.destroy();
    await writerSettled;
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

function limitReadable(source: Readable, maxBytes: number, label: string): Readable {
  let size = 0;
  const meter = new Transform({
    transform(chunk, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > maxBytes) callback(new FileTooLargeError(fileTooLarge(label, size, maxBytes, true)));
      else callback(null, buf);
    },
  });
  meter.on("error", () => {});
  source.on("error", (error) => meter.destroy(error));
  source.pipe(meter);
  return meter;
}

function fileTooLarge(path: string, size: number, maxBytes: number, atLeast: boolean): string {
  const seen = atLeast ? `at least ${size}` : String(size);
  return `File "${path}" is ${seen} bytes, which exceeds the maximum file size of ${maxBytes} bytes.`;
}

async function withRemote<T>(input: ConnectionInput, services: AutomationServices, fn: (client: RemoteClient) => Promise<T>): Promise<T> {
  const opened = await (services.openClient ?? openRemoteClient)(input);
  try {
    return await fn(opened.client);
  } finally {
    await opened.close();
  }
}

async function rollback(store: SnapshotStore, keys: string[], error: unknown): Promise<never> {
  const stuck: string[] = [];
  for (const key of keys) {
    try {
      await store.delete(key);
    } catch {
      stuck.push(key);
    }
  }
  const message = error instanceof Error ? error.message : String(error);
  if (stuck.length) throw new Error(`${message} Also failed to remove unfinished records: ${stuck.join(", ")}`);
  throw error instanceof Error ? error : new Error(message);
}

async function pushRows(dataset: ResultDataset, rows: Record<string, unknown>[]): Promise<void> {
  for (const row of rows) await dataset.push(row);
}

async function chargeEvent(
  charge: Charge,
  eventName: string,
  done: string,
  completed: boolean,
  structured?: Record<string, unknown>,
): Promise<void> {
  let result: Awaited<ReturnType<Charge>>;
  try {
    result = await charge(eventName);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new BillingFailedError(`${done} Billing failed and the operation was not retried. ${detail}`, { completed, structured });
  }
  if (result && typeof result === "object" && result.eventChargeLimitReached) {
    throw new BillingFailedError(`${done} The run's event spending limit has been reached. The job stopped and was not retried.`, { completed, structured });
  }
}

function manifestOf(job: NormalizedJob, files: SnapshotFile[]): SnapshotManifest {
  return {
    version: 1,
    snapshotName: job.snapshotName,
    remotePath: job.remotePath,
    protocol: job.connection.protocol,
    host: job.connection.host,
    createdAt: new Date().toISOString(),
    files,
  };
}

async function loadManifest(store: SnapshotStore, snapshotName: string): Promise<SnapshotManifest | null> {
  const value = await store.getJson<unknown>(manifestRecordKey(snapshotName));
  if (value == null) return null;
  if (!isManifest(value)) throw new Error(`Snapshot "${snapshotName}" manifest is invalid.`);
  return value;
}

function isManifest(value: unknown): value is SnapshotManifest {
  if (!value || typeof value !== "object") return false;
  const manifest = value as SnapshotManifest;
  return manifest.version === 1 && Array.isArray(manifest.files) && manifest.files.every((file) =>
    !!file && typeof file.path === "string" && typeof file.size === "number" && typeof file.sha256 === "string" && typeof file.key === "string");
}

function newFileKey(snapshotName: string, relativePath: string): string {
  const pathHash = createHash("sha256").update(relativePath).digest("hex").slice(0, 32);
  const key = `backup-${snapshotName}-${pathHash}-${randomUUID().replace(/-/g, "")}`;
  if (key.length > 256) throw new Error(`Snapshot record key for "${relativePath}" is too long.`);
  return key;
}

function joinRemote(root: string, relativePath: string): string {
  if (!relativePath) return root;
  return root === "/" ? `/${relativePath}` : `${root}/${relativePath}`;
}

function parentRemote(remoteFile: string): string | null {
  const index = remoteFile.lastIndexOf("/");
  if (index <= 0) return null;
  return remoteFile.slice(0, index);
}

function normalizeJob(input: AutomationInput): NormalizedJob {
  if (input.operation !== "backup" && input.operation !== "sync" && input.operation !== "compare") {
    throw new Error('Missing operation. Set operation to "backup", "sync", or "compare". A Standby MCP server starts only when APIFY_META_ORIGIN is "STANDBY".');
  }
  validateInput(input);
  if (input.operation === "sync" && input.direction !== undefined && input.direction !== "" && input.direction !== "remote-to-store" && input.direction !== "store-to-remote") {
    throw new Error('direction must be "remote-to-store" or "store-to-remote".');
  }
  if (input.operation === "compare" && input.baseline !== undefined && input.baseline !== "" && input.baseline !== "snapshot" && input.baseline !== "server") {
    throw new Error('baseline must be "snapshot" or "server".');
  }
  const baseline = input.baseline === "server" ? "server" : "snapshot";
  let compare: NormalizedJob["compare"];
  if (input.operation === "compare" && baseline === "server") {
    if (!input.compareProtocol || !input.compareHost || !input.compareUsername) {
      throw new Error('Compare baseline "server" requires compareProtocol, compareHost, and compareUsername.');
    }
    const connection: ConnectionInput = {
      protocol: input.compareProtocol as ConnectionInput["protocol"],
      host: input.compareHost,
      port: input.comparePort,
      username: input.compareUsername,
      password: input.comparePassword,
      privateKey: input.comparePrivateKey,
      passphrase: input.comparePassphrase,
      hostKeySha256: input.compareHostKeySha256,
    };
    validateInput(connection);
    compare = { connection, remotePath: normalizeRemoteRoot(input.compareRemotePath ?? input.remotePath) };
  }
  return {
    connection: input,
    operation: input.operation,
    remotePath: normalizeRemoteRoot(input.remotePath),
    include: stringList(input.include, "include"),
    exclude: stringList(input.exclude, "exclude"),
    direction: input.direction === "store-to-remote" ? "store-to-remote" : "remote-to-store",
    dryRun: input.operation === "sync" && optionalBoolean(input.dryRun, "dryRun"),
    deleteExtraneous: optionalBoolean(input.deleteExtraneous, "deleteExtraneous"),
    snapshotName: normalizeSnapshotName(input.snapshotName),
    storeId: optionalString(input.keyValueStoreId, "keyValueStoreId"),
    maxFileBytes: resolveMaxFileBytes(input.maxFileBytes),
    baseline,
    compare,
  };
}

function normalizeRemoteRoot(value: unknown): string {
  if (value === undefined || value === null || value === "") return "/";
  if (typeof value !== "string") throw new Error("remotePath must be a string.");
  if (value.includes("\0")) throw new Error("remotePath contains an invalid character.");
  const parts = value.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.some((part) => part === "." || part === "..")) throw new Error("remotePath must not contain . or ..");
  return `/${parts.join("/")}`;
}

function normalizeSnapshotName(value: unknown): string {
  if (value === undefined || value === null || value === "") return "backup";
  if (typeof value !== "string" || !SNAPSHOT_NAME.test(value)) {
    throw new Error("snapshotName must be 1-40 characters from a-z, A-Z, 0-9, and !-_.'().");
  }
  return value;
}

function resolveMaxFileBytes(value: unknown): number {
  if (value === undefined || value === null || value === "") return HARD_MAX_FILE_BYTES;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw new Error("maxFileBytes must be a positive integer.");
  if (value > HARD_MAX_FILE_BYTES) throw new Error(`maxFileBytes cannot exceed ${HARD_MAX_FILE_BYTES} bytes (100 MiB).`);
  return value;
}

function optionalBoolean(value: unknown, field: string): boolean {
  if (value === undefined || value === null || value === "") return false;
  if (typeof value === "boolean") return value;
  throw new Error(`${field} must be a boolean.`);
}

function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new Error(`${field} must be a string.`);
  return value;
}

function stringList(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item, index) => {
    if (typeof item !== "string" || !item.trim()) throw new Error(`${field}[${index}] must be a non-empty string.`);
    return item.trim();
  });
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("Tool arguments must be an object.");
  return value as Record<string, unknown>;
}

function globToRegExp(glob: string): RegExp {
  let pattern = "^";
  for (let i = 0; i < glob.length; i += 1) {
    const char = glob[i];
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          pattern += "(?:.*/)?";
          i += 2;
          continue;
        }
        pattern += ".*";
        i += 1;
        continue;
      }
      pattern += "[^/]*";
      continue;
    }
    if (char === "?") {
      pattern += "[^/]";
      continue;
    }
    pattern += /[.+^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`${pattern}$`);
}

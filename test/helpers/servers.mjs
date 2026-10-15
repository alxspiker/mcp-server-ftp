// Throwaway FTP and SFTP servers for the tests, serving a local directory.
// Both can hold a download at its first read until the test releases a gate, so a test
// can change the local file system while a transfer is in flight.
import { createRequire } from "node:module";
import * as fs from "node:fs";
import * as path from "node:path";

const require = createRequire(import.meta.url);
const { FtpSrv, FileSystem } = require("ftp-srv");
const { Server, utils } = require("ssh2");
const { STATUS_CODE, flagsToString } = utils.sftp;

export const USER = "tester";
export const PASSWORD = "secret";

/** A gate a server waits on before serving download data. `reached` resolves when a read is waiting. */
export function createGate() {
  let release, reached;
  const opened = new Promise((r) => (release = r));
  const waiting = new Promise((r) => (reached = r));
  return { opened, waiting, release, reached };
}

export async function startFtp(root, { gate } = {}) {
  class GatedFs extends FileSystem {
    async read(fileName, options) {
      if (gate) {
        gate.reached();
        await gate.opened;
      }
      return super.read(fileName, options);
    }
  }
  const server = new FtpSrv({ url: "ftp://127.0.0.1:0", pasv_url: "127.0.0.1", log: quietLog() });
  server.on("login", ({ connection, username, password }, resolve, reject) => {
    if (username === USER && password === PASSWORD) resolve({ root, fs: new GatedFs(connection, { root, cwd: "/" }) });
    else reject(new Error("Invalid test credentials"));
  });
  await server.listen();
  return { protocol: "ftp", port: server.server.address().port, close: () => server.close() };
}

export async function startSftp(root, { gate } = {}) {
  const hostKey = utils.generateKeyPairSync("ed25519").private;
  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on("error", () => {});
    client.on("authentication", (ctx) => {
      if (ctx.method === "password" && ctx.username === USER && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(["password"]);
    });
    client.on("ready", () => {
      client.on("session", (accept) => {
        accept().on("sftp", (acceptSftp) => serveSftp(acceptSftp(), root, gate));
      });
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    protocol: "sftp",
    port: server.address().port,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

function quietLog() {
  const noop = () => {};
  const log = { trace: noop, debug: noop, info: noop, warn: noop, error: noop, fatal: noop };
  log.child = () => log;
  return log;
}

// Minimal SFTP v3 file server over `root`: enough for open/read/write/close/stat/realpath.
function serveSftp(sftp, root, gate) {
  const handles = new Map();
  let next = 0;
  const local = (remote) => {
    const p = path.resolve(root, "." + path.posix.normalize("/" + remote));
    if (p !== root && !p.startsWith(root + path.sep)) return null;
    return p;
  };
  const fail = (reqid, err) =>
    sftp.status(reqid, err && err.code === "ENOENT" ? STATUS_CODE.NO_SUCH_FILE : STATUS_CODE.FAILURE, err ? err.message : "failure");
  const handleOf = (buf) => (buf.length === 4 ? handles.get(buf.readUInt32BE(0)) : undefined);
  const attrsOf = (st) => ({
    mode: st.mode,
    uid: st.uid,
    gid: st.gid,
    size: st.size,
    atime: Math.floor(st.atimeMs / 1000),
    mtime: Math.floor(st.mtimeMs / 1000),
  });
  let gated = false;

  sftp.on("OPEN", (reqid, filename, flags) => {
    const p = local(filename);
    if (!p) return fail(reqid);
    fs.open(p, flagsToString(flags) ?? "r", (err, fd) => {
      if (err) return fail(reqid, err);
      const h = Buffer.alloc(4);
      h.writeUInt32BE(next, 0);
      handles.set(next++, { fd });
      sftp.handle(reqid, h);
    });
  });
  sftp.on("READ", async (reqid, handle, offset, length) => {
    const h = handleOf(handle);
    if (!h) return fail(reqid);
    if (gate && !gated) {
      gated = true;
      gate.reached();
      await gate.opened;
    }
    const buf = Buffer.alloc(length);
    fs.read(h.fd, buf, 0, length, offset, (err, n) => {
      if (err) return fail(reqid, err);
      if (n === 0) return sftp.status(reqid, STATUS_CODE.EOF);
      sftp.data(reqid, buf.subarray(0, n));
    });
  });
  sftp.on("WRITE", (reqid, handle, offset, data) => {
    const h = handleOf(handle);
    if (!h) return fail(reqid);
    fs.write(h.fd, data, 0, data.length, offset, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)));
  });
  sftp.on("CLOSE", (reqid, handle) => {
    const n = handle.length === 4 ? handle.readUInt32BE(0) : -1;
    const h = handles.get(n);
    if (!h) return fail(reqid);
    handles.delete(n);
    fs.close(h.fd, (err) => (err ? fail(reqid, err) : sftp.status(reqid, STATUS_CODE.OK)));
  });
  sftp.on("FSTAT", (reqid, handle) => {
    const h = handleOf(handle);
    if (!h) return fail(reqid);
    fs.fstat(h.fd, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(st))));
  });
  const onStat = (reqid, remote) => {
    const p = local(remote);
    if (!p) return fail(reqid);
    fs.stat(p, (err, st) => (err ? fail(reqid, err) : sftp.attrs(reqid, attrsOf(st))));
  };
  sftp.on("STAT", onStat);
  sftp.on("LSTAT", onStat);
  sftp.on("FSETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("SETSTAT", (reqid) => sftp.status(reqid, STATUS_CODE.OK));
  sftp.on("REALPATH", (reqid, remote) => {
    const normalised = path.posix.normalize("/" + (remote === "." ? "" : remote));
    sftp.name(reqid, [{ filename: normalised, longname: normalised, attrs: {} }]);
  });
}

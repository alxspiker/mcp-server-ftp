// Verifies the server fails fast at startup when required connection settings
// (FTP_HOST, FTP_USER, and — depending on protocol/auth method — FTP_PASSWORD)
// are missing or empty, instead of silently falling back to defaults
// (localhost / anonymous) that would only surface as a misleading auth error
// on the first tool call. Also verifies valid SFTP key-based configurations
// are accepted without a password.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const STARTUP_TIMEOUT_MS = 5000;

/** process.env with every FTP_* var removed, plus a dummy encryption key (so
 * loadEncryptionKey() short-circuits instead of hitting the OS keychain) and
 * HOME/USERPROFILE pointed at an empty directory (so SFTP default-key
 * auto-detection is deterministic). */
function baseEnv(homeDir) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith("FTP_")) delete env[key];
  env.FTP_ENCRYPTION_KEY = "test-only-dummy-key";
  env.HOME = homeDir;
  env.USERPROFILE = homeDir;
  return env;
}

/** Spawns build/index.js with the given env and waits for it to exit, capturing
 * stderr. Rejects (killing the child) if it does not exit within the timeout —
 * used for the cases expected to fail fast at startup. */
function runStartup(env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["build/index.js"], { env, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`server did not exit within ${STARTUP_TIMEOUT_MS}ms; stderr so far: ${stderr}`));
    }, STARTUP_TIMEOUT_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stderr });
    });
  });
}

/** Connects an MCP client over stdio and confirms the server started and
 * lists tools — i.e. it did not exit during startup validation. No FTP/SFTP
 * connection is attempted here: the server opens connections lazily per tool
 * call, so this only exercises the startup config check. */
async function assertStaysRunning(env) {
  const client = new Client({ name: "startup-config-test", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["build/index.js"],
    env,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {}); // never surface child stderr in test output
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert(tools.tools.length > 0);
  } finally {
    await client.close();
  }
}

test("startup config validation", async (t) => {
  const homeDir = await mkdtemp(join(tmpdir(), "mcp-ftp-home-"));
  try {
    await t.test("nothing set: fails fast naming all three missing vars", async () => {
      const { code, stderr } = await runStartup(baseEnv(homeDir));
      assert.equal(code, 1);
      assert.match(stderr, /FTP_HOST/);
      assert.match(stderr, /FTP_USER/);
      assert.match(stderr, /FTP_PASSWORD/);
    });

    await t.test("empty-string values: treated as missing, same as unset", async () => {
      const env = baseEnv(homeDir);
      env.FTP_HOST = "";
      env.FTP_USER = "   ";
      env.FTP_PASSWORD = "";
      const { code, stderr } = await runStartup(env);
      assert.equal(code, 1);
      assert.match(stderr, /FTP_HOST/);
      assert.match(stderr, /FTP_USER/);
      assert.match(stderr, /FTP_PASSWORD/);
    });

    await t.test("FTP missing password: fails fast naming only FTP_PASSWORD", async () => {
      const env = baseEnv(homeDir);
      env.FTP_PROTOCOL = "ftp";
      env.FTP_HOST = "ftp.example.com";
      env.FTP_USER = "someone";
      const { code, stderr } = await runStartup(env);
      assert.equal(code, 1);
      assert.match(stderr, /FTP_PASSWORD/);
      assert.doesNotMatch(stderr, /FTP_HOST[^_]/);
      assert.doesNotMatch(stderr, /FTP_USER[^_]/);
    });

    await t.test("SFTP missing password with no key: fails fast naming the key alternatives", async () => {
      const env = baseEnv(homeDir);
      env.FTP_PROTOCOL = "sftp";
      env.FTP_HOST = "sftp.example.com";
      env.FTP_USER = "someone";
      const { code, stderr } = await runStartup(env);
      assert.equal(code, 1);
      assert.match(stderr, /FTP_PASSWORD/);
      assert.match(stderr, /FTP_PRIVATE_KEY_PATH/);
      assert.match(stderr, /~\/\.ssh/);
    });

    await t.test("SFTP with FTP_PRIVATE_KEY_PATH and no password: starts normally", async () => {
      const env = baseEnv(homeDir);
      env.FTP_PROTOCOL = "sftp";
      env.FTP_HOST = "sftp.example.com";
      env.FTP_USER = "someone";
      env.FTP_PRIVATE_KEY_PATH = join(homeDir, "custom-key");
      await assertStaysRunning(env);
    });

    await t.test("SFTP with a default key at $HOME/.ssh/id_ed25519 and no password: starts normally", async () => {
      const sshDir = join(homeDir, ".ssh");
      await mkdir(sshDir, { recursive: true });
      await writeFile(join(sshDir, "id_ed25519"), "dummy key material", { mode: 0o600 });
      try {
        const env = baseEnv(homeDir);
        env.FTP_PROTOCOL = "sftp";
        env.FTP_HOST = "sftp.example.com";
        env.FTP_USER = "someone";
        await assertStaysRunning(env);
      } finally {
        await rm(sshDir, { recursive: true, force: true });
      }
    });

    await t.test("FTP with all three set: starts normally", async () => {
      const env = baseEnv(homeDir);
      env.FTP_PROTOCOL = "ftp";
      env.FTP_HOST = "ftp.example.com";
      env.FTP_USER = "someone";
      env.FTP_PASSWORD = "secret";
      await assertStaysRunning(env);
    });
  } finally {
    await rm(homeDir, { recursive: true, force: true });
  }
});

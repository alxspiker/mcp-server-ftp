import Ssh2SftpClient from "ssh2-sftp-client";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isUtf8 } from "buffer";
import { randomUUID } from "crypto";
import type { FileEncoding } from "./ftp-client.js";
import { isOnePasswordRef, readOnePasswordSecret } from "./onepassword.js";

export interface SftpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  passphrase: string;     // decrypted passphrase for SSH private key; ignored when no key is found
  privateKeyPath: string; // path to SSH private key, or a 1Password reference (op://vault/item/field)
}

function resolvePrivateKey(keyPath: string): Buffer | undefined {
  const expanded =
    keyPath === "~"
      ? os.homedir()
      : keyPath.startsWith("~/")
        ? path.join(os.homedir(), keyPath.slice(2))
        : keyPath;
  if (fs.existsSync(expanded)) return fs.readFileSync(expanded);
  return undefined;
}

const DEFAULT_KEY_PATHS = ["~/.ssh/id_ed25519", "~/.ssh/id_rsa", "~/.ssh/id_ecdsa"];

async function safeDisconnect(client: Ssh2SftpClient): Promise<void> {
  try { await client.end(); } catch { /* ignore disconnect errors */ }
}

type FileEntry = { name: string; type: string; size: number; modifiedDate: string };

export class SftpClient {
  private config: SftpConfig;
  private tempDir: string;
  private privateKeyPromise: Promise<Buffer | undefined> | undefined;

  constructor(config: SftpConfig) {
    this.config = config;
    this.tempDir = path.join(os.tmpdir(), "mcp-ftp-temp");
    if (!fs.existsSync(this.tempDir)) fs.mkdirSync(this.tempDir, { recursive: true });
  }

  // Resolve key from explicit path or 1Password reference first, then fall
  // back to ~/.ssh defaults. The in-flight promise is memoized so concurrent
  // first-time connections share one resolution — 1Password is consulted at
  // most once per process (each read may trigger an authorization prompt).
  // Failures are not cached, so a transient error stays retryable.
  private resolvePrivateKeyMaterial(): Promise<Buffer | undefined> {
    this.privateKeyPromise ??= this.loadPrivateKey().catch((error) => {
      this.privateKeyPromise = undefined;
      throw error;
    });
    return this.privateKeyPromise;
  }

  private async loadPrivateKey(): Promise<Buffer | undefined> {
    let privateKey: Buffer | undefined;
    if (this.config.privateKeyPath) {
      if (isOnePasswordRef(this.config.privateKeyPath)) {
        privateKey = Buffer.from(await readOnePasswordSecret(this.config.privateKeyPath));
      } else {
        privateKey = resolvePrivateKey(this.config.privateKeyPath);
        if (!privateKey) {
          throw new Error(
            `FTP_PRIVATE_KEY_PATH is set to "${this.config.privateKeyPath}" but no key could be read from that path.`
          );
        }
      }
    } else if (!this.config.password) {
      // Only auto-detect a default SSH key when no password was configured
      // either — otherwise an unrelated local key (e.g. a personal GitHub
      // key at ~/.ssh/id_rsa) silently shadows an explicitly configured
      // FTP_PASSWORD and gets tried against a host it has nothing to do with.
      for (const p of DEFAULT_KEY_PATHS) {
        privateKey = resolvePrivateKey(p);
        if (privateKey) break;
      }
    }

    return privateKey;
  }

  private async buildClientOptions() {
    const privateKey = await this.resolvePrivateKeyMaterial();

    const clientOptions: Record<string, unknown> = {
      host: this.config.host,
      port: this.config.port,
      username: this.config.user,
    };

    if (privateKey) {
      clientOptions.privateKey = privateKey;
      if (this.config.passphrase) clientOptions.passphrase = this.config.passphrase;
    } else {
      clientOptions.password = this.config.password;
    }

    return clientOptions;
  }

  async listDirectory(remotePath: string): Promise<FileEntry[]> {
    const client = new Ssh2SftpClient();
    try {
      await client.connect(await this.buildClientOptions());
      const list = await client.list(remotePath);
      return list.map((item) => ({
        name: item.name,
        type: item.type === "d" ? "directory" : "file",
        size: item.size,
        modifiedDate: new Date(item.modifyTime).toISOString(),
      }));
    } finally {
      await safeDisconnect(client);
    }
  }

  async downloadFile(remotePath: string): Promise<{ content: string; encoding: FileEncoding }> {
    const client = new Ssh2SftpClient();
    const tempFilePath = path.join(this.tempDir, `download-${randomUUID()}-${path.basename(remotePath)}`);
    try {
      await client.connect(await this.buildClientOptions());
      await client.fastGet(remotePath, tempFilePath);
      // Read as raw bytes; only decode as utf8 when the content actually is valid utf8,
      // otherwise fall back to base64 so binary files survive the round trip
      const buffer = fs.readFileSync(tempFilePath);
      if (isUtf8(buffer)) {
        return { content: buffer.toString("utf8"), encoding: "utf8" };
      }
      return { content: buffer.toString("base64"), encoding: "base64" };
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      await safeDisconnect(client);
    }
  }

  async uploadFile(remotePath: string, content: string, encoding: FileEncoding = "utf8"): Promise<boolean> {
    const client = new Ssh2SftpClient();
    const tempFilePath = path.join(this.tempDir, `upload-${randomUUID()}-${path.basename(remotePath)}`);
    try {
      fs.writeFileSync(tempFilePath, Buffer.from(content, encoding));
      await client.connect(await this.buildClientOptions());
      await client.fastPut(tempFilePath, remotePath);
      return true;
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
      await safeDisconnect(client);
    }
  }

  async createDirectory(remotePath: string): Promise<boolean> {
    const client = new Ssh2SftpClient();
    try {
      await client.connect(await this.buildClientOptions());
      await client.mkdir(remotePath, true);
      return true;
    } finally {
      await safeDisconnect(client);
    }
  }

  async deleteFile(remotePath: string): Promise<boolean> {
    const client = new Ssh2SftpClient();
    try {
      await client.connect(await this.buildClientOptions());
      await client.delete(remotePath);
      return true;
    } finally {
      await safeDisconnect(client);
    }
  }

  async deleteDirectory(remotePath: string): Promise<boolean> {
    const client = new Ssh2SftpClient();
    try {
      await client.connect(await this.buildClientOptions());
      await client.rmdir(remotePath, true);
      return true;
    } finally {
      await safeDisconnect(client);
    }
  }

  async appendFile(remotePath: string, content: string, encoding: FileEncoding = "utf8"): Promise<boolean> {
    const client = new Ssh2SftpClient();
    try {
      await client.connect(await this.buildClientOptions());
      await client.append(Buffer.from(content, encoding), remotePath);
      return true;
    } finally {
      await safeDisconnect(client);
    }
  }

  async rename(fromPath: string, toPath: string): Promise<boolean> {
    const client = new Ssh2SftpClient();
    try {
      await client.connect(await this.buildClientOptions());
      await client.rename(fromPath, toPath);
      return true;
    } finally {
      await safeDisconnect(client);
    }
  }
}

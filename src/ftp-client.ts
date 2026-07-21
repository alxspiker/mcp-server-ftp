import { Client } from "basic-ftp";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isUtf8 } from "buffer";
import { randomUUID } from "crypto";

// Define FTP config interface
export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}

export type FileEncoding = "utf8" | "base64";

// Create FTP client wrapper
export class FtpClient {
  private config: FtpConfig;
  private tempDir: string;

  constructor(config: FtpConfig) {
    this.config = config;
    this.tempDir = path.join(os.tmpdir(), "mcp-ftp-temp");

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  // Runs an operation on a fresh connection, guaranteeing disconnect even on error
  private async withConnection<T>(operation: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client();
    client.ftp.verbose = false; // Set to true for debugging
    try {
      await client.access({
        host: this.config.host,
        port: this.config.port,
        user: this.config.user,
        password: this.config.password,
        secure: this.config.secure
      });
      return await operation(client);
    } finally {
      client.close();
    }
  }

  async listDirectory(remotePath: string): Promise<Array<{name: string, type: string, size: number, modifiedDate: string}>> {
    try {
      const list = await this.withConnection((client) => client.list(remotePath));

      return list.map(item => ({
        name: item.name,
        type: item.type === 1 ? "file" : item.type === 2 ? "directory" : "other",
        size: item.size,
        modifiedDate: item.modifiedAt ? item.modifiedAt.toISOString() : ""
      }));
    } catch (error) {
      console.error("List directory error:", error);
      throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadFile(remotePath: string): Promise<{content: string, encoding: FileEncoding}> {
    const tempFilePath = path.join(this.tempDir, `download-${randomUUID()}-${path.basename(remotePath)}`);
    try {
      await this.withConnection((client) => client.downloadTo(tempFilePath, remotePath));

      // Read as raw bytes; only decode as utf8 when the content actually is valid utf8,
      // otherwise fall back to base64 so binary files survive the round trip
      const buffer = fs.readFileSync(tempFilePath);
      if (isUtf8(buffer)) {
        return { content: buffer.toString("utf8"), encoding: "utf8" };
      }
      return { content: buffer.toString("base64"), encoding: "base64" };
    } catch (error) {
      console.error("Download file error:", error);
      throw new Error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
  }

  async uploadFile(remotePath: string, content: string, encoding: FileEncoding = "utf8"): Promise<boolean> {
    const tempFilePath = path.join(this.tempDir, `upload-${randomUUID()}-${path.basename(remotePath)}`);
    try {
      fs.writeFileSync(tempFilePath, Buffer.from(content, encoding));

      await this.withConnection((client) => client.uploadFrom(tempFilePath, remotePath));
      return true;
    } catch (error) {
      console.error("Upload file error:", error);
      throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
  }

  async createDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.ensureDir(remotePath));
      return true;
    } catch (error) {
      console.error("Create directory error:", error);
      throw new Error(`Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteFile(remotePath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.remove(remotePath));
      return true;
    } catch (error) {
      console.error("Delete file error:", error);
      throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.removeDir(remotePath));
      return true;
    } catch (error) {
      console.error("Delete directory error:", error);
      throw new Error(`Failed to delete directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async appendFile(remotePath: string, content: string, encoding: FileEncoding = "utf8"): Promise<boolean> {
    const tempFilePath = path.join(this.tempDir, `append-${randomUUID()}-${path.basename(remotePath)}`);
    try {
      fs.writeFileSync(tempFilePath, Buffer.from(content, encoding));

      await this.withConnection((client) => client.appendFrom(tempFilePath, remotePath));
      return true;
    } catch (error) {
      console.error("Append file error:", error);
      throw new Error(`Failed to append to file: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
    }
  }

  async rename(fromPath: string, toPath: string): Promise<boolean> {
    try {
      await this.withConnection((client) => client.rename(fromPath, toPath));
      return true;
    } catch (error) {
      console.error("Rename error:", error);
      throw new Error(`Failed to rename: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

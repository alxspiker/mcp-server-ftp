import SftpClient = require("ssh2-sftp-client");
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Define FTP config interface
export interface FtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  secure: boolean;
}

// Create SFTP client wrapper
export class FtpClient {
  private client: SftpClient;
  private config: FtpConfig;
  private tempDir: string;

  constructor(config: FtpConfig) {
    this.client = new SftpClient();
    this.config = config;
    this.tempDir = path.join(os.tmpdir(), "mcp-ftp-temp");

    // Create temp directory if it doesn't exist
    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  async connect(): Promise<void> {
    try {
      await this.client.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        password: this.config.password,
        // SFTP always uses secure connection, ignore the secure flag
      });
    } catch (error) {
      console.error("SFTP connection error:", error);
      throw new Error(`Failed to connect to SFTP server: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async disconnect(): Promise<void> {
    await this.client.end();
  }

  async listDirectory(remotePath: string): Promise<Array<{name: string, type: string, size: number, modifiedDate: string}>> {
    try {
      await this.connect();
      const list = await this.client.list(remotePath);
      await this.disconnect();

      return list.map((item) => ({
        name: item.name,
        type: item.type === '-' ? "file" : item.type === 'd' ? "directory" : "other",
        size: item.size,
        modifiedDate: item.modifyTime ? new Date(item.modifyTime * 1000).toISOString() : ""
      }));
    } catch (error) {
      console.error("List directory error:", error);
      throw new Error(`Failed to list directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async downloadFile(remotePath: string): Promise<{filePath: string, content: string}> {
    try {
      await this.connect();

      // Create a unique local filename
      const tempFilePath = path.join(this.tempDir, `download-${Date.now()}-${path.basename(remotePath)}`);

      // Download the file
      await this.client.fastGet(remotePath, tempFilePath);

      // Read the file content
      const content = fs.readFileSync(tempFilePath, 'utf8');

      await this.disconnect();

      return {
        filePath: tempFilePath,
        content
      };
    } catch (error) {
      console.error("Download file error:", error);
      throw new Error(`Failed to download file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async uploadFile(remotePath: string, content: string): Promise<boolean> {
    try {
      await this.connect();

      // Create a temporary file with the content
      const tempFilePath = path.join(this.tempDir, `upload-${Date.now()}-${path.basename(remotePath)}`);
      fs.writeFileSync(tempFilePath, content);

      // Upload the file
      await this.client.fastPut(tempFilePath, remotePath);

      // Clean up
      fs.unlinkSync(tempFilePath);

      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Upload file error:", error);
      throw new Error(`Failed to upload file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async createDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.connect();
      await this.client.mkdir(remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Create directory error:", error);
      throw new Error(`Failed to create directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteFile(remotePath: string): Promise<boolean> {
    try {
      await this.connect();
      await this.client.delete(remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Delete file error:", error);
      throw new Error(`Failed to delete file: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async deleteDirectory(remotePath: string): Promise<boolean> {
    try {
      await this.connect();
      await this.client.rmdir(remotePath);
      await this.disconnect();
      return true;
    } catch (error) {
      console.error("Delete directory error:", error);
      throw new Error(`Failed to delete directory: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

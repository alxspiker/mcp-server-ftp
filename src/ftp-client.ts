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
  private config: FtpConfig;
  private tempDir: string;

  constructor(config: FtpConfig) {
    this.config = config;
    this.tempDir = path.join(os.tmpdir(), "mcp-ftp-temp");

    if (!fs.existsSync(this.tempDir)) {
      fs.mkdirSync(this.tempDir, { recursive: true });
    }
  }

  private async withClient<T>(fn: (sftp: SftpClient) => Promise<T>): Promise<T> {
    const sftp = new SftpClient();
    try {
      await sftp.connect({
        host: this.config.host,
        port: this.config.port,
        username: this.config.user,
        password: this.config.password,
      });
      return await fn(sftp);
    } finally {
      try {
        await sftp.end();
      } catch {
        // Swallow close errors — primary failure (if any) has already propagated.
      }
    }
  }

  async listDirectory(remotePath: string): Promise<Array<{name: string, type: string, size: number, modifiedDate: string}>> {
    return this.withClient(async (sftp) => {
      const list = await sftp.list(remotePath);
      return list.map((item) => ({
        name: item.name,
        type: item.type === '-' ? "file" : item.type === 'd' ? "directory" : "other",
        size: item.size,
        modifiedDate: item.modifyTime ? new Date(item.modifyTime * 1000).toISOString() : ""
      }));
    });
  }

  async downloadFile(remotePath: string): Promise<{filePath: string, content: string}> {
    return this.withClient(async (sftp) => {
      const tempFilePath = path.join(this.tempDir, `download-${Date.now()}-${path.basename(remotePath)}`);
      await sftp.fastGet(remotePath, tempFilePath);
      const content = fs.readFileSync(tempFilePath, 'utf8');
      return { filePath: tempFilePath, content };
    });
  }

  async uploadFile(remotePath: string, content: string): Promise<boolean> {
    return this.withClient(async (sftp) => {
      const tempFilePath = path.join(this.tempDir, `upload-${Date.now()}-${path.basename(remotePath)}`);
      fs.writeFileSync(tempFilePath, content);
      await sftp.fastPut(tempFilePath, remotePath);
      fs.unlinkSync(tempFilePath);
      return true;
    });
  }

  async createDirectory(remotePath: string): Promise<boolean> {
    return this.withClient(async (sftp) => {
      await sftp.mkdir(remotePath);
      return true;
    });
  }

  async deleteFile(remotePath: string): Promise<boolean> {
    return this.withClient(async (sftp) => {
      await sftp.delete(remotePath);
      return true;
    });
  }

  async deleteDirectory(remotePath: string): Promise<boolean> {
    return this.withClient(async (sftp) => {
      await sftp.rmdir(remotePath);
      return true;
    });
  }
}

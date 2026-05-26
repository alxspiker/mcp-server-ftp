import SftpClient = require("ssh2-sftp-client");

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

  constructor(config: FtpConfig) {
    this.config = config;
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

  async downloadFile(remotePath: string): Promise<string> {
    return this.withClient(async (sftp) => {
      const buf = await sftp.get(remotePath);
      // sftp.get without a localDst returns a Buffer.
      return (buf as Buffer).toString("utf8");
    });
  }

  async uploadFile(remotePath: string, content: string): Promise<boolean> {
    return this.withClient(async (sftp) => {
      await sftp.put(Buffer.from(content, "utf8"), remotePath);
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

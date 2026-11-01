# FTP, FTPS & SFTP MCP Server

Connect an MCP-compatible AI assistant to your file server. List directories, read and upload files, edit or append text, create and delete directories, and rename or delete files. Each Apify task holds one server connection.

## Connect your server

1. Save this Actor as a new task and enter your server's protocol, hostname, username and password, or an SFTP private key. Apify stores password, private key and passphrase fields as secret inputs.
2. For SFTP, enter the server's SHA256 host-key fingerprint. Obtain it from your server administrator through a trusted channel. FTPS checks the server certificate. Plain FTP sends credentials and content without encryption.
3. In the task's Settings, enable **Validate and pass Actor input**. Open its Server tab and copy the **MCP server URL**. Use the task URL rather than the Actor's general URL so that your connection settings are passed to its run.
4. Add that URL to an MCP client that supports Streamable HTTP and an `Authorization: Bearer <Apify token>` header. Use a suitably scoped Apify token and keep it private.

Create a separate task for each server. Runs must use Apify's single-tenant Standby configuration. See the [setup and security notes](https://github.com/alxspiker/mcp-server-ftp/blob/main/APIFY.md) for details.

## Operations and pricing

Successful directory listings cost $0.002 each; file reads cost $0.005; uploads, edits and appends cost $0.01; and file or directory management operations cost $0.01. Failed operations do not trigger an event charge. Standby platform usage is also charged separately, including idle time before the run stops. Prices are USD.

## File handling and limits

Use `upload-file` and `download-file` for text or base64-encoded binary content. The local-path upload and download tools from the desktop package are not available: this Actor cannot access files on your own device. Incoming MCP requests are capped at 12 MiB. Downloads and edits buffer the entire file in memory; a maximum safe download size has not been established, so avoid large files.

Operations are serialized within one run. Separate runs are not coordinated; avoid conflicting concurrent writes to the same server. An operation may succeed even if a subsequent billing request fails. If that happens, the response reports the completed operation and the run stops accepting further operations.

The [original open-source package](https://github.com/alxspiker/mcp-server-ftp) remains available for local use.

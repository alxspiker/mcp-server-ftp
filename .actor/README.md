# FTP, FTPS & SFTP server

This Actor talks to an FTP, FTPS, or SFTP server in two ways.

**Standby MCP.** Save a task with your server connection and leave Operation empty. In the task's settings, enable **Validate and pass Actor input**. Open the Server tab, copy the MCP URL, and add `/mcp` if it is not already in the path. Connect an MCP client with `Authorization: Bearer <Apify token>`. Use a private, scoped token.

**Scheduled or manual job.** Set Operation to backup, sync, or compare, then run the task from Console, the API, or an Apify Schedule. The run does the job and exits. A schedule must target the task, not the Standby URL. Console → Schedules → create a schedule → choose the task and how often it should run.

Create a separate task for each server. Standby runs must stay on Apify's single-tenant configuration. Passwords, private keys, and passphrases are secret inputs. For SFTP, enter the server's SHA256 host-key fingerprint from your server administrator. FTPS checks the certificate. Plain FTP sends credentials and file contents without encryption.

## Jobs

- **Backup** copies a remote directory into a snapshot in a persistent named key-value store (or the store ID you set). Include and exclude use glob patterns. The snapshot is replaced. Files on the server are not deleted. Pick another snapshot name to keep an older copy.
- **Sync** mirrors that directory and a snapshot. Direction is remote-to-store or store-to-remote. Dry run only lists what would change. Delete extraneous files is off unless you turn it on.
- **Compare** diffs the directory against a snapshot or a second server. Added, changed, and removed paths are written to the dataset. Neither side is modified.

Files are copied one at a time. Anything over the maximum file size (100 MiB unless you set a lower limit) fails the job with an error that names the file.

By default, the store is selected from the server, username, and remote directory, so scheduled runs reuse the same snapshot. Find the store name in the job's summary output (`storeId`). To restore to a different server or directory, enter that name in Key-value store. Named stores persist until deleted and may incur storage charges. Snapshots from older runs that used an unnamed default store remain there; supply that store's ID to access them.

The same jobs are available inside Standby as the MCP tools `backup-directory`, `sync-directory`, and `compare-directories`. They use the task's saved connection.

## Pricing

Successful directory listings cost $0.002 each. File reads cost $0.005. Uploads, edits, and appends cost $0.01. File or directory management costs $0.01. Failed operations are not charged. Standby platform usage, including idle time, is billed separately. Prices are USD.

Backup, sync, and compare are charged only after the work succeeds: one `automation-run` event per finished job, and one `automation-file-transferred` event per file that was actually copied. Dry-runs, compares, skips, and deletes do not charge the per-file event.

Automation costs $0.02 per finished job and $0.005 per copied file. See the [setup notes](https://github.com/alxspiker/mcp-server-ftp/blob/main/APIFY.md).

## File handling

Use `upload-file` and `download-file` for text or base64 content. The desktop package's local-path tools are not available here. Incoming MCP requests are capped at 12 MiB. One-file MCP downloads still buffer the file; automation transfers stream instead and stop at the file-size cap.

Operations in one run happen one after another. Different runs do not coordinate, so avoid overlapping writes to the same server. If billing fails after a successful operation, the response says so and the run stops accepting more work. The transfer is not repeated.

The [open-source package](https://github.com/alxspiker/mcp-server-ftp) is still the one to run on your own computer.

# Apify-hosted FTP server

The [published Actor](https://apify.com/theprogrammer/mcp-server-ftp) can run in two ways. The npm/stdio package is unchanged.

- **Standby MCP.** When Apify sets `APIFY_META_ORIGIN` to `STANDBY`, the Actor serves the existing Streamable HTTP MCP endpoint at `/mcp`. That value is set only for runs started through Standby. The SDK reads the same variable as `Actor.config.get("metaOrigin")`. See [Detect the run mode](https://docs.apify.com/actors/development/programming-interface/standby#detect-the-run-mode).
- **One-shot job.** Any other origin — Console (`WEB` or `DEVELOPMENT`), the API (`API`), a Schedule (`SCHEDULER`), the CLI, a webhook, or another Actor — runs the `operation` in the input and then exits. Other documented origins (`TEST`, `CI`, `MCP`, and so on) take this path too.

Standby is single-tenant: one run holds one customer's connection. Do not put it in a shared pool.

## Standby MCP

1. Create an Actor in Apify Console and point its source at this repository and branch. Build it. `.actor/actor.json` selects the Dockerfile and the `/mcp` path. Connecting GitHub does not by itself publish an Actor.
2. In Standby settings, enable Standby, select a **single-tenant** deployment, and enable **Validate and pass Actor input**. Leave Operation empty on MCP tasks. Do not lock settings that users need to override. This repository cannot enforce the platform's isolation setting; check it in Console.
3. Create a task per connection. Set protocol, host, username, and credentials. Passwords, private keys, and passphrases are secret inputs. Use the task's own Standby MCP URL and append `/mcp` if it is not already there. Send `Authorization: Bearer <token>`. Prefer a scoped token. Never put a token in a public URL.
4. Test with a disposable FTP account before sharing the Actor. A new GitHub commit needs a new build, and Standby must select that build or a tag that points at it.

SFTP requires the server's SHA256 host key fingerprint, obtained from the server operator. FTPS checks the certificate. Plain FTP sends credentials and file contents without encryption. SFTP accepts a password or a pasted private key (not a path on your computer).

From an MCP client, the Standby server exposes the usual file tools plus three job tools that use the task's connection: `backup-directory`, `sync-directory`, and `compare-directories`. Those tools exist only in this Actor adapter.

## Automation jobs

Set `operation` to `backup`, `sync`, or `compare`. The same connection fields as Standby are required. New fields are optional, so an existing Standby task still starts.

| Operation | What it does |
| --- | --- |
| `backup` | Copy a remote directory into a named snapshot in the key-value store. The snapshot is replaced by this run. Remote files are not deleted. Use a different `snapshotName` when you need to keep the previous copy. |
| `sync` | Mirror `remotePath` and a snapshot. `direction` is `remote-to-store` (default) or `store-to-remote`. `dryRun` only writes the plan. `deleteExtraneous` is off unless you set it; it deletes destination files that are not in the source. Files outside the include/exclude filters are left alone. |
| `compare` | Diff the remote directory against a snapshot (`baseline` `snapshot`, the default) or a second server (`baseline` `server`, using the `compare*` fields). Nothing is modified. |

`include` and `exclude` are glob lists. A pattern with no slash matches the file name in any directory. `**` crosses directories. Exclude wins over include.

Each file is streamed to a temporary file and then to the store or the server. Only one file is in flight. A file larger than `maxFileBytes` fails the job. The default and the hard cap are 100 MiB (104857600 bytes). The error names the path and both sizes. Symlinks are not followed.

Snapshots live in the run's default key-value store, or in `keyValueStoreId` when that is set. The manifest record is `backup-<snapshotName>-manifest`. File records are separate keys named in the manifest. The manifest stores paths, sizes, and SHA-256 checksums. It does not store the password, private key, or passphrase.

Compare and sync write one dataset row per path, then a summary row. Compare statuses are `added`, `changed`, and `removed`. `added` means the path is on the primary server and not in the baseline. `removed` means the opposite. Backup writes a summary row; the file list is the manifest.

Unchanged files are recognized by size and SHA-256 and are not copied again. A sync reads each considered file to compute that checksum.

### Schedules

1. Create a task whose input includes the connection and `operation` (for example `backup`), plus the directory, filters, and snapshot name.
2. In Console, open **Schedules**, create a schedule, and choose that **task**. Set the frequency you want. Cron is available in the schedule form.
3. A scheduled run starts with origin `SCHEDULER`, not `STANDBY`, so the Actor performs the job and exits. Do not point the schedule at the Standby URL.

The Run button in Console is also a normal run (`WEB` or `DEVELOPMENT`). On an MCP task that has no `operation`, that run stops and tells you to set an operation or to use the Standby URL.

## Pricing

The published Actor uses pay-per-event pricing. These four events were configured in Apify Console on October 31, 2026. The code charges the event after the operation succeeds:

| Event name | Operations | Price per operation (USD) |
| --- | --- | ---: |
| `list-directory` | list-directory | 0.002 |
| `read-file` | download-file | 0.005 |
| `write-file` | upload-file, edit-file, append-file | 0.01 |
| `manage-files` | create-directory, delete-file, delete-directory, rename-file | 0.01 |

Automation events are charged only after the corresponding work has succeeded. They are **not** configured on the Actor yet. The prices below are **SUGGESTED**. The owner sets the live prices in Console. Until those event names exist, the Apify SDK logs a warning and does not bill them; the job still runs.

| Event name | When it is charged | Suggested price (USD) | Status |
| --- | --- | ---: | --- |
| `automation-run` | Once after a backup, sync, or compare job finishes, including a sync dry-run | 0.02 | **SUGGESTED** |
| `automation-file-transferred` | Once per file actually copied by backup or sync. Skips, deletes, compare, and dry-runs do not charge this | 0.005 | **SUGGESTED** |

For backup and remote-to-store sync, file events are charged after the snapshot manifest has been saved. For store-to-remote sync, each file event is charged after that upload succeeds. If charging throws, the transfer is not repeated. The run reports that the work completed and billing failed, and further operations in that process are disabled. Billing and the file transfer are not one transaction.

A separate deployment must configure its own prices. Standby users also pay platform usage, including idle time until shutdown.

## Limits

`upload-local-file` and `download-to-local` are not available on the Actor: a hosted process cannot read the customer's computer. Use `upload-file` and `download-file` for text or base64 content. Incoming MCP requests are capped at 12 MiB. Single-file MCP downloads and edits still buffer the whole file; automation jobs stream and enforce `maxFileBytes` instead.

Operations inside one run are serialized. Separate runs are not coordinated, so avoid conflicting writes to the same server. A new FTP connection is opened for each file operation.

Apify authenticates Standby requests before they reach the container. The application does not add its own check on a direct container request. Review isolation, network access, billing, and credentials when you operate a deployment.

## What the owner configures in Console

This repository does not publish the Actor or change its prices.

1. Build the Actor from the commit you want to run.
2. Under pay per event, add `automation-run` and `automation-file-transferred` if you want those jobs to be billed. The table above is a suggestion, not a live price.
3. Keep Standby single-tenant, with input passing turned on, for MCP tasks.
4. For backups and syncs, create a task with `operation` set and attach an Apify Schedule to that task.

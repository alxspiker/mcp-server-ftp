# Apify-hosted FTP MCP server

The [published Apify Actor](https://apify.com/theprogrammer/mcp-server-ftp) provides a Streamable HTTP MCP endpoint backed by the existing stdio FTP server. The ordinary npm/stdio entry point is unchanged. The hosted adapter is for **single-tenant Standby runs only**: a run contains one user's connection credentials. Do not deploy it in a shared/multi-tenant Standby pool.

## Set up your own Actor deployment

1. Create an Actor in Apify Console and configure its source to use this GitHub repository and the desired branch. Build it; `.actor/actor.json` selects the Actor-specific Dockerfile and `/mcp` endpoint. Connecting GitHub and pushing code alone does not create or publish an Actor.
2. In Actor Standby settings, enable Standby, select a **single-tenant** deployment, and enable **Validate and pass Actor input**. Do not lock settings that users need to override in their tasks. Verify the live setting in Console before use; this repository cannot enforce the platform's isolation setting.
3. Create a task for each connection. Set its protocol, host, username and credentials, and enable input passing in its Standby settings. Passwords, private keys and passphrases are Apify secret inputs. Use the task's own Standby MCP URL shown by Apify; append `/mcp` if the displayed URL does not already contain it. Authenticate with the customer's Apify token in the `Authorization: Bearer ...` header. Prefer a scoped token suitable for Standby. Never put a token into a public URL.
4. Test privately with a disposable FTP account before publishing. Test each customer task separately. Updates to GitHub require an Apify build, and the Standby configuration must select the resulting build or a tag pointing to it.

The SFTP host key SHA256 fingerprint is required; obtain it through a trusted channel from the server operator. FTPS validates certificates. Plain FTP transmits credentials and data without encryption and should only be used when that risk is acceptable. SFTP supports password or private-key authentication. For a private key, paste its contents in the secret field, not a path on your computer.

## Pricing

The published Actor uses pay-per-event pricing. The following prices were configured in Apify Console on October 31, 2026. The code charges the corresponding event after a successful operation:

| Event name | Operations | Price per operation (USD) |
| --- | --- | ---: |
| `list-directory` | list-directory | 0.002 |
| `read-file` | download-file | 0.005 |
| `write-file` | upload-file, edit-file, append-file | 0.01 |
| `manage-files` | create-directory, delete-file, delete-directory, rename-file | 0.01 |

A live FTPS listing succeeded in an owner-account test after monetization was enabled. For a separate deployment, configure and verify its pricing in Apify Console. Standby users also pay platform usage, including idle time until shutdown. If charging throws after an operation has already succeeded, the result states that the operation completed and further operations in that run are disabled; it is not retried. Billing and FTP changes cannot be made as a single atomic transaction.

## Limits

`upload-local-file` and `download-to-local` are intentionally unavailable: a hosted process cannot access the customer's computer. Use `upload-file` and `download-file` for text or base64 binary content. Incoming MCP requests are capped at 12 MiB. Downloads and edits currently buffer entire files in memory, so do not use large files; there is no tested maximum download size. The server serializes operations within a single Actor run; separate concurrent runs for the same FTP account are not coordinated, so clients must avoid concurrent conflicting writes. A new connection is established for each FTP operation.

Apify authenticates requests before forwarding them to Standby; the application does not independently authenticate a direct container request. Its security depends on Apify's access controls and single-tenant run isolation. Review isolation, network access, limits, billing, and credential handling when operating a deployment.

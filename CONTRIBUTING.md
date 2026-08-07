# Contributing

Use pull requests for code changes. Keep releases separate from development work so npm and Smithery only get code that is already on `main`.

## Before opening a pull request

Create a branch from `main`, make the change, then run:

```bash
npm install
npm run build
```

If the change affects user-facing behavior, update `README.md` and `CHANGELOG.md` in the same pull request.

Do not commit passwords, API keys, npm tokens, Smithery tokens, private keys, or generated credential files.

## Version updates

For a release, update the version in all three places:

- `package.json`
- `manifest.json`
- the `version` passed to `McpServer` in `src/index.ts`

Keep all three versions identical. The value in `src/index.ts` is reported by the server during MCP initialization, so leaving it unchanged would make the running server report an older version than npm and Smithery.

Build the project before publishing:

```bash
npm install
npm run build
```

## Publish to npm

The package name is `mcp-server-ftp`.

You need publish access to the package on npm. Once the release changes are merged to `main`:

```bash
npm login
npm publish
```

Check the published version:

```bash
npm view mcp-server-ftp version
```

Do not publish from an unmerged feature branch unless the release is intentionally a prerelease.

## Publish to Smithery

The Smithery server is owned by the team account:

```text
alxspikers-team/mcp-server-ftp
```

You need access to that Smithery team before publishing.

Smithery uses an `.mcpb` bundle. This repository's `manifest.json` includes `tools[].inputSchema`, which Smithery expects but Anthropic's MCPB validator rejects. Package the bundle as a normal ZIP instead of using `mcpb pack`.

Start from a clean checkout of the merged release on `main`:

```bash
npm install
npm run build
```

Create a temporary staging directory and copy these files into it:

```text
build/
package.json
manifest.json
LICENSE
README.md
```

Inside the staging directory, install production dependencies only:

```bash
npm install --omit=dev --ignore-scripts
```

Create the bundle from inside that staging directory:

```bash
zip -r bundle.mcpb .
```

Publish it to the team listing:

```bash
smithery mcp publish bundle.mcpb -n alxspikers-team/mcp-server-ftp
```

After publishing, open the Smithery listing and confirm the new version is shown.

## Release checklist

Before calling a release finished, check that:

- the release commit is on `main`
- `package.json`, `manifest.json`, and `src/index.ts` have the same version
- `npm run build` passes
- npm shows the new package version
- Smithery shows the new server version

GitHub access alone does not grant npm or Smithery publishing access. Each registry has its own maintainer permissions.

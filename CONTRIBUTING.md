# Contributing

Use pull requests for code changes. Keep releases separate from development work so npm only gets code that is already on `main`.

## Before opening a pull request

Create a branch from `main`, make the change, then run:

```bash
npm install
npm run build
```

If the change affects user-facing behavior, update `README.md` and `CHANGELOG.md` in the same pull request.

Do not commit passwords, API keys, npm tokens, private keys, or generated credential files.

## Version updates

Any significant change that will be merged to `main` needs a version bump in the same pull request. This includes new features, bug fixes, MCP tool or protocol changes, configuration changes, and other changes users should receive as an update. Small documentation-only or internal maintenance changes do not need a release unless they affect installation or published package behavior.

For a release, update the version in all three places:

- `package.json`
- `manifest.json`
- the `version` passed to `McpServer` in `src/index.ts`

Keep all three versions identical. The value in `src/index.ts` is reported by the server during MCP initialization, so leaving it unchanged would make the running server report an older version than npm.

Build the project before publishing:

```bash
npm install
npm run build
```

## GitHub release and tag

After a versioned pull request is merged to `main`, create a GitHub Release for that version using a matching `vX.Y.Z` tag. For example, version `1.2.1` uses tag `v1.2.1`.

The tag should point at the merged release commit on `main`. Use the GitHub Release notes to summarize the changes included in that version. The repository already uses this format for releases such as `v1.1.0` and `v1.2.0`.

Do not reuse or move an existing release tag to a different commit. If another release is needed, bump the version again and create a new tag.

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

## Smithery (retired)

Smithery is shutting down its hosted URLs, API, accounts, API keys, and CLI/SDKs on October 31, 2026. The `.mcpb` bundle publish step to Smithery has been removed from the release process; npm is the primary distribution channel. Do not publish new versions to Smithery.

## Release checklist

Before calling a release finished, check that:

- the release commit is on `main`
- `package.json`, `manifest.json`, and `src/index.ts` have the same version
- `npm run build` passes
- a GitHub Release exists with the matching `vX.Y.Z` tag
- the tag points at the release commit on `main`
- npm shows the new package version

GitHub access alone does not grant npm publishing access. npm has its own maintainer permissions.

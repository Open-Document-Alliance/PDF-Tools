# Release Guide

This is a lightweight checklist for shipping a new release.

## 1) Version bump

Update these files together:

- `package.json`
- `manifest.json`
- `manifest.mcpb.json`

## 2) Build artifacts (locally)

```
npm install
npm install -g @anthropic-ai/mcpb
mcpb pack
node package-for-friend.js
```

## 3) Manual verification

Run the manual test checklist in `docs/MAINTAINERS.md`.

## 4) Publish

- Create a GitHub release.
- Attach the generated `.mcpb` and `pdf-toolkit-mcp.zip` files.
- Do not commit binary artifacts into main.

## 5) Post-release

- Verify the Releases page links in README still point to the latest build.
- Confirm Claude Desktop installation and Cursor install flow with a clean machine.

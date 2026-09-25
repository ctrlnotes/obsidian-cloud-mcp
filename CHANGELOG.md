# Changelog

Each release's section becomes its release notes. Newest first.

## 0.0.2

- **Installs on desktop Obsidian again.** 0.0.1 asked for Obsidian 1.13.8, which was only
  ever released for Android, so no desktop Obsidian could install it. This release needs
  1.13.4 or later.

## 0.0.1

The first release.

- Pair this vault with a Ctrl Notes vault from **Settings → Ctrl Notes Cloud MCP**: your
  browser opens, you choose the vault, and you confirm the connection back in Obsidian.
- Notes and other text files (Markdown, `.canvas`, `.base`, `.txt`) sync both ways while
  Obsidian is open, with deletes and renames. Attachments sync on desktop.
- An edit you have not synced yet is never overwritten: when two versions cannot be merged,
  yours is kept beside the other as a conflict copy.
- AI agents reach the same vault through the Ctrl Notes MCP server,
  `https://mcp.ctrlnotes.app/mcp`.

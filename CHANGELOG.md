# Changelog

Each release's section becomes its release notes. Newest first.

## Unreleased

- **A busy vault no longer stops a sync.** When the vault closes the connection it now says
  whether to come back, and the plugin reconnects by itself unless the vault says not to
  (for example, a device that was removed). A vault that has not been updated yet is
  always reconnected to, at most every five minutes. Reconnecting pops no notice; the
  settings pane says so beside the number of changes still to send.
- **An upload in progress keeps its vault awake.** While changes are waiting to be sent, a
  reconnect waits at most 30 seconds, so a large first sync is never left half-finished
  while its vault goes to sleep.
- Speaks sync protocol version 4, and still version 3 for vaults not yet updated. Vaults
  on version 4 refuse older plugins with a message asking you to update.

## 0.0.3

- Updated the signing library the plugin uses to prove it is your device
  (`@noble/ed25519` 3.2.0), and the bundler that builds it. No change in behaviour.

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

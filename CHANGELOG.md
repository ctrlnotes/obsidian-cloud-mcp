# Changelog

Each release's section becomes its release notes. Newest first.

## 0.1.0

- **See which AI agents can reach this vault.** The settings pane now lists every agent
  connected to your Ctrl Notes vault, whether it can only read or can also write, and when
  it was last used, with a link to manage them in the web app. With none yet, it shows the
  command that connects Claude Code. The list loads when you open the pane and on Refresh.
- **Sync status in the status bar.** A small icon and one word (Synced, Syncing, Idle,
  Reconnecting, Error, Not paired) on desktop; click it, or press Enter on it, to open the
  settings.
- **A clearer settings pane.** Sync status comes first, your vault is shown by name, and the
  two server addresses moved under Advanced. The status reads as short lines with real
  plurals, and **Show files** lists every file that is not syncing and why.
- **Fewer dead ends.** A device that was removed from your vault offers **Pair again…**
  (after asking, because it replaces this device's key); any other refusal offers a harmless
  **Try again**. While waiting for your browser you can open it again or cancel. **Sync
  now** only appears when there is something it can do.
- Connecting a device now highlights **Connect** and shows the vault id in a short form;
  **Disconnect…** asks before it erases this device's key; messages are worded
  consistently.

## 0.0.4

- **A busy vault no longer stops a sync.** When the vault closes the connection it now says
  whether to come back, and the plugin reconnects by itself unless the vault says not to
  (for example, a device that was removed). A vault that has not been updated yet is
  always reconnected to, and one that refuses this device is retried at most every five
  minutes. Reconnecting pops no notice; the settings pane says so beside the number of
  changes still to send, in the vault's own words, and stops saying so once sync stops.
  Reconnecting this way does not re-read every file in the vault, and a full re-read never
  runs twice at once.
- **An upload in progress keeps its vault awake.** While changes are waiting to be sent, a
  reconnect waits at most 30 seconds, and a vault that is accepting uploads is reconnected
  to quickly however often it closes, so a large first sync is never left half-finished
  while its vault goes to sleep — including while the plugin is still reading the files
  it will send.
- **A first sync uploads notes in batches.** Against a vault that supports it, up to 100
  small files (or 4 MiB) go up in one round trip instead of one each, so a large vault's
  first sync takes minutes rather than hours. Larger files, deletes and renames go one at
  a time as before, and so does everything against a vault that has not been updated.
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

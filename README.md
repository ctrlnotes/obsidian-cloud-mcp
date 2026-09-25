# Ctrl Notes Cloud MCP

Connect your Obsidian vault to Claude Code and other AI agents. This plugin syncs the vault
with [Ctrl Notes](https://ctrlnotes.app), a hosted copy of your notes that agents reach
through a remote MCP server you sign in to. An edit an agent makes appears here; an edit
you make here is there for the agent. Every device that pairs with the same Ctrl Notes
vault stays in step with the others.

**Not in Obsidian's community directory yet.** Until it is, install it with
[BRAT](https://github.com/TfTHacker/obsidian42-brat), which installs plugins from their GitHub
releases and keeps them updated:

1. In **Settings → Community plugins**, install and enable **BRAT**.
2. Run **BRAT: Plugins: Add a beta plugin for testing** from the command palette.
3. Enter `ctrlnotes/obsidian-cloud-mcp`, choose **Latest version**, and press **Add plugin**.

It needs Obsidian 1.13.4 or later. Once it is listed, install it from
**Settings → Community plugins** by searching for "Ctrl Notes".

## Before you install

Ctrl Notes is a **hosted service**, and this plugin is only useful with it. The Obsidian
community directory asks plugins to state the following up front, and so do we.

- **An account is required.** You sign in to [ctrlnotes.app](https://ctrlnotes.app) with
  a Google account or your email address.
- **Payment is required for continued use.** A free **7-day trial**, for one vault with
  10 GB, starts when you pair your first device. Some accounts, including most that sign
  up with an email address at their own or a company's domain, are not offered the trial
  and start on the paid plan. After that, the standard plan is **$25
  per vault per month**, with 10 GB included per vault and $1 per GB per month above that.
  Current pricing is on [ctrlnotes.app](https://ctrlnotes.app).
- **It uses the network, and only these services:**
  - `https://sync.ctrlnotes.app`: the Ctrl Notes control plane. This device registers a
    pairing request there, and the sync connection (a WebSocket) is made to it. The
    control plane routes that connection to your vault and never stores your notes.
  - `https://ctrlnotes.app`: opened in **your browser**, not by the plugin, when you pair
    a device. It is where you sign in and choose which vault this device joins.
  - Your Ctrl Notes vault, reached only through the control plane. It holds the synced
    copy of your notes and attachments.

  Both addresses are editable in the plugin's settings so the plugin can be pointed at a
  development build. The Ctrl Notes service itself is not open source and is not offered
  for self-hosting.

  The MCP server your agent connects to (`https://mcp.ctrlnotes.app/mcp`) is used by the
  agent, never by this plugin.
- **What the service keeps about you** is described in the
  [privacy policy](https://ctrlnotes.app/privacy). The plugin itself sends no analytics or
  usage telemetry. The only data it sends is your notes, your attachments and what pairing
  and syncing need.
- **Where it is offered.** Ctrl Notes is not offered in the European Economic Area, the
  United Kingdom or Switzerland. Elsewhere, your account and your vault are processed in
  the United States.
- **Files outside the vault.** The plugin reads and writes only inside this vault, and it
  never syncs the vault's configuration folder (`.obsidian`, or wherever you have moved
  it), so other plugins' settings stay on this device. Nor does it sync anything else at
  the top of the vault whose name starts with a dot (another device's config folder,
  Obsidian's `.trash`, a hidden file); Obsidian hides those from the vault anyway.

## Pairing a device

1. Open **Settings → Ctrl Notes Cloud MCP** and press **Pair**.
2. Your browser opens at ctrlnotes.app. Sign in if you need to, and choose which vault
   this device joins, or create one.
3. Back in Obsidian, confirm the connection when asked. Nothing is connected until you
   do.

If the browser opens and you are **signed out**, sign in and then press **Pair** in
Obsidian again. The pairing request does not survive the sign-in (the page at `/app/pair`
tells you so), so a fresh one is needed.

Pairing never shows or asks for a code. The request is tied to a key this device
generates, which never leaves it, so only this device can complete it. **Only confirm a
pairing you started yourself**: a pairing link somebody else sends you would connect
*their* device to *your* vault, which is why the page in your browser warns you about it.

## Connecting an agent

Pair a device first, so your vault has your notes in it. Then point your agent at the
Ctrl Notes MCP server:

```text
https://mcp.ctrlnotes.app/mcp
```

In Claude Code:

```bash
claude mcp add --transport http ctrlnotes https://mcp.ctrlnotes.app/mcp
```

Then run `/mcp` in Claude Code and authenticate. Your browser opens at ctrlnotes.app:
sign in, pick the vault if you have more than one, and choose read only (the default) or
read and write. Ready-made agent plugins, with a skill that teaches the agent to edit
safely, are at [ctrlnotes/agent-plugins](https://github.com/ctrlnotes/agent-plugins).

The server speaks MCP over Streamable HTTP and signs you in with OAuth. Claude Code is the
client we have tested end to end.

## What syncs

Once paired, the plugin syncs in both directions while Obsidian is open:

- **Notes and other text files**: Markdown, `.canvas`, `.base` and `.txt`.
- **Attachments** such as images and PDFs, on desktop. **Mobile still carries no
  attachments**: that is a choice, so a phone on a metered connection does not download a
  vault's worth of images.
- **Deletes and renames**, from any device or agent.

A few things to know:

- **An edit you have not synced yet is never overwritten.** If an agent or another device
  changes a note you have also changed, including while you were offline, the two versions
  are merged. When they touch the same words and cannot be merged, the other version stays
  in the note and yours is saved beside it as a conflict copy, so neither is lost. An edit
  also wins over a delete: a note you edited is kept, even if it was deleted elsewhere.
- **A file larger than 8 MiB is skipped**, and counted in the settings pane rather than
  silently missing.
- **A note whose bytes are not UTF-8 text** (for example a `.md` or `.txt` re-saved as
  UTF-16 by another editor) is **withheld by this device**, because the vault reads every
  note as text. The settings pane counts it under "not synced by this device"; re-save it
  as UTF-8 and it syncs.
- Typing that Obsidian has not yet saved to disk is not visible to any plugin. Obsidian
  saves within a couple of seconds, and it is synced from there.

## Settings, and what "Disconnect this device" does

Two addresses, both prefilled with the hosted service's and both editable:

- **Control plane**: where this device registers a pairing and where the sync connection
  is made. This is the *direct* hostname (`https://sync.ctrlnotes.app`), not the web
  app's, because the plugin is not a browser and does not go through the web front end.
- **Web app**: where your browser confirms a device and lists the devices on your vaults
  (`https://ctrlnotes.app`).

There is deliberately **no vault-id field**. The vault is chosen in the browser, from the
vaults you own, and adopted here only after you confirm it in Obsidian.

**"Disconnect this device" is local.** It forgets this device's registration and erases
its private key from this computer, so this installation can no longer prove it is that
device. It is **not** a revocation: the vault keeps trusting the registration until it is
removed from the device list at ctrlnotes.app. If a device is lost, revoke it there;
disconnecting on a device you still hold is not a substitute.

If a device is revoked while it is running, the vault refuses its next connection with a
deliberately uninformative *"not authorised"*, the same answer an unknown device gets, so
that nobody can probe which devices exist. The settings pane explains what that most
likely means.

## Security

- Each device has its own key pair. The private key is kept in Obsidian's secret storage
  and never leaves the device; the device proves it holds the key on every connection
  rather than presenting a password or token.
- Your vault runs as its own application on its own private network. Its database and
  every attachment in it are encrypted with a key the vault generates itself. See the
  [privacy policy](https://ctrlnotes.app/privacy) for what that does and does not cover.

## Development

Issues and pull requests are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

```bash
bun install --frozen-lockfile   # every dependency is pinned exactly
bun run typecheck
bun run lint               # Biome, then Obsidian's own review rules at zero warnings
bun run test
bun run build              # writes main.js
bun run install-to-vault -- /absolute/path/to/a/vault   # copy the build in to try it
```

`lint` runs the Obsidian community directory's own review rules
(`eslint-plugin-obsidianmd`, pinned), so a release meets nothing CI has not already.

The plugin reads and writes files through Obsidian's `DataAdapter` rather than the `Vault`
API that Obsidian's guidelines prefer. That is deliberate for a sync engine: it has to
move exact bytes (a text file's byte-order mark included), rename and trash without
triggering its own change detection, and read files the metadata cache may not have
indexed yet. Every path it touches is checked first (`src/sync/safe-path.ts`).

## Licence

The plugin is [MIT-licensed](LICENSE). That covers this plugin's source only; the
Ctrl Notes service it connects to is proprietary. `main.js` opens with the licence of every
package it bundles (today, `@noble/ed25519`, also MIT), because minifying removes their
notices from the code itself.

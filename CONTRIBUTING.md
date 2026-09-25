# Contributing

Thanks for looking. This repository is **published from a private monorepo**: every file
here is written by an export step, so a pull request against it cannot be merged as it
stands. What helps most:

- **Bug reports and questions**: open an issue. Say which Obsidian version and platform
  you are on, and what the plugin's settings pane shows under **Sync**.
- **A fix you have written**: open a pull request anyway. If it is taken, it is ported
  into the monorepo with you credited as a co-author in the commit, it arrives here with
  the next sync, and your pull request is closed with a link to it.
- **Security issues**: do not open a public issue. Email security@ctrlnotes.app.

To build it yourself: `bun install`, then `bun run typecheck`, `bun run lint` and
`bun run build`. The test suite runs in the monorepo, because parts of it check this
plugin against the service's own source.

Comments in the source cite design documents and service code by path and id
(`docs/…`, `apps/…`, `D19`, `PL8`). Those live in the private repository; the comment
around each one says what it decided.

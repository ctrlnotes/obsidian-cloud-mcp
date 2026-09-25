# Contributing

Thanks for looking. Issues and pull requests are welcome.

- **Bug reports and questions**: open an issue. Say which Obsidian version and platform
  you are on, and what the plugin's settings pane shows under **Sync**.
- **Pull requests**: run `bun run typecheck`, `bun run lint` and `bun run test` first;
  CI runs the same, plus the build. `lint` includes Obsidian's own review rules at zero
  warnings, because a release that fails the community directory's review is delisted.
- **Security issues**: do not open a public issue. Report privately through GitHub
  (Security → Report a vulnerability) or email security@ctrlnotes.app.

**The wire examples under `test-fixtures/wire/`** are the Ctrl Notes service's protocol:
what the vault and control plane send and expect. The service is not open source and
keeps its own copy of these. Changing one here does not change what the service does, so
a pull request that needs a protocol change should start as an issue.

Comments in the source sometimes cite the service's design documents by path and id
(`docs/…`, `apps/…`, `D19`, `PL8`). Those are not public; the comment around each one
says what it decided.

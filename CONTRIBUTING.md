# Contributing

Use Node 22.12+ and the pinned pnpm version. Run `pnpm install`, `pnpm check`, `pnpm test`, and `pnpm build` before opening a pull request.

Keep UI, IPC, authentication and the game core separate. Do not expose access tokens or arbitrary filesystem/process access through the renderer bridge. Test download failure, cancellation, path validation and platform-specific rules when touching the installer.

Do not commit `.local/`, game files, account caches, device login codes, credentials, crash dumps containing personal paths, or screenshots of personal accounts. Use synthetic fixtures in tests.

File a small issue describing the problem, expected behavior and reproduction steps. For security reports, use GitHub private vulnerability reporting when available instead of publishing credentials or exploit details in an issue.

PCL, HMCL and Modrinth are references; do not copy their code or artwork without verifying the exact license and documenting it.

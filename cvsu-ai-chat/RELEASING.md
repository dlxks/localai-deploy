# Releasing CvSU-AI VSCode Chat (maintainer guide)

Repo: **https://github.com/Cavite-State-University-Official/localai-vscode-chat** (private = invite-only).

Releases are automated by `.github/workflows/release.yml`: pushing a `vX.Y.Z`
tag builds the `.vsix` and attaches it to a GitHub Release with auto-generated notes.

## One-time setup (already done)

The private repo exists and the code is pushed. For reference, this is how it was set up:

```bash
gh auth login                                     # authenticate (browser)
cd localai-vscode
gh repo create localai-vscode-chat --private --source=. --remote=origin --push
```

(Private is what makes distribution invite-only — only collaborators you add can
see Releases.)

## Inviting team members

Add them as repo collaborators (read access is enough to download Releases).
Use a bare username — no angle brackets:

```bash
gh repo add-collaborator Cavite-State-University-Official/localai-vscode-chat THEIR_USERNAME --permission read
```

Or via the repo's **Settings → Collaborators** page. That invitation is how they
get access to install and update.

## Cutting a release

Update `CHANGELOG.md`, then run ONE of:

```bash
npm run release:patch   # 0.5.0 -> 0.5.1   (bug fixes)
npm run release:minor   # 0.5.0 -> 0.6.0   (new features)
npm run release:major   # 0.5.0 -> 1.0.0   (breaking changes)
```

Each script: bumps the version in `package.json`, commits, creates a `vX.Y.Z`
tag, and pushes with the tag. The push triggers the workflow, which builds and
publishes the Release with the `.vsix` attached. Watch it under the repo's
**Actions** tab; the asset appears under **Releases** when green.

## Manual release (without the workflow)

```bash
npm run package                          # build localai-vscode-chat-<version>.vsix
gh release create v0.5.1 ./*.vsix --generate-notes
```

## Notes

- The workflow fails the build if a `.env` ever ends up inside the `.vsix`, so a
  personal key can't leak into a Release.
- `.gitignore` keeps `.env`, `*.vsix`, and the stray caveman files out of the repo.
- Team members do NOT get auto-updates from `.vsix` — see INSTALL.md. For true
  auto-update you'd need a private extension gallery (separate infrastructure).

## VS Code forks and Antigravity distribution

To support Antigravity IDE and other VS Code forks, prefer one of these flows:

1. Ship the `.vsix` release asset and install with "Install from VSIX" in the IDE UI.
2. Publish to OpenVSX for forks that use OpenVSX as their extension registry.

OpenVSX publish (maintainer):

```bash
npm run package
npx ovsx publish ./*.vsix -p <OPENVSX_TOKEN>
```

Notes:
- Keep `engines.vscode` conservative so forks on older bases can still install.
- If a fork blocks marketplace installs, VSIX/OpenVSX is the compatible path.

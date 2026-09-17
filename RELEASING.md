# Releasing

Both packages are public on npmjs.org under the **`@digicredholdingsinc`** scope:

| Package | Path |
|---|---|
| [`@digicredholdingsinc/did-graphql-client`](https://www.npmjs.com/package/@digicredholdingsinc/did-graphql-client) | [`client/`](client/) |
| [`@digicredholdingsinc/did-graphql-server`](https://www.npmjs.com/package/@digicredholdingsinc/did-graphql-server) | [`server/`](server/) |

Consumers need no registry auth — no `.npmrc`, no token, no `NPM_TOKEN` plumbed through a Dockerfile. That is the whole reason for being on npmjs.org rather than GitHub Packages, which has no anonymous-read path and so forces a credential on every consumer forever.

CI needs no registry credential either. Publishing authenticates by OIDC against a **trusted publisher**, so there is no npm token anywhere in this repo, in its secrets, or on anyone's laptop.

## Cutting a release

**1. Add a changeset** in the PR that needs one:

```bash
npm run changeset
```

Pick the affected packages and a bump level, and write what changed — the text becomes the `CHANGELOG.md` entry, so write it for someone deciding whether to upgrade. A PR needs a changeset only if it changes something a published package ships; docs, CI and test-only changes do not.

**2. Merge that PR.** Nothing publishes yet. `changeset version` has not run, so versions are untouched.

**3. Merge the Version Packages PR.** This is the commit that bumps `package.json` versions, writes the changelogs, and deletes the consumed changeset files. Merging it triggers the publish.

That second PR is not a ceremony you can skip. If its commit never lands on `main`, the manifests permanently disagree with what npm serves and the next `changeset version` computes its bump from a stale base.

> **Currently manual.** `changesets/action` normally opens the Version Packages PR itself. The `DigiCred-Holdings` org forbids Actions from creating pull requests, so that call fails with `GitHub Actions is not permitted to create or approve pull requests` — note the branch push *succeeds*, only the PR creation is refused. Until that is resolved, open the PR by hand from the pushed `changeset-release/main` branch:
>
> ```bash
> gh pr create --base main --head changeset-release/main --title "chore: Version Packages"
> ```
>
> The repo-level setting for this is greyed out because org policy locks it. Two ways out: flip it org-wide at `Settings → Actions → General → Workflow permissions` (one click, but it grants Actions the ability to approve PRs as well as create them, across every repo in the org), or give `changesets/action` a GitHub App installation token instead of `GITHUB_TOKEN` — app tokens aren't subject to the restriction, and an org-owned app scoped to this repo with `Contents` + `Pull requests` write is the narrower fix.

## How publishing authenticates

`release.yml` mints a short-lived OIDC token from its GitHub Actions identity. npm checks that against the trusted publisher configured **per package** on npmjs.com — organization, repository, and workflow filename. Provenance attestations are generated automatically on this path.

A successful run says so explicitly:

```
No NPM_TOKEN found, but OIDC is available - using npm trusted publishing
🦋  success packages published successfully
```

To confirm a published version really took that path rather than falling back to some credential, check the registry:

```bash
curl -s 'https://registry.npmjs.org/@digicredholdingsinc%2Fdid-graphql-server/0.5.2' \
  | python3 -c 'import sys,json; m=json.load(sys.stdin); print(m["_npmUser"]); print(m["dist"].get("attestations"))'
```

An OIDC publish shows `GitHub Actions <npm-oidc-no-reply@github.com>` with a `trustedPublisher` block, plus an SLSA v1 provenance attestation. A token publish shows a person.

### Five things that must stay true

Each of these breaks publishing, and several fail with errors that point somewhere other than the cause.

- **`permissions: id-token: write` on the job.** Without it there is no OIDC token, npm falls back to looking for a registry token, finds none, and fails `ENEEDAUTH`.
- **Node >= 22.14.0 and npm >= 11.5.1.** Node 24 has shipped npm 11.x builds *below* that floor, which is why the workflow runs `npm install -g npm@latest` rather than trusting the runner image.
- **The trusted publisher names `.github/workflows/release.yml`.** Renaming or moving this file breaks publishing until the config on npmjs.com is updated to match. There is no error that mentions the filename.
- **The trusted publisher must allow `npm publish`, not just `npm stage publish`.** npm's UI marks the direct-publish permission "not recommended" and suggests stage-only. That does not work here: `@changesets/cli` hardcodes the `publish` subcommand (see `spawn(publishTool.name, ["publish", ...])` in its dist), and the string `stage publish` appears nowhere in the package. Stage-only would fail every release. Adopting staged publishing is possible but means replacing `changeset publish` with something that calls `npm stage publish` per workspace, plus a human approving each release.
- **The repo must stay public.** `publishConfig.provenance: true` is set on both packages, and npm refuses provenance for a private source repo — it fails with `E422 Unsupported GitHub Actions source repository visibility: "private"`, which reads like an auth problem and isn't. Making the repo private would also gain less than it appears: both tarballs ship `src/` (it's in `files`) and are public on npmjs.org already. If the repo ever does go private, drop `provenance: true` from both manifests first. Trusted publishing itself works fine from a private repo; only the attestation needs public.

## Adding a new package to this repo

npm cannot create a package from OIDC. A trusted publisher can only be attached to a package that already exists, and there is [no pending-publisher mechanism](https://github.com/npm/cli/issues/8544) to pre-register one. So a new package name needs a **one-time manual first publish**, after which it never needs a credential again.

```bash
npm run build
cd <new-package> && npm publish --access public --no-provenance
```

`--no-provenance` is required for this command only: `publishConfig.provenance: true` forces `--provenance`, which cannot work outside a supported CI runner. Every later release generates provenance normally.

Then configure that package's trusted publisher on npmjs.com:

| Field | Value |
|---|---|
| Organization or user | `DigiCred-Holdings` |
| Repository | `did-graphql` |
| Workflow filename | `release.yml` |
| Environment | *leave empty* |
| Allowed actions | **tick `npm publish`** — see above |

### Authenticating that manual publish

npm has phased out *new* TOTP enrollments in favour of WebAuthn and passkeys, so on a recently-configured account there is no six-digit code and `--otp` is useless. A plain `npm publish` after `npm login` then fails with:

```
E403 ... Two-factor authentication or granular access token with bypass 2fa enabled is required to publish packages.
```

The message names only those two remedies, but a third works and is the one to use:

```bash
npm logout
npm login --auth-type=web
```

That runs the security-key challenge in the browser, and the resulting session **does** carry through to `npm publish` — each publish prints an `npmjs.com/auth/cli/<uuid>` URL to approve. npm's documentation describes this flow for `login` only and does not mention it working for `publish`, so it is easy to conclude it doesn't. No granular token is needed.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `ENEEDAUTH` in the Release run | `id-token: write` missing from the job's `permissions` |
| `E422 Unsupported GitHub Actions source repository visibility: "private"` | Provenance on a private repo — not an auth failure |
| `E403 ... Two-factor authentication or granular access token ... required` | Manual publish without a web-auth session. `npm login --auth-type=web` |
| `GitHub Actions is not permitted to create or approve pull requests` | Org policy. The branch pushed fine; open the PR by hand |
| `🦋 warn ... is not being published because version X is already published` | Expected on any push to `main` with no pending changesets. Not a failure |
| `version not found` right after a successful publish | Registry read replication lag, minutes not seconds. The write succeeded |
| Publish rejected although the trusted publisher exists | Allowed actions set to stage-only, or the workflow filename doesn't match |

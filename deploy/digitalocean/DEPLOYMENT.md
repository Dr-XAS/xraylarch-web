# Beta instance

> Pre-rollout record: the release revision and verification results below
> describe the instance that was live immediately before this master sync. The
> source branch has since been synchronized through `origin/master` at
> `8b770359cdf4c7b17a8126493d020b65ddb53a70`; deploy and verify the local
> commit before replacing the historical values in this file.

- Public URL: https://larch-web.dr-xas.org
- Provider: DigitalOcean, project `first-project`
- Droplet: `larch-web-beta` (ID `602034826`), NYC1
- IPv4: `161.35.110.95`
- Plan: 1 vCPU, 2 GB RAM, 50 GB disk, $12/month base price
- Operating system: Ubuntu 24.04 LTS x64; 2 GB swap
- Source directory: `/opt/xraylarch-current`
- Compose directory: `/opt/xraylarch-current/deploy/digitalocean`
- GoDaddy DNS: `A larch-web → 161.35.110.95`, TTL 600 seconds
- SSH key: local `~/.ssh/id_ed25519_larch_web_do` (private key stays on the owner's computer)

Connect:

```sh
ssh -i ~/.ssh/id_ed25519_larch_web_do -o IdentitiesOnly=yes root@161.35.110.95
cd /opt/xraylarch-current/deploy/digitalocean
docker compose ps
docker compose logs --tail=100 backend frontend caddy
```

Containers restart automatically after reboot. Caddy renews HTTPS certificates automatically. Application data and the anonymous session signing key live in the `xraylarch-beta_app_data` Docker volume. Keep this volume when updating. Backups are not enabled on the provider; the manual backup procedure is in [README.md](README.md).

Anonymous projects belong to the browser's signed cookie. Users should export important projects as `.prj` files; clearing cookies loses access to that browser's projects. This deployment does not add user accounts or cross-device recovery.

## Pre-rollout source and release

The live revision before this rollout was `83b23836ec9d2a1d2c1da5d30d5b46693f2912c1`. It contains the public-deployment overlay synchronized through `origin/master` at `2e662cfa81e57f77ed7476849eddbdeb64dc4523`, including the patched Next.js 16.3.5 runtime and the strict Artemis proxy allowlist. The release preserves master's Athena, Artemis, structure database, and integration code. The deployment overlay adds signed anonymous browser isolation (including Artemis), persistent per-browser preferences, safe session forwarding/recovery, and standalone packaging. Public mode rejects enabling the separate integration API.

Pre-rollout release directory: `/opt/xraylarch-releases/83b23836ec9d2a1d2c1da5d30d5b46693f2912c1`. The backend and frontend images carry that full commit as their tag and revision label. The backend's internal `/health` reports the exact release revision; the public proxy deliberately exposes only health status.

For the next rollout, record the exact local `internal_testing` commit from `git rev-parse HEAD` in the release directory and image tags. Build the frontend with Node.js 24 and retain the 256-column backend default unless an explicit production limit is intended.

## Pre-rollout verification — 2026-09-22

- Both exact-commit images built successfully on the Linux server and carry the full release revision label.
- Public/config/integration backend tests passed, covering public isolation, Athena/classic API, preferences, Artemis, FEFF jobs, configuration, and integration behavior.
- All 1,301 frontend tests, TypeScript checking, the production frontend build, and production dependency audit passed.
- The focused Athena/public/integration backend suite passed 203 tests, and all 22 deployment automation tests passed.
- Active backend health reported `83b23836ec9d2a1d2c1da5d30d5b46693f2912c1`; all three containers were healthy.
- Public HTTPS smoke passed: signed cookies, private cache headers, cross-visitor read/write/export restrictions, four processed Cu/Cu₂O spectra, project export, an actual Artemis fit, AMCSD lookup/details/attachment, and denied foreign FEFF access.
- Chrome displays the master Larch-Web interface and Artemis fitting panel; the previous example project still opens after the switch.
- Pre-switch data backup: `/opt/xraylarch-backups/before-83b23836ec9d-20260922T163217Z-576690.tar.gz` (server-local, protected; provider automatic backups remain disabled).

The unmodified master AMCSD search with an element filter was slow on this instance (over 75 seconds for `copper` + `Cu`, stopped during an isolated check). Numeric-ID lookup and structure details worked. This baseline search behavior is outside the isolation patch.

Run the public smoke test from the repository root:

```sh
python3 deploy/digitalocean/smoke_test.py https://larch-web.dr-xas.org
```

This uses fresh test sessions and leaves a small example project in its own session. It never uses an existing user's session.

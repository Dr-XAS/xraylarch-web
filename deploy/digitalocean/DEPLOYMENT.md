# Beta instance

> Pre-rollout record: the release revision and verification results below
> describe the instance that was live immediately before this master sync. The
> source branch has since been synchronized through `origin/master` at
> `a95d1b3828dd2b8fadc59ab4bd1f90170643048d`; deploy and verify the rebased
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

The live revision before this rollout was `947825e9213078929d1d950e3976a93307fd94a7`. It contains the public-deployment overlay and release automation on top of `origin/master` at `f99be876d3b060e49bbc0b7861f1c7c7c4cd472b` (merge PR #2, plot color legend). The release preserves master's Athena, Artemis, structure database, and integration code. The deployment overlay adds signed anonymous browser isolation (including Artemis), persistent per-browser preferences, safe session forwarding/recovery, and standalone packaging. Public mode rejects enabling the separate integration API.

Pre-rollout release directory: `/opt/xraylarch-releases/947825e9213078929d1d950e3976a93307fd94a7`. The backend and frontend images carry that full commit as their tag and revision label. The backend's internal `/health` reports the exact release revision; the public proxy deliberately exposes only health status.

For the next rollout, record the exact post-rebase commit from `git rev-parse HEAD` in the release directory, image tags, and this file. Build the frontend with Node.js 24 and retain the 256-column backend default unless an explicit production limit is intended. Do not reuse the historical `f99be876` identifier for new images.

## Pre-rollout verification — 2026-09-19

- Both master images built successfully on the Linux server and carry the exact base revision label.
- 604 backend regression tests passed, covering public isolation, Athena/classic API, preferences, Artemis, FEFF jobs, configuration, and integration behavior.
- 84 targeted frontend tests and TypeScript checking passed; the production frontend build passed.
- The full backend suite stopped after three existing alignment numerical comparisons failed (maximum observed difference about 3.4e-10). The same three tests also fail on untouched master in the same local environment; the scientific algorithms were not changed by the deployment overlay.
- Active backend health reported `947825e9213078929d1d950e3976a93307fd94a7`; all three containers were healthy.
- Public HTTPS smoke passed: signed cookies, private cache headers, cross-visitor read/write/export restrictions, three processed Cu spectra, project export, an actual Artemis fit, AMCSD lookup/details/attachment, and denied foreign FEFF access.
- Chrome displays the master Larch-Web interface and Artemis fitting panel; the previous example project still opens after the switch.
- Pre-switch data backup: `/opt/xraylarch-backups/before-master-20260919T225823Z.tar.gz` (server-local, protected; provider automatic backups remain disabled).

The unmodified master AMCSD search with an element filter was slow on this instance (over 75 seconds for `copper` + `Cu`, stopped during an isolated check). Numeric-ID lookup and structure details worked. This baseline search behavior is outside the isolation patch.

Run the public smoke test from the repository root:

```sh
python3 deploy/digitalocean/smoke_test.py https://larch-web.dr-xas.org
```

This uses fresh test sessions and leaves a small example project in its own session. It never uses an existing user's session.

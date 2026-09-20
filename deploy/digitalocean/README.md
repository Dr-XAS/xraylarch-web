# DigitalOcean beta deployment

Run the Next.js frontend, one FastAPI/Larch worker, and Caddy on an **x86-64 Ubuntu Droplet**. Caddy obtains HTTPS certificates for your domain. Only HTTP/HTTPS ports are published; the application and backend communicate on Docker's private network. Anonymous public sessions are enabled and application data, session signing material, and certificates survive container replacement in named volumes.

## Prepare the Droplet

1. Start with 1 vCPU / 2 GB RAM for light beta use. Scientific calculations and production builds can exceed this; upgrade to 4 GB if memory is insufficient. No load test establishes capacity yet.
2. Install Docker Engine and the Compose plugin using the [official Ubuntu instructions](https://docs.docker.com/engine/install/ubuntu/), or use DigitalOcean's Docker image. Run the commands below as a Docker-authorized account.
3. Allow inbound TCP 80/443 and UDP 443; restrict SSH TCP 22 to your own IP. Do not publish ports 3000 or 8006.
4. Set an A record for your chosen hostname to the Droplet's IPv4 address. Add an AAAA record only if its IPv6 address is configured and reachable.
5. Copy this source checkout to the server, excluding `.git`, `.venv`, `node_modules`, `.next*`, `.env*`, and `backend/data`. Local experiment data is not required. Preserve the existing `examples/xafsdata` demo files and `larch/bin/linux64` executables.

On a new 2 GB Droplet without swap, add 2 GB swap before building (skip if already configured):

```sh
sudo fallocate -l 2G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
printf '/swapfile none swap sw 0 0\n' | sudo tee -a /etc/fstab
```

Swap helps builds complete but does not replace enough RAM for large analysis jobs. Build the two images sequentially to keep peak memory lower.

## Configure and launch

From this directory in the uploaded checkout:

```sh
cp env.example .env
chmod 600 .env
```

Edit `.env`: set `DOMAIN` to your hostname. For a production rollout, also set
`LARCH_RELEASE_TAG` and `XRAYLARCH_GIT_REVISION` to the exact 40-character
post-rebase commit. The installed remote release runner sets both values
automatically. Then:

```sh
docker compose config --quiet
docker compose build backend
docker compose build frontend
docker compose up -d --wait --wait-timeout 180
docker compose ps
```

Open `https://YOUR_HOSTNAME` and check `https://YOUR_HOSTNAME/api/backend/health`. Upload a small sample and verify the plot. Use another browser/private session to confirm it has an independent project list. Public sessions require HTTPS; deleting browser cookies removes access to that anonymous session's saved projects.

For diagnostics:

```sh
docker compose logs --tail=100 backend frontend caddy
docker stats --no-stream
```

The Python build uses the existing pinned release constraints in `deploy/python-release-constraints.txt`. The frontend uses `npm ci` with its committed lockfile and the same Node.js 24 major selected by `frontend/.nvmrc`. Docker installs no optional desktop GUI dependencies. Both app containers run as non-root users. Start with one backend worker on the small beta instance. Public-mode reader settings are persisted per browser, while trusted local mode retains its existing in-memory Apply behavior. Uploads accept up to 256 source columns by default; set `XRAYLARCH_MAX_COLUMNS` in `.env` only when the deployment needs a different explicit limit.

## Update and back up

Upload updated source while retaining this directory's `.env`, then repeat the two build commands and `docker compose up -d --wait --wait-timeout 180`. Building first leaves the current containers running until replacement. Do not run `docker compose down --volumes`; it deletes saved projects and certificates.

Make a consistent application backup before updates (brief downtime):

```sh
mkdir -p backups
docker compose stop frontend backend
docker compose run --rm --no-deps -T backend python -c 'import sys, tarfile; archive = tarfile.open(fileobj=sys.stdout.buffer, mode="w|gz"); archive.add("/data", arcname="data"); archive.close()' > "backups/app-data-$(date -u +%Y%m%dT%H%M%SZ).tar.gz"
docker compose start backend frontend
```

Copy the backup off the Droplet and protect it: it contains uploaded data and session signing material. DigitalOcean's optional server backups can provide a second copy. The app currently has no automatic expiration or storage quota; check disk use during beta and remove stale data through the app or an explicit maintenance procedure.

Deployment references: [Next.js standalone output](https://nextjs.org/docs/app/api-reference/config/next-config-js/output), [Compose health-based startup](https://docs.docker.com/compose/how-tos/startup-order/), [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https).

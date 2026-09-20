#!/usr/bin/env bash
# One-time setup for the new, dedicated Ubuntu beta Droplet.
set -euo pipefail

[[ "$(id -u)" == 0 ]] || { echo "Run as root on the dedicated Droplet." >&2; exit 1; }
[[ "$(hostname)" == larch-web-beta ]] || { echo "Unexpected host; refusing setup." >&2; exit 1; }
. /etc/os-release
[[ "$ID" == ubuntu ]] || { echo "Ubuntu is required." >&2; exit 1; }

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y ca-certificates curl ufw
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
systemctl enable --now docker

if [[ ! -e /swapfile ]] && ! swapon --show --noheadings | read -r _; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  printf '/swapfile none swap sw 0 0\n' >> /etc/fstab
fi

# Key authentication remains required for SSH. Only Caddy publishes app ports.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw allow 443/udp
ufw --force enable

install -d -m 0755 /opt/xraylarch-web
docker version --format '{{.Server.Version}}'
docker compose version
free -h
df -h /

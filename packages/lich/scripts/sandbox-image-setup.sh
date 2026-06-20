#!/usr/bin/env bash
# Runs INSIDE a Tart Ubuntu VM to install lich's runtime dependencies.
# Invoked by build-sandbox-image.sh after the lich binary is copied in.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y --no-install-recommends \
  ca-certificates curl gnupg lsb-release \
  postgresql-client \
  build-essential python3 git unzip \
  openssh-server

# sshd is the transport for MutagenSync (live source sync host->guest). The
# cirruslabs base image ships no sshd; enable it so a booted VM accepts SSH.
systemctl enable ssh

# Docker (official repo).
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(lsb_release -cs) stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
usermod -aG docker admin
systemctl enable docker

# Bun (used by some user stacks; lich itself is a self-contained binary).
curl -fsSL https://bun.sh/install | bash -s
mv /root/.bun /usr/local/bun
ln -s /usr/local/bun/bin/bun /usr/local/bin/bun

# pnpm.
curl -fsSL https://get.pnpm.io/install.sh | sh -
mv /root/.local/share/pnpm /usr/local/pnpm
ln -s /usr/local/pnpm/pnpm /usr/local/bin/pnpm

# Place pre-built lich binaries on PATH.
install -m 0755 /tmp/lich /usr/local/bin/lich
install -m 0755 /tmp/lich-daemon /usr/local/bin/lich-daemon

# Sync target for the user's repo (populated by SandboxSync at runtime).
mkdir -p /workspace
chown -R admin:admin /workspace

# Clean apt cache to shrink the image.
apt-get clean
rm -rf /var/lib/apt/lists/*

echo "sandbox image setup complete"

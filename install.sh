#!/usr/bin/env bash
# Lich installer. Downloads the latest release binary for the current
# platform from GitHub and installs it into ~/.local/bin (override with
# LICH_PREFIX). Usage:
#
#   curl -fsSL https://raw.githubusercontent.com/RPate97/lich/main/install.sh | bash
#
# Environment overrides:
#   LICH_VERSION  - specific tag to install (default: latest)
#   LICH_PREFIX   - install root (default: $HOME/.local)
#   LICH_REPO     - GitHub repo owner/name (default: RPate97/lich)
#
# The installer is intentionally curl|bash-friendly: it streams output
# as it works, exits non-zero on any failure (set -euo pipefail), and
# uses only POSIX-y tools (curl, tar, uname, mkdir, mv, chmod, mktemp).

set -euo pipefail

REPO="${LICH_REPO:-RPate97/lich}"
VERSION="${LICH_VERSION:-latest}"
PREFIX="${LICH_PREFIX:-$HOME/.local}"
# Base URL for release artifacts. Override for local testing against a
# mock release server (e.g. `LICH_BASE_URL=http://localhost:8000`); the
# expected layout under the base is `/<repo>/releases/...` matching
# GitHub's path scheme.
BASE_URL="${LICH_BASE_URL:-https://github.com}"

# ---- Platform detection ---------------------------------------------------

uname_s="$(uname -s)"
uname_m="$(uname -m)"

case "$uname_s" in
  Darwin) os=darwin ;;
  Linux)  os=linux ;;
  *)
    echo "Error: unsupported operating system '$uname_s'." >&2
    echo "Lich supports macOS and Linux. On Windows, install under WSL." >&2
    exit 1
    ;;
esac

# Apple Silicon Rosetta correction: when this shell happens to be an
# x86_64 binary running under Rosetta (e.g. an old homebrew bash early
# in PATH), `uname -m` reports `x86_64` even though the host CPU is
# arm64. Trust `sysctl sysctl.proc_translated == 1` as the signal and
# install the arm64 binary — running an x86_64 binary under Rosetta
# would work but burn cycles for no reason, and the user almost
# certainly wants native code.
if [ "$os" = "darwin" ] && [ "$uname_m" = "x86_64" ]; then
  if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ]; then
    uname_m="arm64"
  fi
fi

case "$uname_m" in
  arm64|aarch64) arch=arm64 ;;
  x86_64|amd64)  arch=x64 ;;
  *)
    echo "Error: unsupported architecture '$uname_m'." >&2
    echo "Lich supports arm64 and x86_64." >&2
    exit 1
    ;;
esac

target="$os-$arch"

# ---- Resolve version ------------------------------------------------------

if [ "$VERSION" = "latest" ]; then
  echo "Resolving latest release for $REPO..."
  # GitHub redirects /releases/latest to the actual tag; follow the
  # redirect (-L) and read the final URL. Avoids needing jq or
  # authenticated API calls.
  resolved_url=$(curl -fsSLI -o /dev/null -w '%{url_effective}' \
    "$BASE_URL/$REPO/releases/latest")
  VERSION="${resolved_url##*/}"
  if [ -z "$VERSION" ] || [ "$VERSION" = "latest" ]; then
    echo "Error: could not resolve latest release for $REPO." >&2
    echo "Pass LICH_VERSION=v0.x.y to install a specific version." >&2
    exit 1
  fi
fi

echo "Installing lich $VERSION ($target) → $PREFIX/bin"

# ---- Download + extract ---------------------------------------------------

asset="lich-$target.tar.gz"
asset_url="$BASE_URL/$REPO/releases/download/$VERSION/$asset"
sha_url="$asset_url.sha256"

tmpdir=$(mktemp -d -t lich-install.XXXXXX)
trap 'rm -rf "$tmpdir"' EXIT

echo "Downloading $asset..."
if ! curl -fsSL "$asset_url" -o "$tmpdir/$asset" 2>/dev/null; then
  # Race window: release-please publishes a release before release.yml's
  # binaries finish uploading (~5-10 min). When that window is open, the
  # tag exists but the platform tarball doesn't. Walk back through recent
  # releases until we find one with our asset, then install that.
  echo "Note: $asset is not (yet) attached to $VERSION — the release build may still be running." >&2
  echo "Searching recent releases for one with $asset attached..." >&2

  releases_json=$(curl -fsSL "https://api.github.com/repos/$REPO/releases?per_page=10" 2>/dev/null || true)
  if [ -z "$releases_json" ]; then
    echo "Error: could not list releases at https://api.github.com/repos/$REPO/releases" >&2
    echo "If a release was just published, try again in 5-10 minutes." >&2
    exit 1
  fi

  fallback=""
  for tag in $(echo "$releases_json" | grep -o '"tag_name": *"[^"]*"' | sed -E 's/.*"([^"]+)"$/\1/'); do
    [ "$tag" = "$VERSION" ] && continue
    probe_url="$BASE_URL/$REPO/releases/download/$tag/$asset"
    if curl -fsSL -I "$probe_url" -o /dev/null 2>/dev/null; then
      fallback="$tag"
      break
    fi
  done

  if [ -z "$fallback" ]; then
    echo "Error: no recent release has $asset attached." >&2
    echo "Check https://github.com/$REPO/releases or retry later." >&2
    exit 1
  fi

  echo "Installing $fallback instead (the most recent release whose binaries are uploaded)." >&2
  echo "Re-run this installer after $VERSION's build finishes to upgrade." >&2
  VERSION="$fallback"
  asset_url="$BASE_URL/$REPO/releases/download/$VERSION/$asset"
  sha_url="$asset_url.sha256"
  if ! curl -fsSL "$asset_url" -o "$tmpdir/$asset"; then
    echo "Error: download failed for $asset_url" >&2
    exit 1
  fi
fi

# SHA verification is best-effort: skip silently if the .sha256 file
# isn't published. When present, a mismatch fails the install loudly.
if curl -fsSL "$sha_url" -o "$tmpdir/$asset.sha256" 2>/dev/null; then
  echo "Verifying SHA256..."
  cd "$tmpdir"
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 -c "$asset.sha256" >/dev/null
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum -c "$asset.sha256" >/dev/null
  else
    echo "Warning: neither shasum nor sha256sum available; skipping checksum." >&2
  fi
  cd - >/dev/null
fi

echo "Extracting..."
tar -xzf "$tmpdir/$asset" -C "$tmpdir"

# ---- Install --------------------------------------------------------------

bin_dir="$PREFIX/bin"
mkdir -p "$bin_dir"

# Move both binaries together; chmod after to handle umasks that strip x.
mv "$tmpdir/lich" "$tmpdir/lich-daemon" "$bin_dir/"
chmod +x "$bin_dir/lich" "$bin_dir/lich-daemon"

echo ""
echo "✓ Installed lich $VERSION to $bin_dir"
echo ""

# ---- Telemetry ping (opt-out: LICH_INSTALL_NO_TELEMETRY=1) ----------------
# Anonymous: just version + platform + success flag. Fails silently.
if [ -z "${LICH_INSTALL_NO_TELEMETRY:-}" ]; then
  curl -fsS -m 3 -X POST \
    -H 'Content-Type: application/json' \
    "https://us.i.posthog.com/capture/" \
    -d "{\"api_key\":\"phc_sGvHNd7WNParEj4yL2unUFvUhuWSzvQneQgqR6K9P8Pe\",\"event\":\"install\",\"distinct_id\":\"anonymous-installer\",\"properties\":{\"version\":\"$VERSION\",\"platform\":\"$target\",\"prefix\":\"$([ "$PREFIX" = "$HOME/.local" ] && echo default || echo custom)\"}}" \
    > /dev/null 2>&1 || true
fi


# ---- PATH hint ------------------------------------------------------------

case ":$PATH:" in
  *":$bin_dir:"*)
    echo "Run: lich --help"
    ;;
  *)
    echo "Add $bin_dir to your PATH:"
    echo ""
    case "${SHELL:-}" in
      */zsh)  echo "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.zshrc && source ~/.zshrc" ;;
      */bash) echo "  echo 'export PATH=\"$bin_dir:\$PATH\"' >> ~/.bashrc && source ~/.bashrc" ;;
      */fish) echo "  fish_add_path $bin_dir" ;;
      *)      echo "  export PATH=\"$bin_dir:\$PATH\"" ;;
    esac
    echo ""
    echo "Then run: lich --help"
    ;;
esac

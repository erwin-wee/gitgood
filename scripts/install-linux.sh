#!/usr/bin/env bash
# Installs GitGood on Linux: detects the distro, installs git/gh/the AppImage
# runtime dependency via the right package manager, downloads the latest (or
# a chosen) release's AppImage from GitHub, and installs it with a `gitgood`
# command and a desktop menu entry.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/erwin-wee/gitgood/main/scripts/install-linux.sh | bash
#   ./install-linux.sh [--version vX.Y.Z] [--prefix DIR] [--no-prereqs] [-y|--yes] [-h|--help]

set -euo pipefail

REPO="erwin-wee/gitgood"
PREFIX="${GITGOOD_INSTALL_PREFIX:-$HOME/.local/share/GitGood}"
BIN_DIR="$HOME/.local/bin"
DESKTOP_DIR="$HOME/.local/share/applications"
GITGOOD_VERSION=""
INSTALL_PREREQS=1
ASSUME_YES=0
# Piped via `curl ... | bash`: stdin is the script itself, so there is no
# terminal to prompt on. Default to non-interactive in that case.
if [ ! -t 0 ]; then ASSUME_YES=1; fi

log() { printf '==> %s\n' "$*"; }
warn() { printf 'warning: %s\n' "$*" >&2; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }

usage() {
  cat <<'EOF'
Usage: install-linux.sh [options]

  --version vX.Y.Z   Install a specific tagged release instead of the latest
  --prefix DIR        Install under DIR instead of ~/.local/share/GitGood
  --no-prereqs         Skip installing git/gh/the AppImage runtime dependency
  -y, --yes            Don't prompt before installing packages with sudo
  -h, --help           Show this help
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) GITGOOD_VERSION="$2"; shift 2 ;;
    --prefix) PREFIX="$2"; shift 2 ;;
    --no-prereqs) INSTALL_PREREQS=0; shift ;;
    -y|--yes) ASSUME_YES=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown option: $1 (see --help)" ;;
  esac
done

[ "$(uname -s)" = "Linux" ] || die "this script only supports Linux"

DOWNLOADER=""
if command -v curl >/dev/null 2>&1; then DOWNLOADER="curl"
elif command -v wget >/dev/null 2>&1; then DOWNLOADER="wget"
else die "need curl or wget to download the release"
fi

fetch() { # fetch URL -> stdout
  if [ "$DOWNLOADER" = "curl" ]; then curl -fsSL -H "Accept: application/vnd.github+json" "$1"
  else wget -qO- --header="Accept: application/vnd.github+json" "$1"
  fi
}

fetch_to_file() { # fetch_to_file URL PATH
  if [ "$DOWNLOADER" = "curl" ]; then curl -fsSL -o "$2" "$1"
  else wget -qO "$2" "$1"
  fi
}

confirm() { # confirm "prompt" -> 0 (yes) or 1 (no)
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '%s [Y/n] ' "$1"
  read -r reply || true
  case "$reply" in [Nn]*) return 1 ;; *) return 0 ;; esac
}

# ---------------------------------------------------------------------------
# Distro detection
# ---------------------------------------------------------------------------

[ -r /etc/os-release ] || die "cannot detect distro: /etc/os-release not found"
# shellcheck disable=SC1091
. /etc/os-release
DISTRO_ID="${ID:-unknown}"
DISTRO_LIKE="${ID_LIKE:-}"

PKG_MANAGER=""
case " $DISTRO_ID $DISTRO_LIKE " in
  *" debian "*|*" ubuntu "*) PKG_MANAGER="apt" ;;
  *" fedora "*|*" rhel "*) PKG_MANAGER="dnf" ;;
  *" arch "*) PKG_MANAGER="pacman" ;;
  *" suse "*|*" opensuse "*) PKG_MANAGER="zypper" ;;
  *" alpine "*) PKG_MANAGER="apk" ;;
esac

if [ -z "$PKG_MANAGER" ]; then
  for candidate in apt dnf pacman zypper apk; do
    command -v "$candidate" >/dev/null 2>&1 && PKG_MANAGER="$candidate" && break
  done
fi

log "Detected distro: ${PRETTY_NAME:-$DISTRO_ID} (package manager: ${PKG_MANAGER:-unknown})"

SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  command -v sudo >/dev/null 2>&1 || die "package installation needs root; install sudo or run this script as root"
  SUDO="sudo"
fi

# ---------------------------------------------------------------------------
# Prerequisites (git, gh, the AppImage FUSE runtime)
# ---------------------------------------------------------------------------

install_prereqs_apt() {
  $SUDO apt-get update
  $SUDO apt-get install -y git curl
  if ! command -v gh >/dev/null 2>&1; then
    $SUDO install -d -m 0755 /etc/apt/keyrings
    fetch https://cli.github.com/packages/githubcli-archive-keyring.gpg | $SUDO tee /etc/apt/keyrings/githubcli-archive-keyring.gpg >/dev/null
    $SUDO chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg
    echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | $SUDO tee /etc/apt/sources.list.d/github-cli.list >/dev/null
    $SUDO apt-get update
    $SUDO apt-get install -y gh
  fi
  # AppImages need libfuse.so.2; the package providing it was renamed on newer Debian/Ubuntu.
  $SUDO apt-get install -y libfuse2t64 || $SUDO apt-get install -y libfuse2 || warn "could not install a libfuse2 package; the AppImage may fail to run (see https://github.com/AppImage/AppImageKit/wiki/FUSE)"
}

install_prereqs_dnf() {
  $SUDO dnf install -y git
  if ! command -v gh >/dev/null 2>&1; then
    $SUDO dnf install -y 'dnf-command(config-manager)'
    $SUDO dnf config-manager --add-repo https://cli.github.com/packages/rpm/gh-cli.repo
    $SUDO dnf install -y gh --repo gh-cli
  fi
  $SUDO dnf install -y fuse fuse-libs || warn "could not install fuse/fuse-libs; the AppImage may fail to run"
}

install_prereqs_pacman() {
  $SUDO pacman -Sy --needed --noconfirm git github-cli fuse2 || warn "pacman install failed for one or more packages; check the output above"
}

install_prereqs_zypper() {
  $SUDO zypper --non-interactive install git libfuse2 || warn "could not install git/libfuse2 via zypper"
  if ! command -v gh >/dev/null 2>&1; then
    $SUDO zypper --non-interactive addrepo https://cli.github.com/packages/rpm/gh-cli.repo gh-cli || true
    $SUDO zypper --gpg-auto-import-keys refresh gh-cli || true
    $SUDO zypper --non-interactive install gh || warn "could not install gh via zypper; see https://cli.github.com"
  fi
}

install_prereqs_apk() {
  warn "Alpine (musl libc) is not a supported target for the AppImage build; git/gh will be installed, but GitGood itself may not run."
  $SUDO apk add --no-cache git github-cli || warn "could not install git/github-cli via apk"
}

if [ "$INSTALL_PREREQS" -eq 1 ]; then
  if confirm "Install/update git, gh and the AppImage runtime dependency via $PKG_MANAGER?"; then
    case "$PKG_MANAGER" in
      apt) install_prereqs_apt ;;
      dnf) install_prereqs_dnf ;;
      pacman) install_prereqs_pacman ;;
      zypper) install_prereqs_zypper ;;
      apk) install_prereqs_apk ;;
      *) warn "unrecognized package manager; install git, gh (https://cli.github.com) and libfuse2 (or fuse2) yourself" ;;
    esac
  else
    log "Skipping prerequisite installation."
  fi
else
  log "Skipping prerequisite installation (--no-prereqs)."
fi

# ---------------------------------------------------------------------------
# Download the release
# ---------------------------------------------------------------------------

if [ -n "$GITGOOD_VERSION" ]; then
  TAG="${GITGOOD_VERSION#v}"; TAG="v$TAG"
  API_URL="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  API_URL="https://api.github.com/repos/$REPO/releases/latest"
fi

log "Looking up release metadata ($API_URL)…"
RELEASE_JSON="$(fetch "$API_URL")" || die "could not reach the GitHub API"

TAG_NAME="$(printf '%s' "$RELEASE_JSON" | grep -m1 '"tag_name"' | sed -E 's/.*"tag_name":[[:space:]]*"([^"]+)".*/\1/')"
[ -n "$TAG_NAME" ] || die "no release found (check --version, or that a release has been published)"

APPIMAGE_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url":[[:space:]]*"[^"]*\.AppImage"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')"
[ -n "$APPIMAGE_URL" ] || die "release $TAG_NAME has no .AppImage asset"
APPIMAGE_NAME="$(basename "$APPIMAGE_URL")"

YML_URL="$(printf '%s' "$RELEASE_JSON" | grep -o '"browser_download_url":[[:space:]]*"[^"]*latest-linux\.yml"' | head -1 | sed -E 's/.*"(https[^"]+)"/\1/')"

log "Downloading $APPIMAGE_NAME ($TAG_NAME)…"
WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT
fetch_to_file "$APPIMAGE_URL" "$WORKDIR/$APPIMAGE_NAME"

# Best-effort integrity check against electron-builder's own manifest; a
# missing yml, an unparseable one, or no openssl just skips verification
# rather than failing the install outright.
if [ -n "$YML_URL" ] && command -v openssl >/dev/null 2>&1; then
  if fetch_to_file "$YML_URL" "$WORKDIR/latest-linux.yml" 2>/dev/null; then
    EXPECTED_SHA512="$(grep -E '^sha512:' "$WORKDIR/latest-linux.yml" | tail -1 | sed -E "s/^sha512:[[:space:]]*['\"]?([^'\"]+)['\"]?\$/\1/")"
    if [ -n "$EXPECTED_SHA512" ]; then
      ACTUAL_SHA512="$(openssl dgst -sha512 -binary "$WORKDIR/$APPIMAGE_NAME" | openssl base64 -A)"
      if [ "$EXPECTED_SHA512" = "$ACTUAL_SHA512" ]; then
        log "Checksum verified against $TAG_NAME's latest-linux.yml."
      else
        die "checksum mismatch for $APPIMAGE_NAME — refusing to install a corrupted or tampered download"
      fi
    else
      warn "could not parse a sha512 from latest-linux.yml; skipping checksum verification"
    fi
  else
    warn "could not download latest-linux.yml; skipping checksum verification"
  fi
else
  warn "openssl not found or no manifest available; skipping checksum verification"
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------

mkdir -p "$PREFIX" "$BIN_DIR" "$DESKTOP_DIR"
INSTALLED_PATH="$PREFIX/GitGood.AppImage"
mv "$WORKDIR/$APPIMAGE_NAME" "$INSTALLED_PATH"
chmod +x "$INSTALLED_PATH"

ln -sf "$INSTALLED_PATH" "$BIN_DIR/gitgood"

cat > "$DESKTOP_DIR/gitgood.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=GitGood
Comment=A GitHub Desktop-style Git client
Exec=$INSTALLED_PATH %U
Terminal=false
Categories=Development;
StartupWMClass=GitGood
EOF
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database "$DESKTOP_DIR" >/dev/null 2>&1 || true

log "Installed GitGood $TAG_NAME to $INSTALLED_PATH"

case ":$PATH:" in
  *":$BIN_DIR:"*) log "Run it with: gitgood" ;;
  *) warn "$BIN_DIR is not on your PATH — add it (e.g. in ~/.bashrc: export PATH=\"\$HOME/.local/bin:\$PATH\") or run $INSTALLED_PATH directly" ;;
esac

log "A menu entry was added too; you may need to log out and back in (or restart your desktop shell) for it to appear."

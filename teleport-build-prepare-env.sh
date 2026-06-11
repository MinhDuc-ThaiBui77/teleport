#!/usr/bin/env bash
#
# teleport-build-prepare-env.sh
# -------------------------------------------------------------------
# Prepare an Ubuntu/Debian VM for building Teleport OSS from source.
#
# This script intentionally does not use "set -e": each installation or
# validation item is reported independently, so one failure does not stop the
# remaining checks. It writes a detailed log beside the current working dir.
#
# Usage:
#   bash teleport-build-prepare-env.sh [TELEPORT_SRC_DIR]
#
# Log:
#   ./teleport-build-prepare-env.log
# -------------------------------------------------------------------

set -uo pipefail

SRC="${1:-$PWD}"
LOG="${LOG:-$PWD/teleport-build-prepare-env.log}"

PASS=0
WARN=0
FAIL=0
SKIP=0
REQUIRED_FAIL=0

FAILED_REQUIRED=()
FAILED_OPTIONAL=()
SUDO=()

GO_REQ="1.26.4"
NODE_REQ="24.16.0"
PNPM_REQ="11.3.0"
GO_ARCH=""
NODE_ARCH=""

if ! : > "$LOG" 2>/dev/null; then
  echo "Cannot write log file: $LOG" >&2
  exit 1
fi

say()  { printf '%s\n' "$*" | tee -a "$LOG"; }
info() { say "         $*"; }
hdr()  { say ""; say "=================================================================="; say "$*"; say "=================================================================="; }

pass() {
  PASS=$((PASS + 1))
  say "  [PASS] $*"
}

warn() {
  WARN=$((WARN + 1))
  say "  [WARN] $*"
}

skip() {
  SKIP=$((SKIP + 1))
  say "  [SKIP] $*"
}

fail() {
  local scope="$1"
  shift
  local msg="$*"

  FAIL=$((FAIL + 1))
  say "  [FAIL] $msg"
  if [ "$scope" = "required" ]; then
    REQUIRED_FAIL=$((REQUIRED_FAIL + 1))
    FAILED_REQUIRED+=("$msg")
  else
    FAILED_OPTIONAL+=("$msg")
  fi
}

run_step() {
  local scope="$1"
  local name="$2"
  shift 2

  hdr "$name"
  info "Running: $*"

  "$@" >>"$LOG" 2>&1
  local rc=$?
  if [ "$rc" -eq 0 ]; then
    pass "$name"
  else
    fail "$scope" "$name (exit $rc)"
    info "See log details above in: $LOG"
  fi
}

ver_ge() {
  # ver_ge A B returns true if A >= B.
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V 2>/dev/null | head -n1)" = "$2" ]
}

extract_ver() {
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1
}

major_ver() {
  printf '%s' "$1" | cut -d. -f1
}

load_required_versions() {
  if [ -f "$SRC/build.assets/versions.mk" ]; then
    local go_line node_line
    go_line="$(grep -E '^GOLANG_VERSION[[:space:]]*\?=' "$SRC/build.assets/versions.mk" | head -n1 || true)"
    node_line="$(grep -E '^NODE_VERSION[[:space:]]*\?=' "$SRC/build.assets/versions.mk" | head -n1 || true)"

    if [ -n "$go_line" ]; then
      GO_REQ="$(printf '%s' "$go_line" | sed -E 's/.*go([0-9.]+).*/\1/')"
    fi
    if [ -n "$node_line" ]; then
      NODE_REQ="$(printf '%s' "$node_line" | sed -E 's/[^0-9]*([0-9.]+).*/\1/')"
    fi
  else
    warn "versions.mk not found under $SRC; using defaults"
  fi

  if [ -f "$SRC/package.json" ]; then
    local pnpm_line pnpm_ver
    pnpm_line="$(grep -oE '"packageManager"[[:space:]]*:[[:space:]]*"pnpm@[0-9]+\.[0-9]+\.[0-9]+' "$SRC/package.json" | head -n1 || true)"
    pnpm_ver="$(printf '%s' "$pnpm_line" | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -n1 || true)"
    if [ -n "$pnpm_ver" ]; then
      PNPM_REQ="$pnpm_ver"
    fi
  else
    warn "package.json not found under $SRC; using pnpm default"
  fi
}

detect_arch() {
  case "$(uname -m)" in
    x86_64|amd64)
      GO_ARCH="amd64"
      NODE_ARCH="x64"
      ;;
    aarch64|arm64)
      GO_ARCH="arm64"
      NODE_ARCH="arm64"
      ;;
    *)
      echo "Unsupported architecture: $(uname -m)"
      return 1
      ;;
  esac
}

setup_sudo() {
  if [ "$(id -u)" -eq 0 ]; then
    SUDO=()
    return 0
  fi

  if command -v sudo >/dev/null 2>&1; then
    SUDO=(sudo)
    return 0
  fi

  echo "This script needs root privileges for package/toolchain installs, but sudo is missing."
  return 1
}

as_root() {
  "${SUDO[@]}" "$@"
}

require_apt() {
  if ! command -v apt-get >/dev/null 2>&1; then
    echo "apt-get not found. This script supports Ubuntu/Debian build VMs."
    return 1
  fi
}

apt_update() {
  as_root env DEBIAN_FRONTEND=noninteractive apt-get update
}

apt_install_one() {
  local pkg="$1"
  as_root env DEBIAN_FRONTEND=noninteractive apt-get install -y "$pkg"
}

validate_command() {
  local bin="$1"
  command -v "$bin" >/dev/null 2>&1
}

validate_go() {
  command -v go >/dev/null 2>&1 || return 1
  local raw version
  raw="$(go version 2>/dev/null)"
  version="$(extract_ver "$raw")"
  echo "$raw"
  [ -n "$version" ] && ver_ge "$version" "$GO_REQ"
}

validate_node() {
  command -v node >/dev/null 2>&1 || return 1
  local version
  version="$(node --version 2>/dev/null | tr -d 'v')"
  echo "node v$version"
  [ "$(major_ver "$version")" = "24" ] && ver_ge "$version" "$NODE_REQ"
}

validate_pnpm() {
  command -v pnpm >/dev/null 2>&1 || return 1
  local version
  version="$(pnpm --version 2>/dev/null)"
  echo "pnpm $version"
  ver_ge "$version" "$PNPM_REQ"
}

install_go() {
  if validate_go; then
    echo "Existing Go satisfies requirement."
    return 0
  fi

  detect_arch || return 1

  local tag tarball url
  tag="go${GO_REQ}"
  tarball="/tmp/${tag}.linux-${GO_ARCH}.tar.gz"
  url="https://go.dev/dl/${tag}.linux-${GO_ARCH}.tar.gz"

  curl -fL --retry 3 --connect-timeout 20 -o "$tarball" "$url" || return 1
  as_root rm -rf /usr/local/go || return 1
  as_root tar -C /usr/local -xzf "$tarball" || return 1
  as_root ln -sf /usr/local/go/bin/go /usr/local/bin/go || return 1
  as_root ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt || return 1

  hash -r 2>/dev/null || true
  validate_go
}

install_node() {
  if validate_node; then
    echo "Existing Node.js satisfies requirement."
    return 0
  fi

  detect_arch || return 1

  local tarball url node_dir
  tarball="/tmp/node-v${NODE_REQ}-linux-${NODE_ARCH}.tar.xz"
  url="https://nodejs.org/dist/v${NODE_REQ}/node-v${NODE_REQ}-linux-${NODE_ARCH}.tar.xz"
  node_dir="/opt/node-v${NODE_REQ}-linux-${NODE_ARCH}"

  curl -fL --retry 3 --connect-timeout 20 -o "$tarball" "$url" || return 1
  as_root rm -rf "$node_dir" || return 1
  as_root tar -C /opt -xf "$tarball" || return 1

  as_root ln -sf "$node_dir/bin/node" /usr/local/bin/node || return 1
  as_root ln -sf "$node_dir/bin/npm" /usr/local/bin/npm || return 1
  as_root ln -sf "$node_dir/bin/npx" /usr/local/bin/npx || return 1
  as_root ln -sf "$node_dir/bin/corepack" /usr/local/bin/corepack || return 1

  hash -r 2>/dev/null || true
  validate_node
}

install_pnpm() {
  if validate_pnpm; then
    echo "Existing pnpm satisfies requirement."
    return 0
  fi

  command -v corepack >/dev/null 2>&1 || return 1

  local node_dir corepack_bin
  node_dir="/opt/node-v${NODE_REQ}-linux-${NODE_ARCH}"
  corepack_bin="$(command -v corepack)"
  if [ -x "$node_dir/bin/corepack" ]; then
    corepack_bin="$node_dir/bin/corepack"
  fi

  as_root env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$corepack_bin" enable || return 1

  if ! as_root env COREPACK_ENABLE_DOWNLOAD_PROMPT=0 "$corepack_bin" prepare "pnpm@${PNPM_REQ}" --activate; then
    echo "corepack prepare failed; trying npm install -g pnpm@${PNPM_REQ}"
    command -v npm >/dev/null 2>&1 || return 1
    as_root npm install -g "pnpm@${PNPM_REQ}" || return 1
  fi

  if [ -x "$node_dir/bin/pnpm" ]; then
    as_root ln -sf "$node_dir/bin/pnpm" /usr/local/bin/pnpm || return 1
  fi

  hash -r 2>/dev/null || true
  validate_pnpm
}

main() {
  load_required_versions

  hdr "Teleport build environment preparation  ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))"
  say "Log file : $LOG"
  say "Source   : $SRC"
  say "Required : Go $GO_REQ, Node $NODE_REQ, pnpm $PNPM_REQ"

  run_step required "Detect supported architecture" detect_arch
  run_step required "Detect sudo/root access" setup_sudo
  run_step required "Detect apt package manager" require_apt
  run_step required "apt-get update" apt_update

  # Required build packages. They are installed one-by-one so one package
  # failure does not hide the status of the rest.
  local required_packages=(
    build-essential
    git
    make
    gcc
    g++
    pkg-config
    curl
    ca-certificates
    xz-utils
    tar
    python3
  )

  local pkg
  for pkg in "${required_packages[@]}"; do
    run_step required "apt install $pkg" apt_install_one "$pkg"
  done

  # Optional packages that make default builds smoother. Missing these should
  # not block a minimal access-request GUI build; PIV can be disabled with PIV=no.
  local optional_packages=(
    libpcsclite-dev
    libpam0g-dev
  )

  for pkg in "${optional_packages[@]}"; do
    run_step optional "apt install optional $pkg" apt_install_one "$pkg"
  done

  run_step required "Install/validate Go $GO_REQ" install_go
  run_step required "Install/validate Node.js $NODE_REQ" install_node
  run_step required "Install/validate pnpm $PNPM_REQ" install_pnpm

  run_step required "Validate git" validate_command git
  run_step required "Validate make" validate_command make
  run_step required "Validate gcc" validate_command gcc
  run_step required "Validate g++" validate_command g++
  run_step required "Validate pkg-config" validate_command pkg-config
  run_step required "Validate curl" validate_command curl
  run_step required "Validate Go version" validate_go
  run_step required "Validate Node.js version" validate_node
  run_step required "Validate pnpm version" validate_pnpm

  hdr "SUMMARY"
  say "PASS: $PASS    WARN: $WARN    FAIL: $FAIL    SKIP: $SKIP"
  say "Required failures: $REQUIRED_FAIL"

  if [ "${#FAILED_REQUIRED[@]}" -gt 0 ]; then
    say ""
    say "Required items that failed:"
    local item
    for item in "${FAILED_REQUIRED[@]}"; do
      say "  - $item"
    done
  fi

  if [ "${#FAILED_OPTIONAL[@]}" -gt 0 ]; then
    say ""
    say "Optional items that failed:"
    local item
    for item in "${FAILED_OPTIONAL[@]}"; do
      say "  - $item"
    done
  fi

  say ""
  if [ "$REQUIRED_FAIL" -eq 0 ]; then
    say ">> Required environment preparation completed. Run the precheck again:"
    say "   bash \"$SRC/teleport-build-precheck.sh\" \"$SRC\""
  else
    say ">> Some required items failed. Inspect the failing sections in:"
    say "   $LOG"
  fi

  # Return success only when all required items succeeded. Optional failures do
  # not affect the exit code.
  [ "$REQUIRED_FAIL" -eq 0 ]
}

main "$@"

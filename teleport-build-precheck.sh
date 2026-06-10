#!/usr/bin/env bash
#
# teleport-build-precheck.sh
# -------------------------------------------------------------------
# READ-ONLY precheck for building Teleport OSS (v19/master) from source
# on an Ubuntu 22.04 build VM.
#
# It installs NOTHING and changes NOTHING. It only inspects the machine,
# reports PASS / WARN / FAIL for each build prerequisite, and writes a
# full log you can send back for evaluation.
#
# Usage:
#   bash teleport-build-precheck.sh [TELEPORT_SRC_DIR]
#
#   TELEPORT_SRC_DIR (optional): path to the teleport source checkout.
#     If it contains build.assets/versions.mk and go.mod, the script will
#     read the EXACT required Go/Node versions from there. Defaults to the
#     current directory, then ~/teleport.
#
# Output log: ./teleport-build-precheck.log
# -------------------------------------------------------------------

# NOTE: intentionally NOT using `set -e` — we must run every check even if
# some fail. We do guard against unset vars.
set -uo pipefail

LOG="$PWD/teleport-build-precheck.log"

# ---- required versions (defaults; overridden from versions.mk if found) ----
GO_REQ="1.26.4"
NODE_REQ="24.16.0"
PNPM_REQ="11.3.0"

PASS=0
WARN=0
FAIL=0

# ---- logging helpers (tee everything to the log file) ----
: > "$LOG"   # truncate/create log
say()  { printf '%s\n' "$*" | tee -a "$LOG" ; }
hdr()  { say "" ; say "==================================================================" ; say "$*" ; say "==================================================================" ; }
ok()   { PASS=$((PASS+1)); say "  [PASS] $*" ; }
warn() { WARN=$((WARN+1)); say "  [WARN] $*" ; }
bad()  { FAIL=$((FAIL+1)); say "  [FAIL] $*" ; }
info() { say "         $*" ; }

# ver_ge A B  -> true if A >= B (semantic-ish, via sort -V)
ver_ge() {
  [ "$(printf '%s\n%s\n' "$2" "$1" | sort -V 2>/dev/null | head -n1)" = "$2" ]
}

# extract a dotted version (e.g. 1.26.4) from arbitrary text
extract_ver() {
  printf '%s' "$1" | grep -oE '[0-9]+\.[0-9]+(\.[0-9]+)?' | head -n1
}

# ---- locate teleport source ----
SRC="${1:-}"
if [ -z "${SRC}" ]; then
  if [ -f "$PWD/go.mod" ] && grep -q 'module github.com/gravitational/teleport' "$PWD/go.mod" 2>/dev/null; then
    SRC="$PWD"
  elif [ -f "$HOME/teleport/go.mod" ]; then
    SRC="$HOME/teleport"
  fi
fi

hdr "Teleport OSS build precheck  ($(date -u '+%Y-%m-%d %H:%M:%S UTC'))"
say "Log file : $LOG"
say "Source   : ${SRC:-<not found - pass it as arg 1>}"

# ---- read required versions from the source, if available ----
if [ -n "${SRC}" ] && [ -f "${SRC}/build.assets/versions.mk" ]; then
  _go="$(grep -E '^GOLANG_VERSION' "${SRC}/build.assets/versions.mk" | head -n1 | sed -E 's/.*go([0-9.]+).*/\1/')"
  _node="$(grep -E '^NODE_VERSION'  "${SRC}/build.assets/versions.mk" | head -n1 | sed -E 's/[^0-9]*([0-9.]+).*/\1/')"
  [ -n "${_go}" ]   && GO_REQ="${_go}"
  [ -n "${_node}" ] && NODE_REQ="${_node}"
  say "Required versions read from versions.mk -> Go ${GO_REQ}, Node ${NODE_REQ}"
else
  say "Required versions (defaults)           -> Go ${GO_REQ}, Node ${NODE_REQ}"
fi

# =====================================================================
hdr "1. System info"
say "uname    : $(uname -a 2>/dev/null)"
if command -v lsb_release >/dev/null 2>&1; then
  say "distro   : $(lsb_release -ds 2>/dev/null)"
else
  say "distro   : $(. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}")"
fi
say "arch     : $(uname -m)"
CORES="$(nproc 2>/dev/null || echo '?')"
say "cpu cores: ${CORES}"
MEM_KB="$(awk '/MemTotal/{print $2}' /proc/meminfo 2>/dev/null || echo 0)"
MEM_GB=$(( MEM_KB / 1024 / 1024 ))
say "memory   : ${MEM_GB} GB total"
say "free mem : $(free -h 2>/dev/null | awk '/Mem:/{print $7" available"}')"
say ""
say "disk (source fs / and /home):"
df -h "${SRC:-$PWD}" / "$HOME" 2>/dev/null | tee -a "$LOG" >/dev/null
df -h "${SRC:-$PWD}" / "$HOME" 2>/dev/null | sed 's/^/         /' | tee -a "$LOG" >/dev/null

# resource sanity
if [ "${CORES}" != "?" ] && [ "${CORES}" -ge 2 ] 2>/dev/null; then ok "CPU cores: ${CORES} (>=2)"; else warn "Few CPU cores (${CORES}); build will be slow"; fi
if [ "${MEM_GB}" -ge 4 ] 2>/dev/null; then ok "RAM: ${MEM_GB} GB (>=4)"; else warn "RAM ${MEM_GB} GB is low; Go/Node build may swap. 8GB+ recommended"; fi
AVAIL_G="$(df -BG --output=avail "${SRC:-$PWD}" 2>/dev/null | tail -n1 | tr -dc '0-9')"
if [ -n "${AVAIL_G}" ] && [ "${AVAIL_G}" -ge 15 ] 2>/dev/null; then ok "Free disk on source fs: ${AVAIL_G} GB (>=15)"; else warn "Free disk ${AVAIL_G:-?} GB on source fs; build+modules+node_modules want ~15GB+"; fi

# =====================================================================
hdr "2. Network reachability (module/package downloads)"
net_check() {
  local name="$1" url="$2"
  if command -v curl >/dev/null 2>&1; then
    if curl -fsS --max-time 12 -o /dev/null "$url" 2>/dev/null; then ok "Reachable: ${name} (${url})"; else warn "Cannot reach ${name} (${url}) — check VM internet/proxy"; fi
  else
    warn "curl not installed; skipped network check for ${name}"
  fi
}
net_check "Go module proxy" "https://proxy.golang.org"
net_check "npm registry"    "https://registry.npmjs.org"
net_check "GitHub"          "https://github.com"

# =====================================================================
hdr "3. Core build tools (REQUIRED)"
req_tool() {
  local bin="$1" label="$2"
  if command -v "$bin" >/dev/null 2>&1; then ok "${label}: $(command -v "$bin")  [$("$bin" --version 2>/dev/null | head -n1)]"; else bad "${label} not found ('$bin') — required"; fi
}
req_tool git  "git"
req_tool make "make"
req_tool gcc  "gcc (C compiler for CGO)"
req_tool g++  "g++"
if command -v pkg-config >/dev/null 2>&1; then ok "pkg-config: $(pkg-config --version)"; else warn "pkg-config missing (needed if building with PIV/BPF)"; fi

# =====================================================================
hdr "4. Go toolchain (REQUIRED, need >= ${GO_REQ})"
if command -v go >/dev/null 2>&1; then
  GOV_RAW="$(go version 2>/dev/null)"
  GOV="$(extract_ver "$GOV_RAW")"
  info "go version: ${GOV_RAW}"
  if [ -n "$GOV" ] && ver_ge "$GOV" "$GO_REQ"; then ok "Go ${GOV} >= ${GO_REQ}"; else bad "Go ${GOV:-unknown} < required ${GO_REQ} — install Go ${GO_REQ}"; fi
  info "GOROOT  : $(go env GOROOT 2>/dev/null)"
  info "GOPATH  : $(go env GOPATH 2>/dev/null)"
  info "CGO_ENABLED (env): $(go env CGO_ENABLED 2>/dev/null)"
  info "GOTOOLCHAIN: $(go env GOTOOLCHAIN 2>/dev/null)  (if 'auto', Go may auto-download the version in go.mod)"
else
  bad "Go not found — required (>= ${GO_REQ})"
fi

# =====================================================================
hdr "5. Node.js + pnpm (REQUIRED for building the web UI)"
if command -v node >/dev/null 2>&1; then
  NODEV="$(node --version 2>/dev/null | tr -d 'v')"
  info "node version: v${NODEV}"
  if ver_ge "$NODEV" "$NODE_REQ"; then ok "Node ${NODEV} >= ${NODE_REQ}"; else warn "Node ${NODEV} != target ${NODE_REQ}; major 24 required (engines: ^24)"; fi
else
  bad "Node.js not found — required (target ${NODE_REQ}); install via nvm/fnm"
fi
if command -v pnpm >/dev/null 2>&1; then
  PNPMV="$(pnpm --version 2>/dev/null)"
  if ver_ge "$PNPMV" "$PNPM_REQ"; then ok "pnpm ${PNPMV} >= ${PNPM_REQ}"; else warn "pnpm ${PNPMV} < ${PNPM_REQ}; repo pins pnpm@${PNPM_REQ}+"; fi
else
  warn "pnpm not found — needed for web UI. Can enable via 'corepack enable' (corepack present: $(command -v corepack >/dev/null 2>&1 && echo yes || echo no))"
fi

# =====================================================================
hdr "6. OPTIONAL components (missing = FINE for a minimal build)"
say "These power features you likely DON'T need for the access-request GUI."
say "A minimal build can disable them (e.g. PIV=no, no bpf/rdpclient tags)."
say ""

# Rust (rdpclient / Windows desktop access)
if command -v cargo >/dev/null 2>&1; then info "[opt] cargo: $(cargo --version 2>/dev/null)"; else info "[opt] cargo/Rust: not installed (only needed for desktop-access rdpclient)"; fi
if command -v rustc >/dev/null 2>&1; then info "[opt] rustc: $(rustc --version 2>/dev/null)"; fi

# BPF (enhanced session recording)
if command -v clang >/dev/null 2>&1; then info "[opt] clang: $(clang --version 2>/dev/null | head -n1)"; else info "[opt] clang/llvm: not installed (only needed for BPF enhanced recording)"; fi
if pkg-config --exists libbpf 2>/dev/null; then info "[opt] libbpf: present ($(pkg-config --modversion libbpf 2>/dev/null))"; else info "[opt] libbpf-dev: not installed (BPF feature)"; fi

# PIV (hardware key) — libpcsclite
if pkg-config --exists libpcsclite 2>/dev/null; then info "[opt] libpcsclite: present ($(pkg-config --modversion libpcsclite 2>/dev/null))"; else info "[opt] libpcsclite-dev: not installed — disable PIV with PIV=no (or apt install libpcsclite-dev)"; fi

# wasm-opt (binaryen) — some web build steps
if command -v wasm-opt >/dev/null 2>&1; then info "[opt] wasm-opt: $(wasm-opt --version 2>/dev/null | head -n1)"; else info "[opt] wasm-opt (binaryen): not installed (only if a wasm build step is required)"; fi

# =====================================================================
hdr "7. Teleport source checkout sanity"
if [ -n "${SRC}" ] && [ -f "${SRC}/go.mod" ]; then
  ok "Source found at: ${SRC}"
  info "module line : $(head -n1 "${SRC}/go.mod")"
  info "go.mod go   : $(grep -E '^go [0-9]' "${SRC}/go.mod" | head -n1)"
  if [ -d "${SRC}/.git" ]; then
    info "git branch  : $(git -C "${SRC}" rev-parse --abbrev-ref HEAD 2>/dev/null)"
    info "git describe: $(git -C "${SRC}" describe --tags 2>/dev/null || echo n/a)"
    info "git HEAD    : $(git -C "${SRC}" rev-parse --short HEAD 2>/dev/null)"
  else
    warn "Source is not a git checkout (.git missing) — fine for building, but no version info"
  fi
  for f in Makefile common.mk webassets_embed.go package.json pnpm-lock.yaml; do
    if [ -e "${SRC}/${f}" ]; then info "present: ${f}"; else warn "missing expected file: ${f}"; fi
  done
else
  bad "Teleport source not found. Re-run as: bash $0 /path/to/teleport"
fi

# =====================================================================
hdr "SUMMARY"
say "PASS: ${PASS}    WARN: ${WARN}    FAIL: ${FAIL}"
say ""
if [ "${FAIL}" -eq 0 ]; then
  say ">> No hard blockers detected. Review WARNs above before building."
else
  say ">> ${FAIL} blocking issue(s) found (see [FAIL] lines). Resolve these before building."
fi
say ""
say "Send the full log back: ${LOG}"
say "(cat it with:  cat \"${LOG}\" )"

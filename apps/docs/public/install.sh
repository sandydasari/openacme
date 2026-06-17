#!/bin/sh
# OpenAcme installer for macOS and Linux.
#   curl -fsSL https://openacme.pages.dev/install.sh | sh
#
# Bootstraps Node.js if needed, installs the @openacme/cli global package, then
# starts the daemon. Idempotent — safe to re-run to upgrade or repair.
#
# Flags (pass after `| sh -s --`):
#   --no-start   install/upgrade only; don't start the daemon
#   --dry-run    print what would happen; change nothing
#   --help       show this help
#
# Env:
#   OPENACME_SKIP_NODE=1   never try to install Node (fail if too old/missing)

set -eu

NODE_MIN_MAJOR=18
NODE_BOOTSTRAP_MAJOR=22
PKG="@openacme/cli@latest"

NO_START=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --no-start) NO_START=1 ;;
    --dry-run)  DRY_RUN=1 ;;
    --help|-h)
      sed -n '2,18p' "$0" 2>/dev/null || true
      exit 0
      ;;
    *) printf 'unknown option: %s\n' "$arg" >&2; exit 2 ;;
  esac
done

# ── output helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD="$(printf '\033[1m')"; DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"; GREEN="$(printf '\033[32m')"; NC="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GREEN=""; NC=""
fi
info() { printf '%s\n' "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$NC" "$*"; }
warn() { printf '%s!%s %s\n' "$RED" "$NC" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$NC" >&2; exit 1; }
run()  { if [ "$DRY_RUN" = 1 ]; then printf '%s+ %s%s\n' "$DIM" "$*" "$NC"; else "$@"; fi; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── platform ────────────────────────────────────────────────────────────────
OS="$(uname -s 2>/dev/null || echo unknown)"
case "$OS" in
  Darwin) OS=macos ;;
  Linux)  OS=linux ;;
  *) die "unsupported OS: $OS (macOS and Linux only)" ;;
esac

node_major() { node -v 2>/dev/null | sed 's/^v//' | cut -d. -f1; }
node_ok() {
  have node || return 1
  _m="$(node_major)"
  [ -n "$_m" ] && [ "$_m" -ge "$NODE_MIN_MAJOR" ] 2>/dev/null
}

install_node() {
  [ "${OPENACME_SKIP_NODE:-0}" = 1 ] && die "Node.js >= ${NODE_MIN_MAJOR} required (OPENACME_SKIP_NODE=1 set)"
  info "Installing Node.js ${NODE_BOOTSTRAP_MAJOR} ..."
  if [ "$OS" = macos ]; then
    if have brew; then
      run brew install "node@${NODE_BOOTSTRAP_MAJOR}" || run brew install node
      # brew keg-only versioned formula may need PATH help
      if have brew && [ -d "$(brew --prefix 2>/dev/null)/opt/node@${NODE_BOOTSTRAP_MAJOR}/bin" ]; then
        PATH="$(brew --prefix)/opt/node@${NODE_BOOTSTRAP_MAJOR}/bin:$PATH"
        export PATH
      fi
    else
      die "Homebrew not found. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org and re-run."
    fi
  else
    # Linux: prefer a system package manager, else point to nodejs.org.
    if have apt-get; then
      run sh -c "curl -fsSL https://deb.nodesource.com/setup_${NODE_BOOTSTRAP_MAJOR}.x | ${SUDO:-sudo} -E bash -" \
        && run "${SUDO:-sudo}" apt-get install -y nodejs
    elif have dnf; then
      run "${SUDO:-sudo}" dnf install -y nodejs
    elif have apk; then
      run "${SUDO:-sudo}" apk add --no-cache nodejs npm
    else
      die "No supported package manager. Install Node.js >= ${NODE_MIN_MAJOR} from https://nodejs.org and re-run."
    fi
  fi
  node_ok || die "Node.js install did not produce a working node >= ${NODE_MIN_MAJOR} on PATH."
  ok "Node.js $(node -v) ready"
}

# ── main ────────────────────────────────────────────────────────────────────
printf '%sOpenAcme installer%s\n' "$BOLD" "$NC"

if node_ok; then
  ok "Node.js $(node -v) detected"
else
  install_node
fi

have npm || die "npm not found alongside node — fix your Node install and re-run."

info "Installing ${PKG} ..."
if ! run npm install -g "$PKG"; then
  warn "Global install failed."
  warn "If this is a permissions (EACCES) error, your npm global prefix needs sudo,"
  warn "or set a user-writable prefix:  npm config set prefix ~/.npm-global"
  die "install aborted"
fi
ok "openacme installed"

if [ "$NO_START" = 1 ]; then
  info "Skipping start (--no-start). Run ${BOLD}openacme start${NC} when ready."
  exit 0
fi

info "Starting the daemon ..."
run openacme start

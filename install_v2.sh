#!/usr/bin/env bash
#
# Usage: ./install.sh [--rebuild-parsers]
#
#   Regular user -> installs tools with Homebrew (as before)
#   root         -> Homebrew refuses to run as root, so tools come from the
#                   system package manager (apt / dnf / pacman) and GitHub
#                   release binaries instead. Linux only.
#
#   --rebuild-parsers  wipe compiled treesitter parsers so Neovim rebuilds them
#                      (the scripted version of ":TSUninstall all" + ":TSUpdate")

set -euo pipefail

SETUP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIN_NVIM="0.12.0"
REBUILD_PARSERS=false

for arg in "$@"; do
    case "$arg" in
        --rebuild-parsers) REBUILD_PARSERS=true ;;
        -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
        *) echo "Unknown option: $arg"; exit 1 ;;
    esac
done

# Make tools installed during this run usable immediately
# (uv -> ~/.local/bin, cargo -> ~/.cargo/bin)
export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"

have() { command -v "$1" &> /dev/null; }

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "🚀 Starting setup installation..."

# ---------------------------------------------------------------------------
# Root mode: no Homebrew
# ---------------------------------------------------------------------------

detect_arch() {
    case "$(uname -m)" in
        x86_64|amd64)  NVIM_ARCH="x86_64"; RUST_ARCH="x86_64" ;;
        aarch64|arm64) NVIM_ARCH="arm64";  RUST_ARCH="aarch64" ;;
        *) echo "❌ Unsupported architecture: $(uname -m)"; exit 1 ;;
    esac
}

install_system_packages() {
    echo "📦 Installing system packages..."
    if have apt-get; then
        export DEBIAN_FRONTEND=noninteractive
        apt-get update
        apt-get install -y curl ca-certificates git unzip tar gzip \
            build-essential ripgrep fd-find mosh
        # Debian/Ubuntu ship fd as "fdfind"
        if ! have fd && have fdfind; then
            ln -sf "$(command -v fdfind)" /usr/local/bin/fd
        fi
    elif have dnf; then
        dnf install -y curl ca-certificates git unzip tar gzip \
            gcc gcc-c++ make ripgrep fd-find mosh
    elif have pacman; then
        pacman -Syu --noconfirm --needed curl ca-certificates git unzip tar gzip \
            base-devel ripgrep fd mosh
    else
        echo "❌ No supported package manager found (apt, dnf, pacman)."
        exit 1
    fi
}

nvim_version() {
    nvim --version 2> /dev/null | head -n1 | sed -E 's/^NVIM v([0-9]+\.[0-9]+\.[0-9]+).*/\1/'
}

nvim_recent_enough() {
    have nvim || return 1
    local v; v="$(nvim_version)"
    [ "$(printf '%s\n%s\n' "$MIN_NVIM" "$v" | sort -V | head -n1)" = "$MIN_NVIM" ]
}

install_neovim_release() {
    # Distro packages are usually far older than 0.12, so use the official build
    if nvim_recent_enough; then
        echo "✓ Neovim $(nvim_version) already installed"
        return
    fi
    echo "📦 Installing latest Neovim release..."
    local name="nvim-linux-${NVIM_ARCH}"
    curl -fsSL -o "$TMP/$name.tar.gz" \
        "https://github.com/neovim/neovim/releases/latest/download/$name.tar.gz"
    rm -rf "/opt/$name"
    tar -C /opt -xzf "$TMP/$name.tar.gz"
    ln -sf "/opt/$name/bin/nvim" /usr/local/bin/nvim
    hash -r
    echo "✓ Neovim $(nvim_version) installed to /opt/$name"
}

install_yazi_release() {
    if have yazi; then
        echo "✓ yazi already installed"
        return
    fi
    echo "📦 Installing yazi..."
    local name="yazi-${RUST_ARCH}-unknown-linux-musl"
    curl -fsSL -o "$TMP/yazi.zip" \
        "https://github.com/sxyazi/yazi/releases/latest/download/$name.zip"
    unzip -qo "$TMP/yazi.zip" -d "$TMP"
    install -m 755 "$TMP/$name/yazi" "$TMP/$name/ya" /usr/local/bin/
}

# ---------------------------------------------------------------------------
# Regular user mode: Homebrew
# ---------------------------------------------------------------------------

load_brew_env() {
    local b
    for b in /opt/homebrew/bin/brew /usr/local/bin/brew /home/linuxbrew/.linuxbrew/bin/brew; do
        if [ -x "$b" ]; then
            eval "$("$b" shellenv)"
            return
        fi
    done
}

install_with_brew() {
    if ! have brew; then
        echo "📦 Installing Homebrew..."
        /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
    else
        echo "✓ Homebrew already installed"
    fi
    # A fresh install isn't on PATH yet (Linux, Apple Silicon)
    load_brew_env

    echo "📦 Installing essential tools..."
    brew install neovim ripgrep pyright yazi fd mosh tree-sitter-cli
}

# ---------------------------------------------------------------------------
# Install tools
# ---------------------------------------------------------------------------

if [ "$(id -u)" -eq 0 ]; then
    if [ "$(uname -s)" != "Linux" ]; then
        echo "❌ Running as root is only supported on Linux."
        exit 1
    fi
    ROOT_HOME="$(getent passwd 0 | cut -d: -f6)"
    if [ -n "${SUDO_USER:-}" ] && [ "$HOME" != "$ROOT_HOME" ]; then
        echo "❌ Running under sudo with HOME=$HOME: files would end up root-owned in $SUDO_USER's home."
        echo "   Run as $SUDO_USER without sudo (Homebrew mode), or as root with: sudo -H $0"
        exit 1
    fi
    echo "👤 Running as root: skipping Homebrew, using system packages"
    ROOT_MODE=true
    detect_arch
    install_system_packages
    install_neovim_release
    install_yazi_release
else
    ROOT_MODE=false
    install_with_brew
fi

# uv
if ! have uv; then
    echo "📦 Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
else
    echo "✓ uv already installed"
fi

echo "📦 Installing uv tools..."
uv tool install ruff
uv tool install ipython
if $ROOT_MODE; then
    # No brew pyright in root mode: the PyPI wrapper with a bundled Node.js
    # provides both `pyright` and `pyright-langserver`
    uv tool install 'pyright[nodejs]'
    pyright --version > /dev/null   # first run fetches pyright itself; do it now, not in the LSP
fi
uv tool update-shell > /dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# Tree-sitter CLI (required by Neovim 0.12+ / nvim-treesitter to build parsers)
# ---------------------------------------------------------------------------

HAVE_CC=true
if ! have cc && ! have gcc && ! have clang; then
    HAVE_CC=false
    echo "⚠️  No C compiler found: treesitter parsers won't compile."
    echo "   Install one (e.g. build-essential, or 'xcode-select --install' on macOS)."
fi

if have tree-sitter; then
    echo "✓ tree-sitter CLI already installed ($(tree-sitter --version))"
else
    if ! $HAVE_CC; then
        echo "❌ Building tree-sitter CLI with cargo needs a C compiler; install one and re-run."
        exit 1
    fi
    if ! have cargo; then
        echo "📦 Installing Rust toolchain (for tree-sitter CLI)..."
        curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
    fi
    echo "📦 Installing tree-sitter CLI via cargo (this takes a few minutes)..."
    cargo install --locked tree-sitter-cli
fi

# ---------------------------------------------------------------------------
# Neovim config
# ---------------------------------------------------------------------------

echo "🔗 Linking Neovim config..."
mkdir -p "$HOME/.config"
NVIM_TARGET="$HOME/.config/nvim"
NVIM_SOURCE="$SETUP_DIR/config/nvim"

if [ -L "$NVIM_TARGET" ] && [ "$(readlink "$NVIM_TARGET")" = "$NVIM_SOURCE" ]; then
    echo "✓ ~/.config/nvim already points to $NVIM_SOURCE"
else
    if [ -e "$NVIM_TARGET" ] || [ -L "$NVIM_TARGET" ]; then
        BACKUP="$NVIM_TARGET.backup.$(date +%Y%m%d_%H%M%S)"
        echo "⚠️  ~/.config/nvim already exists, moving it to $BACKUP"
        mv "$NVIM_TARGET" "$BACKUP"
    fi
    ln -s "$NVIM_SOURCE" "$NVIM_TARGET"
fi

# ---------------------------------------------------------------------------
# Treesitter parser cleanup
# ---------------------------------------------------------------------------
# Parsers compiled by the old nvim-treesitter (master branch) live inside the
# plugin dir and cause errors like "attempt to call method 'range'" on newer
# Neovim. Removing them = ":TSUninstall all"; Neovim rebuilds on next launch.

NVIM_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/nvim"
OLD_PARSERS="$NVIM_DATA/lazy/nvim-treesitter/parser"

if $REBUILD_PARSERS || [ -d "$OLD_PARSERS" ]; then
    echo "🌳 Removing compiled treesitter parsers so they get rebuilt..."
    rm -rf "$OLD_PARSERS" "$NVIM_DATA/lazy/nvim-treesitter/parser-info" \
           "$NVIM_DATA/site/parser" "$NVIM_DATA/site/parser-info" \
           "$NVIM_DATA/site/queries"
fi

echo "🔌 Syncing Neovim plugins (headless)..."
if ! nvim --headless "+Lazy! sync" +qa; then
    echo "⚠️  Headless plugin sync failed; plugins will install on first launch instead."
fi

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Restart your shell (or run: source ~/.bashrc) so uv/cargo tools are on PATH"
echo "2. Open Neovim: nvim"
echo "3. Wait for treesitter parsers to finish installing, then restart Neovim"
echo ""
echo "If you still see treesitter errors: ./install.sh --rebuild-parsers"


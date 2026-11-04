#!/bin/bash

set -e  # Exit on error

echo "🚀 Starting setup installation..."

# Check if Homebrew is installed
if ! command -v brew &> /dev/null; then
    echo "📦 Installing Homebrew..."
    /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
else
    echo "✓ Homebrew already installed"
fi

# Install essential tools
echo "📦 Installing essential tools..."
brew install neovim ripgrep pyright yazi fd mosh

# Install uv if not installed
if ! command -v uv &> /dev/null; then
    echo "📦 Installing uv..."
    curl -LsSf https://astral.sh/uv/install.sh | sh
else
    echo "✓ uv already installed"
fi

# Install uv tools
echo "📦 Installing uv tools..."
uv tool install ruff
uv tool install ipython

# Create Neovim symlink
echo "🔗 Creating Neovim symlink..."
if [ -d ~/.config/nvim ] || [ -L ~/.config/nvim ]; then
    echo "⚠️  ~/.config/nvim already exists. Creating backup..."
    mv ~/.config/nvim ~/.config/nvim.backup.$(date +%Y%m%d_%H%M%S)
fi

ln -sf ~/setup/config/nvim ~/.config/nvim

echo ""
echo "✅ Installation complete!"
echo ""
echo "Next steps:"
echo "1. Open Neovim: nvim"
echo "2. Wait for plugins to install"
echo "3. Restart Neovim"
echo ""
echo "Note: You may need to restart your terminal for uv tools to be available."


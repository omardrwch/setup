# Setup

My personal development environment setup and configurations.

## Quick Install
```bash
git clone https://github.com/omardrwch/setup.git ~/setup
cd ~/setup
chmod +x install.sh
./install.sh
```

## What Gets Installed

**Homebrew packages:**
- neovim - Text editor
- ripgrep - Fast text search (for Telescope)
- pyright - Python LSP
- yazi - Terminal file manager
- fd - Fast file finder
- mosh - Alternative to ssh


**uv tools:**
- ruff - Python linter/formatter
- ipython - Enhanced Python REPL

## Manual Setup (if you prefer)

<details>
<summary>Click to expand manual installation steps</summary>

### Install Homebrew
```bash
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
```

### Install tools
```bash
brew install neovim ripgrep pyright yazi fd mosh
```

### Install uv and tools
```bash
curl -LsSf https://astral.sh/uv/install.sh | sh
uv tool install ruff
uv tool install ipython
```

### Link Neovim config
```bash
ln -sf ~/setup/config/nvim ~/.config/nvim
```

</details>

## Using Yazi in Neovim

Open a terminal split and launch Yazi:
```vim
:vs | term
```
Then type `yazi` in the terminal.

**Basic Yazi commands:**
- `j/k` - Navigate up/down
- `h/l` - Go to parent/child directory
- `Enter` - Open file
- `Space` - Select file
- `y` - Copy
- `p` - Paste
- `d` - Delete
- `r` - Rename
- `q` - Quit

## Key Features

- **Plugin Manager:** lazy.nvim
- **Fuzzy Finder:** Telescope
- **LSP:** Configured for Python (Pyright)
- **Syntax Highlighting:** Treesitter
- **Statusline:** mini.statusline
- **Colorscheme:** Tokyo Night

## Neovim Treesitter Setup

Neovim 0.12+ requires the `tree-sitter` CLI to compile parsers. Install it via Cargo (not npm):

```bash
cargo install tree-sitter-cli
```

On first launch, Neovim will install treesitter parsers automatically. If you're migrating from an older Neovim/nvim-treesitter setup, you may need to rebuild parsers:

```vim
:TSUninstall all
```

Then restart Neovim and run:

```vim
:TSUpdate
```

## Troubleshooting

**LSP not working:**
- Make sure Pyright is installed: `which pyright`
- Restart Neovim

**Telescope live grep not working:**
- Check ripgrep is installed: `which rg`

**Treesitter errors (`attempt to call method 'range'`, etc):**
- Make sure the `tree-sitter` CLI is installed: `which tree-sitter`
- Run `:TSUninstall all`, restart Neovim, then `:TSUpdate`

**uv tools not found:**
- Restart your terminal
- Check PATH: `echo $PATH` should include `~/.local/bin`


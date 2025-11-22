# Neovim Cheatsheet

## Leader Key
- Leader = `Space`

## Basic Vim (Built-in)
- `i` - Insert mode
- `a` - Insert mode (after cursor)
- `Esc` or `Ctrl-[` - Normal mode
- `v` - Character-wise visual mode
- `V` - Line-wise visual mode
- `Ctrl-v` - Block visual mode
- `:w` - Save file
- `:q` - Quit
- `:wq` or `ZZ` - Save and quit
- `:q!` or `ZQ` - Quit without saving

## Movement (Built-in)
- `h/j/k/l` - Left/Down/Up/Right
- `w` - Next word
- `b` - Previous word
- `0` - Start of line
- `$` - End of line
- `%` - Jump to matching bracket/parenthesis
- `gg` - Top of file
- `G` - Bottom of file
- `{number}G` - Go to line number
- `*` - Search for word under cursor (forward)
- `#` - Search for word under cursor (backward)
- `n` / `N` - Next/previous search result

## Editing (Built-in)
- `x` - Delete character under cursor
- `dd` - Delete line
- `D` - Delete to end of line
- `C` - Change to end of line
- `yy` - Yank (copy) line
- `p` - Paste after cursor
- `P` - Paste before cursor
- `o` - Open new line below
- `O` - Open new line above
- `u` - Undo
- `Ctrl-r` - Redo
- `.` - Repeat last command
- `>>` / `<<` - Indent/unindent line
- `==` - Auto-indent current line

## Visual Mode (Built-in)
- `v` - Character-wise visual mode
- `V` - Line-wise visual mode
- `Ctrl-v` - Block visual mode
- `y` - Yank selection
- `d` - Delete selection
- `p` - Paste
- `>` / `<` - Indent/unindent selection
- `=` - Auto-indent selection

## Search & Replace (Built-in)
- `/pattern` - Search forward
- `?pattern` - Search backward
- `n` / `N` - Next/previous match
- `:%s/old/new/g` - Replace all in file
- `:%s/old/new/gc` - Replace all with confirmation
- `:s/old/new/g` - Replace all in line

## Clipboard (Custom)
- `<leader>y` - Yank to system clipboard (works with motions)
- `<leader>yy` - Yank line to system clipboard
- `<leader>Y` - Yank to end of line to system clipboard
- `<leader>cf` - Copy filename to clipboard
- `<leader>cd` - Copy directory path to clipboard

## Buffer Management (Custom)
- `<leader>n` - Next buffer
- `<leader>p` - Previous buffer
- `<leader>d` - Delete buffer
- `:ls` - List all buffers
- `:b{number}` - Go to buffer number

## Window Management
### Splits (Built-in)
- `:sp` or `Ctrl-w s` - Horizontal split
- `:vs` or `Ctrl-w v` - Vertical split
- `Ctrl-w q` or `:q` - Close window

### Navigation (Custom)
- `Ctrl-h` - Move to left window
- `Ctrl-j` - Move to window below
- `Ctrl-k` - Move to window above
- `Ctrl-l` - Move to right window
- `<leader>q` - Close current window

### Resizing (Built-in)
- `Ctrl-w =` - Equal size windows
- `Ctrl-w +/-` - Increase/decrease height
- `Ctrl-w >/<` - Increase/decrease width

## Telescope (Fuzzy Finder)
- `<leader>ff` - Find files
- `<leader>fg` - Live grep (search in files)
- `<leader>fb` - Find buffers
- `<leader>fr` - Recent files
- `<leader>fw` - Find word under cursor
- `<leader>fh` - Help tags

### Inside Telescope:
- `Ctrl-j/k` - Navigate up/down
- `Enter` - Open file
- `Ctrl-x` - Open in horizontal split
- `Ctrl-v` - Open in vertical split
- `Esc` - Close Telescope

## LSP (Python with Pyright)
- `K` - Hover documentation
- `gd` - Go to definition
- `<leader>e` - Show diagnostic
- `[d` - Previous diagnostic
- `]d` - Next diagnostic

## Development Commands
- `<space><space>x` - Source current file (reload config)
- `<space>x` - Execute current line (Lua code)

## File Explorer
- `:e .` - Open netrw (built-in file explorer)
- Or use Telescope: `<leader>ff` (faster)
- Or use Yazi: `<leader>-` (visual browsing)

### Inside netrw:
- `Enter` - Open file/directory
- `-` - Go up a directory
- `%` - Create new file
- `d` - Create new directory
- `D` - Delete file/directory

## Terminal
- `:sp | term` - Open terminal in horizontal split
- `:vs | term` - Open terminal in vertical split
- `i` or `a` - Enter terminal insert mode (type commands)
- `Ctrl-\ Ctrl-n` - Exit terminal mode to normal mode
- `Esc Esc` - Exit terminal mode (press Esc twice)
- `Ctrl-h/j/k/l` - Navigate between windows (works from terminal)

## Yazi (File Manager)
- `<leader>-` - Open Yazi at current file location
- `<leader>cw` - Open Yazi at working directory

### Inside Yazi:
- `j/k` or `↓/↑` - Navigate up/down
- `h/l` or `←/→` - Go to parent/child directory
- `Enter` - Open file in Neovim
- `Space` - Select/deselect file
- `y` - Yank (copy) selected files
- `x` - Cut selected files
- `p` - Paste files
- `d` - Delete selected files
- `r` - Rename file
- `a` - Create new file
- `A` - Create new directory
- `/` - Search in current directory
- `q` or `Esc` - Close Yazi

## Auto-completion
- `Tab` / `Shift-Tab` - Next/previous suggestion
- `Enter` - Accept completion
- `Ctrl-Space` - Manually trigger completion menu
- `Ctrl-e` - Close completion menu
- Completions appear automatically as you type

## Git (Gitsigns)
### Visual indicators in gutter:
- `│` (green) - Added lines
- `│` (blue) - Changed lines
- `_` (red) - Deleted lines

### Navigation:
- `]c` - Jump to next git change (hunk)
- `[c` - Jump to previous git change (hunk)

### Actions:
- `<leader>gp` - Preview diff in floating window
- `<leader>gb` - Show git blame for current line
- `<leader>gd` - Open full diff view
- `<leader>gr` - Reset/undo current change
- `<leader>gR` - Reset all changes in file


-- Set <Space> as leader key
vim.g.mapleader = " "
vim.g.maplocalleader = " "

require("config.lazy")

-- Prevent mappings from being recursive
local noremap = { noremap = true, silent = true }


-- Sometimes needed for clipboard stuff. Not always though.
-- vim.opt.clipboard = "unnamedplus"

-- Show absolute line number on the current line
vim.opt.number = true         
-- Show relative numbers on all other lines
vim.opt.relativenumber = true 

-- Tab = 4 spaces
vim.opt.shiftwidth = 4

-- source current file
vim.keymap.set("n", "<space><space>x", "<cmd>source %<CR>")
-- execute current line
vim.keymap.set("n", "<space>x", ":.lua<CR>")

-- Visual mode: copy selection to system clipboard
vim.keymap.set("v", "<leader>y", '"+y', { desc = "Yank selection to clipboard" })

-- Normal mode: copy motion/line to system clipboard
vim.keymap.set("n", "<leader>y", '"+y', { desc = "Yank motion to clipboard" })
vim.keymap.set("n", "<leader>yy", '"+yy', { desc = "Yank line to clipboard" })
vim.keymap.set("n", "<leader>Y", '"+yg_', { desc = "Yank to end of line to clipboard" })

-- Highlight when yanking (copying) text
-- Try it with `yap` in normal mode
-- See :help vim.highlight.on_yank()
vim.api.nvim_create_autocmd('TextYankPost', {
  desc = 'Highlight when yanking (copying) text',
  group = vim.api.nvim_create_augroup('kickstart-highlight-yank', { clear = true }),
  callback = function()
    vim.highlight.on_yank()
  end,
})

-- Copy current file name to clipboard
vim.keymap.set("n", "<leader>cf", function()
  local filename = vim.fn.expand("%:p")  -- copy full path
  vim.fn.setreg("+", filename)
  vim.notify("📋 Copied file name: " .. filename, vim.log.levels.INFO)
end, { desc = "Copy file name to clipboard" })

-- Copy current directory to clipboard
vim.keymap.set("n", "<leader>cd", function()
  local dir = vim.fn.expand("%:p:h")  -- full path to file's directory
  vim.fn.setreg("+", dir)
  vim.notify("📁 Copied directory: " .. dir, vim.log.levels.INFO)
end, { desc = "Copy file directory to clipboard" })

-- Buffer navigation
vim.keymap.set("n", "<leader>n", ":bnext<CR>", { desc = "Next buffer" })
vim.keymap.set("n", "<leader>p", ":bprevious<CR>", { desc = "Previous buffer" })
vim.keymap.set("n", "<leader>d", ":bdelete<CR>", { desc = "Delete buffer" })

-- Window navigation (easier than Ctrl-w h/j/k/l)
vim.keymap.set("n", "<C-h>", "<C-w>h", { desc = "Move to left window" })
vim.keymap.set("n", "<C-j>", "<C-w>j", { desc = "Move to window below" })
vim.keymap.set("n", "<C-k>", "<C-w>k", { desc = "Move to window above" })
vim.keymap.set("n", "<C-l>", "<C-w>l", { desc = "Move to right window" })
vim.keymap.set("n", "<leader>q", "<C-w>q", { desc = "Close window" })

-- Easier terminal escape (double Esc)
vim.keymap.set("t", "<Esc><Esc>", "<C-\\><C-n>", { desc = "Exit terminal mode" })

-- No swap files
vim.opt.swapfile = false

-- Quick save
vim.keymap.set("n", "<leader>w", ":w<CR>", { desc = "Save file" })

-- ================================================================================
-- Telescope utilities
-- ================================================================================
-- Essential: Interactive directory search
vim.keymap.set('n', '<leader>fd', function()
  local dir = vim.fn.input("Search in directory: ", vim.fn.getcwd() .. "/", "dir")
  if dir ~= "" then
    require('telescope.builtin').live_grep({ cwd = dir })
  end
end, { desc = "Find in directory" })

-- Quick shortcut: Search in current file's directory
vim.keymap.set('n', '<leader>f.', function()
  require('telescope.builtin').live_grep({ cwd = vim.fn.expand('%:p:h') })
end, { desc = "Find in current file directory" })

-- File search with fixed (non-regex strings
vim.keymap.set('n', '<leader>fs', function()
  require('telescope.builtin').live_grep({
    additional_args = function()
      return { '--fixed-strings' }
    end
  })
end, { desc = 'Search (literal)' })


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
  local filename = vim.fn.expand("%:t")  -- just the file name, like "main.py"
  vim.fn.setreg("+", filename)
  vim.notify("📋 Copied file name: " .. filename, vim.log.levels.INFO)
end, { desc = "Copy file name to clipboard" })

-- Copy current directory to clipboard
vim.keymap.set("n", "<leader>cd", function()
  local dir = vim.fn.expand("%:p:h")  -- full path to file's directory
  vim.fn.setreg("+", dir)
  vim.notify("📁 Copied directory: " .. dir, vim.log.levels.INFO)
end, { desc = "Copy file directory to clipboard" })

-- LSP
vim.lsp.enable("pyright")


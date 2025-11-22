return {
  {
    "neovim/nvim-lspconfig",
    config = function()
      local lspconfig = require("lspconfig")

      lspconfig.pyright.setup({
        cmd = { "pyright-langserver", "--stdio" },
        filetypes = { "python" },
        root_dir = lspconfig.util.root_pattern(
          "pyproject.toml",
          "setup.py",
          "setup.cfg",
          "requirements.txt",
          "Pipfile",
          "pyrightconfig.json",
          ".git"
        ),
        settings = {
          python = {
            analysis = {
              autoSearchPaths = true,
              diagnosticMode = "openFilesOnly",
              useLibraryCodeForTypes = true,
            },
          },
        },
        on_attach = function(client, bufnr)
          local bufmap = function(mode, lhs, rhs, desc)
            vim.keymap.set(mode, lhs, rhs, { buffer = bufnr, desc = desc })
          end

          bufmap("n", "K", vim.lsp.buf.hover, "LSP Hover")
          bufmap("n", "gd", vim.lsp.buf.definition, "Go to Definition")
          bufmap("n", "<leader>e", vim.diagnostic.open_float, "Show Diagnostic")
          bufmap("n", "[d", vim.diagnostic.goto_prev, "Prev Diagnostic")
          bufmap("n", "]d", vim.diagnostic.goto_next, "Next Diagnostic")
        end,
      })
    end,
  },
}


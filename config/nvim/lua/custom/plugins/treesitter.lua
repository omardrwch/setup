return {
    {
	"nvim-treesitter/nvim-treesitter",
	branch = "main",
	lazy = false,
	build = ":TSUpdate",
	config = function()
	    require("nvim-treesitter").setup({})
	    require("nvim-treesitter").install({
		"c", "lua", "python", "vim", "vimdoc", "query", "markdown", "markdown_inline",
	    })
	end,
	init = function()
	    vim.api.nvim_create_autocmd("FileType", {
		callback = function(args)
		    local max_filesize = 100 * 1024
		    local ok, stats = pcall(vim.uv.fs_stat, vim.api.nvim_buf_get_name(args.buf))
		    if ok and stats and stats.size > max_filesize then
			return
		    end
		    pcall(vim.treesitter.start)
		end,
	    })
	end,
    }
}

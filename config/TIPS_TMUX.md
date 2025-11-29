# TMux Minimal Cheatsheet

**Prefix = `Ctrl+b`** (press before every command)

## Essential Commands

### Windows (tabs)
```
prefix c        New window
prefix n        Next window
prefix p        Previous window
prefix 0-9      Jump to window #
prefix ,        Rename window
```

### Panes (splits)
```
prefix %        Split vertical   |
prefix "        Split horizontal ─
prefix ←↑→↓     Navigate panes
prefix z        Zoom pane (toggle fullscreen)
prefix x        Kill pane
```

### Sessions
```
tmux new -s name     Start named session
tmux attach -t name  Reattach to session
prefix d             Detach from session
```

### Help
```
prefix ?        Show all keybindings
```


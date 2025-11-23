import subprocess
import sys
import shutil

def run(cmd):
    p = subprocess.Popen(cmd, stdin=sys.stdin.buffer)
    p.communicate()
    return p.returncode

def main():
    # macOS
    if shutil.which("pbcopy"):
        return run(["pbcopy"])

    # Wayland
    if shutil.which("wl-copy"):
        return run(["wl-copy"])

    # X11
    if shutil.which("xclip"):
        return run(["xclip", "-selection", "clipboard"])

    if shutil.which("xsel"):
        return run(["xsel", "--clipboard", "--input"])

    print("No clipboard tool found", file=sys.stderr)
    return 1


import subprocess
import sys
import shutil

def run(cmd):
    p = subprocess.Popen(cmd, stdout=sys.stdout.buffer)
    p.communicate()
    return p.returncode

def main():
    # macOS
    if shutil.which("pbpaste"):
        return run(["pbpaste"])

    # Wayland
    if shutil.which("wl-paste"):
        return run(["wl-paste"])

    # X11
    if shutil.which("xclip"):
        return run(["xclip", "-selection", "clipboard", "-o"])

    if shutil.which("xsel"):
        return run(["xsel", "--clipboard", "--output"])

    print("No clipboard tool found", file=sys.stderr)
    return 1


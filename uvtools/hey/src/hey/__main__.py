#!/usr/bin/env python3
import sys
import argparse
import subprocess
import requests
import pathlib
import pyperclip


OLLAMA_API = "http://localhost:11434/api/chat"
MODEL = "qwen2.5-coder:7b"  # Change to your preferred model


def call_ollama(prompt, system_prompt, model=MODEL):
    """Call Ollama API and get response."""
    payload = {
        "model": model,
        "messages": [
            # {"role": "system", "content": system_prompt},
            # {"role": "user", "content": prompt}
            # NOTE(omar): it seems to work better if the system_prompt is given as a user turn.
            {"role": "user", "content": f"{system_prompt}\n\n{prompt}"}
        ],
        "stream": False
    }

    try:
        response = requests.post(OLLAMA_API, json=payload, timeout=120)
        response.raise_for_status()
        return response.json()["message"]["content"]
    except requests.exceptions.RequestException as e:
        print(f"Error connecting to Ollama: {e}", file=sys.stderr)
        print("Make sure Ollama is running and the model is available", file=sys.stderr)
        sys.exit(1)


def get_file_content(file_path):
    with open(file_path, "r") as f:
        return f.read()


def get_folder_context(folder_path):
    """Get folder contents using tree-content."""
    try:
        _ = subprocess.run(
            ["tree-content", folder_path, "/tmp/hey-context.txt"],
            capture_output=True,
            text=True,
            check=True
        )
        with open("/tmp/hey-context.txt", "r") as f:
            return f.read()
    except subprocess.CalledProcessError:
        print("Error: tree-content command failed", file=sys.stderr)
        print("Make sure tree-content is installed: uv tool install tree-content", file=sys.stderr)
        sys.exit(1)
    except FileNotFoundError:
        print("Error: tree-content not found", file=sys.stderr)
        print("Install it with: uv tool install tree-content", file=sys.stderr)
        sys.exit(1)


def copy_to_clipboard(text):
    """Copy text to clipboard."""
    try:
        pyperclip.copy(text)
        return True
    except Exception:
        return False

def main():
    parser = argparse.ArgumentParser(
        description="Terminal AI assistant powered by Ollama",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Examples:
  hey list all txt files in current directory
  hey -d find files modified in last 24 hours
  hey -q what does grep do?
  hey -c ~/.config/nvim how to enable line numbers?
        """
    )
    
    parser.add_argument(
        "prompt",
        nargs="*",
        help="Natural language instruction"
    )
    
    parser.add_argument(
        "-d", "--describe",
        action="store_true",
        help="Include explanation with the command"
    )
    
    parser.add_argument(
        "-c", "--context",
        metavar="FOLDER",
        help="Include folder contents in context"
    )
    
    parser.add_argument(
        "-q", "--question",
        action="store_true",
        help="Ask a general question (don't output command)"
    )
    
    parser.add_argument(
        "-m", "--model",
        default=MODEL,
        help=f"Ollama model to use (default: {MODEL})"
    )
    
    args = parser.parse_args()
    
    if not args.prompt:
        parser.print_help()
        sys.exit(1)
    
    prompt = " ".join(args.prompt)

    # Use the model from args
    model = args.model

    # Handle context mode
    if args.context:
        path = pathlib.Path(args.context).expanduser()
        if path.is_dir():
            print("Loading folder context...")
            context = get_folder_context(str(path))
            print("...loaded")
        elif path.is_file():
            print("Loading file content...")
            context = get_file_content(str(path))
            print("...loaded")
        else:
            print(f"Error: {path} is not a file or directory", file=sys.stderr)
            sys.exit(1)
        
        system_prompt = f"""You are a helpful assistant with access to the user's files and configuration.

    Below is the complete directory structure and file contents from: {path}

    <folder_context>
    {context}
    </folder_context>

    The user will ask you questions about these files. Answer based on the actual content provided above. Be specific and reference the actual files and code when relevant."""

        response = call_ollama(prompt, system_prompt, model)
        print(response)
        return

    # Handle question mode
    if args.question:
        system_prompt = """You are a helpful terminal/bash expert. Answer questions about terminal commands, shell scripting, and command-line tools. Be concise and clear."""
        
        response = call_ollama(prompt, system_prompt, model)
        print(response)
        return
    
    # Handle command generation (default and describe mode)
    if args.describe:
        system_prompt = """You are a bash command generator. Given a natural language instruction, output:
1. The exact bash command on the first line
2. A blank line
3. A concise 1-2 sentence explanation of what the command does

Output ONLY the command and explanation, nothing else. No markdown, no extra text."""
    else:
        system_prompt = """You are a bash command generator. Given a natural language instruction, output ONLY the exact bash command that accomplishes the task. No explanation, no markdown formatting, no extra text - just the raw command."""
    
    response = call_ollama(prompt, system_prompt, model).strip()
    
    # Extract just the command (first line) for clipboard
    command = response.split('\n')[0].strip()
    
    # Remove markdown code blocks if present
    if command.startswith('```'):
        lines = response.split('\n')
        command = lines[1] if len(lines) > 1 else command
        command = command.strip()
    
    # Copy to clipboard
    if copy_to_clipboard(command):
        print(response)
        print(f"\n✓ Command copied to clipboard!", file=sys.stderr)
    else:
        print(response)
        print(f"\n⚠ Could not copy to clipboard", file=sys.stderr)

if __name__ == "__main__":
    main()


#!/usr/bin/env sh
# Installs pi-herdr-personas locally from a clone of this repo.
set -e
cd "$(dirname "$0")"
echo "1/3 pi package (skill + extension + /personas command):"
pi install "$(pwd)" || echo "  (run: pi install <git-url>) to install from git"
echo "2/3 persona system prompts → ~/.pi/agent/personas/ (referenced by dispatch):"
mkdir -p ~/.pi/agent/personas && cp personas/*.md ~/.pi/agent/personas/
echo "3/3 herdr settle-notify plugin:"
herdr plugin link "$(pwd)/herdr-plugin/personas-notify"
echo "Done. NOW RUN /personas INSIDE PI TO CONFIGURE MODELS BEFORE ANY DELEGATION."

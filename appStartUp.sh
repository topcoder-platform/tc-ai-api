#!/bin/bash
set -eo pipefail

# Force temp files to /tmp (writable even on read-only root filesystem)
export TMPDIR=/tmp
export TEMP=/tmp
export TMP=/tmp

# Disable Mastra Studio (it tries to bundle/write files at runtime)
export MASTRA_STUDIO_DISABLED=true

# Start the app - use pre-built output directly to avoid runtime bundling
node /app/.mastra/output/index.mjs
#!/usr/bin/env bash
# Content keys of the vHIL's Docker images: the tags
# .github/workflows/image.yml publishes (ghcr.io/isc-fs/ifs-vhil:<base>,
# ifs-vhil-editor:<editor>) and scripts/vhil-docker.sh pulls. A key is a hash
# of the git objects the image's build reads, so the same inputs give the same
# tag on any machine and any change to them gives a new one.
#
#   scripts/image-key.sh    prints base=<key>, editor=<key>, clean=true|false
#
# clean=false: the inputs have uncommitted changes, so the keys don't describe
# the working tree and no published image matches it (build it instead).
set -euo pipefail
cd "$(dirname "$0")/.."

# What each build reads: docker/Dockerfile's context is docker/ and it copies
# only renode/; editor.Dockerfile's context is the repository root, filtered
# by its .dockerignore to the editor and the shell's static files.
base_inputs=(docker/Dockerfile docker/renode)
editor_inputs=(docker/editor.Dockerfile docker/editor.Dockerfile.dockerignore
               editor/pipeline-manager vhil/server/static)

# A checkout mounted into a container belongs to another uid: trust it here
# (command-line safe.directory is honoured, git-config(1)).
git() { command git -c safe.directory="$PWD" "$@"; }
hash12() { git hash-object --stdin | cut -c1-12; }
base=$(git rev-parse "${base_inputs[@]/#/HEAD:}" | hash12)
# The editor image is built FROM the base image, so its key includes the base's.
editor=$( { echo "$base"; git rev-parse "${editor_inputs[@]/#/HEAD:}"; } | hash12)
clean=true
[ -z "$(git status --porcelain -- "${base_inputs[@]}" "${editor_inputs[@]}")" ] || clean=false

echo "base=$base"
echo "editor=$editor"
echo "clean=$clean"

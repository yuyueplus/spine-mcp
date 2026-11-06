#!/usr/bin/env sh
set -eu
cd "$(dirname "$0")"
# This build runs on the target OS. cgo cross-compilation needs its own toolchain.
unset GOOS GOARCH
CGO_ENABLED=1 go run ./cmd/buildnative "$@"

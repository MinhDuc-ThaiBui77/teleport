# Runtime image for the custom Teleport fork (auth + proxy + custom Access GUI).
#
# The custom Access Request web GUI is compiled INTO the `teleport` binary
# (build tag `webassets_embed`), so this image only needs the prebuilt binaries
# — no separate web bundle.
#
# IMPORTANT — glibc: the teleport server binary REQUIRES CGO (it is glibc-linked,
# a fully-static build is not supported), so the runtime base image's glibc must
# be >= the glibc the binary was built against. Pick RUNTIME_BASE accordingly:
#   - Binary built on the repo's CentOS 7 buildbox (glibc 2.17, portable): the
#     default debian:12-slim (glibc 2.36) is fine and runs on any host kernel.
#   - Binary built on Ubuntu 24.04 (glibc 2.39): pass a matching newer base, e.g.
#       docker build -f docker/Dockerfile --build-arg RUNTIME_BASE=ubuntu:24.04 ...
# See docker/README.md, section 1, for the two build paths.
#
# Build the image from the REPO ROOT (build context = `.`):
#   docker build -f docker/Dockerfile -t teleport-custom:$(git rev-parse --short HEAD) .
#
# State (cluster CA, users, roles, access requests, locks) is NEVER in the
# image — it lives in the /var/lib/teleport volume. See docker/README.md.

ARG RUNTIME_BASE=debian:12-slim
FROM ${RUNTIME_BASE}

# dumb-init: correct PID1 signal handling (graceful drain on SIGQUIT).
# ca-certificates: outbound TLS (ACME, webhooks).
# libpam0g/libaudit1/libcap-ng0: only needed if the binary was built with PAM;
# harmless otherwise. Mirrors the official distroless image's runtime libs.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      dumb-init ca-certificates libpam0g libaudit1 libcap-ng0 \
 && rm -rf /var/lib/apt/lists/*

# Binaries produced by `make full` land in ./build (BUILDDIR ?= build).
COPY build/teleport /usr/local/bin/teleport
COPY build/tctl     /usr/local/bin/tctl
COPY build/tsh      /usr/local/bin/tsh

# Cluster state — MUST be a mounted volume, never baked into the image.
VOLUME ["/var/lib/teleport"]

# We ship our own binary; disable the managed auto-update client.
ENV TELEPORT_TOOLS_VERSION=off

# Graceful drain of active sessions on stop.
# https://goteleport.com/docs/reference/signals/
STOPSIGNAL SIGQUIT

# 3080 web UI + proxy HTTPS (the GUI) | 3023 proxy SSH | 3024 reverse tunnel
# 3025 auth | 3022 node SSH (only if this container is also an SSH node)
EXPOSE 3080 3023 3024 3025 3022

ENTRYPOINT ["/usr/bin/dumb-init", "teleport", "start", "-c", "/etc/teleport/teleport.yaml"]

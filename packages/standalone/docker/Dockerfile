# MAMA OS image (v1 D1). Ubuntu 24.04 on amd64, the Linux MAMA is tested on; MAMA runs as the
# container's main process under a non-root user. Build context: this folder. A local package
# (mama-os.tgz in the context) replaces the npm release, for checks before a release.
FROM ubuntu:24.04

ARG MAMA_OS_VERSION=0.81.1
ARG NODE_VERSION=22.23.4
ARG NODE_SHA256=b8492284c76a54baf58d61668dd0e41ee0fc98adabf9503d30f05d08f55b4406
ARG CLAUDE_CODE_VERSION=2.1.325
ARG CODEX_VERSION=0.169.0
ARG GWS_VERSION=0.22.5

# bubblewrap and socat: Claude's shell sandbox. python3-venv, LibreOffice and the Noto CJK fonts:
# the document tools. git: the workspace boundary and the backends' own use.
RUN apt-get update \
 && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      ca-certificates curl git bubblewrap socat python3 python3-venv \
      libreoffice-writer libreoffice-calc libreoffice-impress fonts-noto-cjk \
 && rm -rf /var/lib/apt/lists/*

RUN curl -fsSLo /tmp/node.tar.gz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.gz" \
 && echo "${NODE_SHA256}  /tmp/node.tar.gz" | sha256sum -c - \
 && mkdir -p /opt/node && tar -xzf /tmp/node.tar.gz -C /opt/node --strip-components=1 \
 && rm /tmp/node.tar.gz
ENV PATH=/opt/mama/bin:/opt/node/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

RUN --mount=type=bind,target=/ctx \
    pkg="@jungjaehoon/mama-os@${MAMA_OS_VERSION}"; \
    if [ -f /ctx/mama-os.tgz ]; then pkg=/ctx/mama-os.tgz; fi; \
    npm install -g --prefix /opt/mama --no-fund --no-audit "$pkg" \
      "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
      "@googleworkspace/cli@${GWS_VERSION}" \
 && npm cache clean --force

# The MAMA home and the backends' sign-ins live in /home/mama, the member and tools roots in
# /var/lib/mama/mama: the two volumes. Named volumes copy these folders' owners and modes.
RUN useradd --create-home --uid 1000 --user-group mama 2>/dev/null \
      || { userdel --remove ubuntu && useradd --create-home --uid 1000 --user-group mama; } \
 && install -d -m 0755 /var/lib/mama \
 && install -d -o mama -g mama -m 0700 /var/lib/mama/mama /home/mama/.mama /setup
COPY --chmod=0755 container-start.sh /usr/local/bin/mama-container-start

USER mama
WORKDIR /home/mama
# MAMA_CONTAINER: Docker starts, stops and updates MAMA (no launchd or systemd).
# DISABLE_AUTOUPDATER: Claude Code lives in the read-only image; a new image updates it.
ENV MAMA_CONTAINER=1 DISABLE_AUTOUPDATER=1 HOME=/home/mama

HEALTHCHECK --interval=30s --timeout=20s --start-period=10m --retries=3 \
  CMD mama status --json | grep -q '"stage":"running"'
CMD ["mama-container-start"]

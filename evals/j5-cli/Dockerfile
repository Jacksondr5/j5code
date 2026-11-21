# The harness versions are pinned so a baseline and the run after a change use the same harness.
FROM node:26-trixie-slim

ARG CLAUDE_CODE_VERSION=2.1.326
ARG CODEX_VERSION=0.169.0

RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" "@openai/codex@${CODEX_VERSION}" \
  && npm cache clean --force

# The shell hook is managed policy, so Codex trusts it without an interactive review.
COPY codex-requirements.toml /etc/codex/requirements.toml
COPY codex-hook.mjs /etc/codex/hooks/eval-hook.mjs

# Cases use /home/user paths, so the agent's home and checkout live there. The host user's id
# lets the container write results into the checkout.
ARG UID=1000
RUN userdel -r node && useradd --create-home --home-dir /home/user --uid "${UID}" user
USER user
WORKDIR /home/user
# A new volume mounted here copies this folder's owner, so Codex can write its home.
RUN mkdir -p /home/user/.codex
ENV CODEX_HOME=/home/user/.codex \
  DISABLE_AUTOUPDATER=1 \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  NO_PROXY=127.0.0.1,localhost \
  no_proxy=127.0.0.1,localhost

FROM caddy:2.11.2-alpine@sha256:834468128c7696cec0ceea6172f7d692daf645ae51983ca76e39da54a97c570d AS caddy
FROM ghcr.io/dexidp/dex:v2.46.1@sha256:65b72ca0f4b0bf6d4ada84ec21da8851782563404ac7b8f926923d27ceced9ab

USER root
RUN apk add --no-cache python3 \
    && mkdir -p /data/caddy /config/caddy \
    && chown -R dex:dex /data /config
COPY --from=caddy /usr/bin/caddy /usr/bin/caddy
WORKDIR /opt/j5-connect
COPY Caddyfile dex.json connect.py ./
COPY connectors/ ./connectors/

ENV XDG_DATA_HOME=/data XDG_CONFIG_HOME=/config \
    DEX_SESSIONS_ENABLED=false DEX_EXPAND_ENV=false \
    DEX_CONTINUE_ON_CONNECTOR_FAILURE=false DEX_CONFIG_DISALLOW_UNKNOWN_FIELDS=true
USER dex:dex
ENTRYPOINT ["python3", "/opt/j5-connect/connect.py"]

FROM node:22-slim

# Install iptables (v4 + v6) for network isolation
RUN apt-get update && \
    apt-get install -y iptables iproute2 && \
    rm -rf /var/lib/apt/lists/*

# Install pi globally — pinned to tested version range
RUN npm install -g @earendil-works/pi-coding-agent@0.62

# Pre-warm: run pi --version so any first-run setup is cached in the image layer
RUN pi --version || true

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

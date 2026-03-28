FROM node:22-slim

# Install iptables (v4 + v6) for network isolation + ca-certificates for HTTPS intercept
RUN apt-get update && \
    apt-get install -y iptables ip6tables iproute2 ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# Install pi globally
RUN npm install -g @mariozechner/pi-coding-agent

# Pre-warm: run pi --version so any first-run setup is cached in the image layer
RUN pi --version || true

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENTRYPOINT ["docker-entrypoint.sh"]

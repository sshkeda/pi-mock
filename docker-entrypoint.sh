#!/bin/sh
set -e

# Setup network isolation: only allow traffic to the gateway
if [ -n "$GATEWAY_HOST" ]; then
  # Get IPv4 address specifically (getent may return IPv6 on Docker Desktop)
  GATEWAY_IP=$(getent ahostsv4 "$GATEWAY_HOST" 2>/dev/null | head -1 | awk '{print $1}')
  
  # Fallback: try hosts file directly
  if [ -z "$GATEWAY_IP" ]; then
    GATEWAY_IP=$(getent hosts "$GATEWAY_HOST" 2>/dev/null | awk '{print $1}' | grep -v ':' | head -1)
  fi

  if [ -n "$GATEWAY_IP" ]; then
    echo "[entrypoint] Setting up iptables. Gateway: $GATEWAY_HOST ($GATEWAY_IP)"

    # IPv4: drop everything except loopback + gateway
    iptables -P OUTPUT DROP
    iptables -A OUTPUT -o lo -j ACCEPT
    iptables -A OUTPUT -d $GATEWAY_IP -j ACCEPT
    iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

    # IPv6: block everything (prevent bypass)
    ip6tables -P OUTPUT DROP 2>/dev/null || true
    ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true

    echo "[entrypoint] iptables configured. Only gateway is reachable."
  else
    echo "[entrypoint] WARNING: Could not resolve IPv4 for $GATEWAY_HOST"
  fi
fi

exec "$@"

#!/bin/sh
set -e

# Setup network isolation: only allow traffic to the gateway PORT (not entire host)
if [ -n "$GATEWAY_HOST" ]; then
  GATEWAY_IP=$(getent ahostsv4 "$GATEWAY_HOST" 2>/dev/null | head -1 | awk '{print $1}')
  if [ -z "$GATEWAY_IP" ]; then
    GATEWAY_IP=$(getent hosts "$GATEWAY_HOST" 2>/dev/null | awk '{print $1}' | grep -v ':' | head -1)
  fi

  if [ -z "$GATEWAY_IP" ]; then
    echo "[entrypoint] FATAL: Could not resolve $GATEWAY_HOST — refusing to start without isolation" >&2
    exit 1
  fi

  if [ -z "$GATEWAY_PORT" ]; then
    echo "[entrypoint] FATAL: GATEWAY_PORT not set — refusing to start without isolation" >&2
    exit 1
  fi

  echo "[entrypoint] iptables: allow $GATEWAY_HOST ($GATEWAY_IP:$GATEWAY_PORT) only"

  iptables -P OUTPUT DROP
  iptables -A OUTPUT -o lo -j ACCEPT
  iptables -A OUTPUT -d $GATEWAY_IP -p tcp --dport $GATEWAY_PORT -j ACCEPT
  iptables -A OUTPUT -m state --state ESTABLISHED,RELATED -j ACCEPT

  ip6tables -P OUTPUT DROP 2>/dev/null || true
  ip6tables -A OUTPUT -o lo -j ACCEPT 2>/dev/null || true

  echo "[entrypoint] iptables configured."
fi

exec "$@"

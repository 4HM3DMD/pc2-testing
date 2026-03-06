#!/bin/bash
# PC2 IPFS Relay deployment script
# Usage: ./deploy.sh <supernode-ip> [ssh-user]
#
# Deploys the relay to a PC2 supernode and configures it as a systemd service.
# Prerequisites: ssh access, Node.js 18+ on the target.

set -euo pipefail

RELAY_IP="${1:?Usage: ./deploy.sh <supernode-ip> [ssh-user]}"
SSH_USER="${2:-root}"
REMOTE_DIR="/root/pc2/ipfs-relay"
SERVICE_NAME="pc2-ipfs-relay"

echo "==> Deploying PC2 IPFS Relay to ${SSH_USER}@${RELAY_IP}"

echo "==> Creating remote directory"
ssh "${SSH_USER}@${RELAY_IP}" "mkdir -p ${REMOTE_DIR}/data"

echo "==> Copying files"
scp package.json index.js "${SSH_USER}@${RELAY_IP}:${REMOTE_DIR}/"
scp pc2-ipfs-relay.service "${SSH_USER}@${RELAY_IP}:/etc/systemd/system/${SERVICE_NAME}.service"

echo "==> Installing dependencies"
ssh "${SSH_USER}@${RELAY_IP}" "cd ${REMOTE_DIR} && npm install --omit=dev"

echo "==> Configuring firewall"
ssh "${SSH_USER}@${RELAY_IP}" "ufw allow 4003/tcp comment 'PC2 IPFS Relay TCP' && ufw allow 4004/tcp comment 'PC2 IPFS Relay WS'"

echo "==> Enabling and starting service"
ssh "${SSH_USER}@${RELAY_IP}" "systemctl daemon-reload && systemctl enable ${SERVICE_NAME} && systemctl restart ${SERVICE_NAME}"

echo "==> Checking status"
ssh "${SSH_USER}@${RELAY_IP}" "sleep 3 && systemctl status ${SERVICE_NAME} --no-pager -l"

echo "==> Done. Check peer ID with: ssh ${SSH_USER}@${RELAY_IP} journalctl -u ${SERVICE_NAME} --no-pager | grep 'Peer ID'"

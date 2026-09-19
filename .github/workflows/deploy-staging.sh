#!/bin/bash
# Staging deploy — targets /home/ubuntu/datum-deploy/dashboard on the EC2 host.
#
# This is a self-contained deploy: it fetches + resets its own checkout, then
# rebuilds and restarts the staging stack under project name "dashboard-staging"
# with the docker-compose.staging*.override.yml identity layer, so it can never
# collide with the production stack's containers/network/ports.
set -e

echo "---- STAGING DEPLOY STARTED ----"

cd /home/ubuntu/datum-deploy/dashboard

echo "Pulling latest staging branch..."
GIT_SSH_COMMAND='ssh -i /home/ubuntu/.ssh/deploy_key -o IdentitiesOnly=yes' git fetch origin
GIT_SSH_COMMAND='ssh -i /home/ubuntu/.ssh/deploy_key -o IdentitiesOnly=yes' git reset --hard origin/staging

export COMPOSE_ENV_SUFFIX=staging

echo "Stopping containers..."
node scripts/compose-stack.js -p "dashboard-staging" down --remove-orphans

echo "Rebuilding containers..."
node scripts/compose-stack.js -p "dashboard-staging" build --no-cache

echo "Starting containers..."
node scripts/compose-stack.js -p "dashboard-staging" up -d

echo "Cleaning unused images..."
docker image prune -f

echo "---- STAGING DEPLOY COMPLETE ----"

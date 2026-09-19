#!/bin/bash
# Production deploy — targets /home/ubuntu/dashboard-main/dashboard on the EC2 host.
#
# This is a self-contained deploy: it fetches + resets its own checkout, then
# rebuilds and restarts the production stack under project name "dashboard-prod"
# using the base docker-compose.yml identity (container_name/network/ports as
# already live in production). Project name is kept unchanged from the legacy
# script to avoid orphaning the currently running production containers.
set -e

echo "---- PRODUCTION DEPLOY STARTED ----"

cd /home/ubuntu/dashboard-main/dashboard

echo "Pulling latest main branch..."
GIT_SSH_COMMAND='ssh -i /home/ubuntu/.ssh/deploy_key -o IdentitiesOnly=yes' git fetch origin
GIT_SSH_COMMAND='ssh -i /home/ubuntu/.ssh/deploy_key -o IdentitiesOnly=yes' git reset --hard origin/main

unset COMPOSE_ENV_SUFFIX

echo "Stopping containers..."
node scripts/compose-stack.js -p "dashboard-prod" down --remove-orphans

echo "Rebuilding containers..."
node scripts/compose-stack.js -p "dashboard-prod" build --no-cache

echo "Starting containers..."
node scripts/compose-stack.js -p "dashboard-prod" up -d

echo "Cleaning unused images..."
docker image prune -f

echo "---- PRODUCTION DEPLOY COMPLETE ----"

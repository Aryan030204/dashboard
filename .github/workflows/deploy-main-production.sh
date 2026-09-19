#!/bin/bash
# Entry point invoked over SSH by deploy-ec2-main.yml (push to `main`).
#
# This file exists so the target directory is pinned in one reviewable,
# version-controlled place instead of typed inline in the workflow YAML,
# mirroring deploy-main-staging.sh for the production side.
#
# deploy-ec2-main.yml should invoke this by absolute path:
#   bash /home/ubuntu/dashboard-main/dashboard/.github/workflows/deploy-main-production.sh
set -e

exec bash /home/ubuntu/dashboard-main/dashboard/.github/workflows/deploy-production.sh

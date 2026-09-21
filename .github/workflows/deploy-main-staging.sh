#!/bin/bash
# Entry point invoked over SSH by deploy-ec2-staging.yml (push to `staging`).
#
# This file exists so the target directory is pinned in one reviewable,
# version-controlled place instead of typed inline in the workflow YAML —
# that inline copy-paste is exactly how deploy-ec2-staging.yml previously
# ended up pointed at /home/ubuntu/dashboard-main/dashboard (the PRODUCTION
# checkout) and reset it to the staging branch on every staging push.
#
# deploy-ec2-staging.yml should invoke this by absolute path:
#   bash /home/ubuntu/datum-deploy/dashboard/.github/workflows/deploy-main-staging.sh
set -e

# exec bash /home/ubuntu/datum-deploy/dashboard/.github/workflows/deploy-staging.sh

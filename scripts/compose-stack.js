#!/usr/bin/env node

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT_DIR = path.resolve(__dirname, "..");
const ENV_PATH = path.join(ROOT_DIR, ".env");
const BASE_COMPOSE_FILE = "docker-compose.yml";
const HEALTH_MONITOR_COMPOSE_FILE = "docker-compose.health-monitor.yml";

const BASE_SERVICES = [
  "api-gateway",
  "auth-service",
  "tenant-router",
  "alerts-service",
  "merchant-requests-service",
  "daily-insights-service",
  "analytics-service",
  "sessions-service",
];

function parseDotEnv(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const content = fs.readFileSync(filePath, "utf8");
  const out = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;
    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }

  return out;
}

function isEnabled(value, fallback = true) {
  if (value == null || value === "") return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  return fallback;
}

function findComposeCommand(args) {
  const optionsWithValue = new Set([
    "-p",
    "--project-name",
    "-f",
    "--file",
    "--profile",
    "--env-file",
    "--project-directory",
  ]);

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("-")) return arg;

    if (optionsWithValue.has(arg)) {
      index += 1;
      continue;
    }

    if (arg.startsWith("--project-name=") ||
        arg.startsWith("--file=") ||
        arg.startsWith("--profile=") ||
        arg.startsWith("--env-file=") ||
        arg.startsWith("--project-directory=")) {
      continue;
    }
  }

  return null;
}

function buildServiceList(healthMonitorEnabled) {
  return healthMonitorEnabled
    ? ["health-monitor-service", ...BASE_SERVICES]
    : [...BASE_SERVICES];
}

function injectComposeFiles(args, healthMonitorEnabled) {
  const hasExplicitComposeFile = args.some(
    (arg) =>
      arg === "-f" ||
      arg === "--file" ||
      arg.startsWith("--file="),
  );

  if (hasExplicitComposeFile) return [...args];

  const files = ["-f", BASE_COMPOSE_FILE];
  if (healthMonitorEnabled) {
    files.push("-f", HEALTH_MONITOR_COMPOSE_FILE);
  }
  return [...files, ...args];
}

const envFile = parseDotEnv(ENV_PATH);
const healthMonitorEnabled = isEnabled(envFile.HEALTH_MONITOR, true);
const rawArgs = process.argv.slice(2);
const composeCommand = findComposeCommand(rawArgs);
const serviceScopedCommands = new Set(["build", "up", "start", "restart", "stop", "rm"]);

const finalArgs = injectComposeFiles(rawArgs, healthMonitorEnabled);
if (composeCommand && serviceScopedCommands.has(composeCommand)) {
  finalArgs.push(...buildServiceList(healthMonitorEnabled));
}

console.log(
  `[compose-stack] HEALTH_MONITOR=${healthMonitorEnabled ? "true" : "false"}${composeCommand && serviceScopedCommands.has(composeCommand) ? ` | services=${buildServiceList(healthMonitorEnabled).join(",")}` : ""}`,
);

const result = spawnSync("docker", ["compose", ...finalArgs], {
  cwd: ROOT_DIR,
  stdio: "inherit",
  shell: process.platform === "win32",
});

if (result.error) {
  console.error("[compose-stack] failed to execute docker compose", result.error);
  process.exit(1);
}

process.exit(result.status == null ? 1 : result.status);

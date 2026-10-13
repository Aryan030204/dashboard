const test = require("node:test");
const assert = require("node:assert/strict");

const { createDockerLogProvider } = require("../src/services/logProviders/dockerLogProvider");

function buildLogger() {
  return {
    info() {},
    warn() {},
    error() {},
  };
}

test("docker log provider returns recent lines from the resolved container", async () => {
  const provider = createDockerLogProvider({
    socketPath: "/var/run/docker.sock",
    timeoutMs: 10000,
    tail: 3,
    logger: buildLogger(),
    dockerClient: {
      async listContainersByService() {
        return [{ Id: "container-1" }];
      },
      async getContainerLogs() {
        return "line-1\nline-2\nline-3\n";
      },
    },
  });

  const result = await provider.getRecentLogs("alerts-service");
  assert.deepEqual(result.lines, ["line-1", "line-2", "line-3"]);
});

test("docker log provider surfaces timeouts cleanly", async () => {
  const provider = createDockerLogProvider({
    socketPath: "/var/run/docker.sock",
    timeoutMs: 5,
    tail: 3,
    logger: buildLogger(),
    dockerClient: {
      async listContainersByService() {
        return [{ Id: "container-1" }];
      },
      async getContainerLogs() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return "late";
      },
    },
  });

  await assert.rejects(() => provider.getRecentLogs("alerts-service"), /timed out/);
});

test("docker engine client filters by compose label by default and swarm label under a stack", () => {
  const { buildServiceLabelFilter } = require("../src/services/dockerEngineClient");
  assert.equal(buildServiceLabelFilter("alerts-service", ""), "com.docker.compose.service=alerts-service");
  assert.equal(
    buildServiceLabelFilter("alerts-service", "dash-v2"),
    "com.docker.swarm.service.name=dash-v2_alerts-service",
  );
});

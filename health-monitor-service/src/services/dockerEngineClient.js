const http = require("http");

function decodeDockerLogStream(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    return String(buffer || "");
  }

  let offset = 0;
  let decoded = "";

  while (offset + 8 <= buffer.length) {
    const payloadLength = buffer.readUInt32BE(offset + 4);
    const nextOffset = offset + 8 + payloadLength;
    if (nextOffset > buffer.length) {
      break;
    }
    decoded += buffer.slice(offset + 8, nextOffset).toString("utf8");
    offset = nextOffset;
  }

  if (!decoded) {
    return buffer.toString("utf8");
  }

  return decoded;
}

// Under Docker Swarm there are no compose labels; tasks carry
// com.docker.swarm.service.name=<stack>_<service> instead.
function buildServiceLabelFilter(serviceName, stackNamespace) {
  if (stackNamespace) {
    return `com.docker.swarm.service.name=${stackNamespace}_${serviceName}`;
  }
  return `com.docker.compose.service=${serviceName}`;
}

function createDockerEngineClient({
  socketPath,
  stackNamespace = process.env.DOCKER_STACK_NAMESPACE || "",
}) {
  function request(pathname) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          socketPath,
          path: pathname,
          method: "GET",
        },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            resolve({
              statusCode: res.statusCode || 500,
              body,
              text: body.toString("utf8"),
            });
          });
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  async function listContainersByService(serviceName) {
    const filters = encodeURIComponent(
      JSON.stringify({
        label: [buildServiceLabelFilter(serviceName, stackNamespace)],
      }),
    );
    const response = await request(`/containers/json?filters=${filters}`);
    if (response.statusCode >= 400) {
      throw new Error(`docker_list_failed:${response.statusCode}`);
    }
    return JSON.parse(response.text || "[]");
  }

  async function getContainerLogs(containerId, tail) {
    const response = await request(
      `/containers/${containerId}/logs?stdout=1&stderr=1&tail=${tail}&timestamps=0`,
    );
    if (response.statusCode >= 400) {
      throw new Error(`docker_logs_failed:${response.statusCode}`);
    }
    return decodeDockerLogStream(response.body);
  }

  return {
    listContainersByService,
    getContainerLogs,
    decodeDockerLogStream,
  };
}

module.exports = { createDockerEngineClient, decodeDockerLogStream, buildServiceLabelFilter };

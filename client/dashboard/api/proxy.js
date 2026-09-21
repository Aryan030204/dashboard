// Lightweight proxy so the upstream API base can be set via env (API_BASE_URL).
// Keeps Vercel rewrites dynamic without hardcoding the backend host.
export const config = {
  runtime: "nodejs",
};

const MAINTENANCE_MESSAGE = {
  title: "Hang Tight !",
  body: [
    "We're currently deploying an update to improve your experience.",
    "Datum will be available again shortly. Thank you for your patience.",
  ],
};

function acceptsHtml(req) {
  const accept = (req.headers.accept || "").toString().toLowerCase();
  return accept.includes("text/html");
}

function sendMaintenanceResponse(req, res, status = 502) {
  if (acceptsHtml(req)) {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.status(status).send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Datum Temporarily Unavailable</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #050505;
        --panel: rgba(22, 22, 22, 0.88);
        --panel-border: rgba(255, 255, 255, 0.1);
        --text: #f7f7f7;
        --muted: rgba(247, 247, 247, 0.76);
        --teal: #14c8b0;
        --teal-soft: rgba(20, 200, 176, 0.18);
      }
      body {
        margin: 0;
        min-height: 100vh;
        display: flex;
        justify-content: center;
        align-items: flex-start;
        padding: 56px 20px 24px;
        box-sizing: border-box;
        overflow: hidden;
        background:
          radial-gradient(circle at top left, rgba(20, 200, 176, 0.16), transparent 34%),
          radial-gradient(circle at bottom right, rgba(20, 200, 176, 0.1), transparent 28%),
          linear-gradient(180deg, #070707 0%, #030303 100%);
        color: var(--text);
        font-family: Inter, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body::before,
      body::after {
        content: "";
        position: fixed;
        inset: auto;
        border-radius: 999px;
        filter: blur(80px);
        opacity: 0.55;
        pointer-events: none;
        animation: drift 10s ease-in-out infinite alternate;
      }
      body::before {
        top: 8%;
        left: -8%;
        width: 280px;
        height: 280px;
        background: rgba(20, 200, 176, 0.2);
      }
      body::after {
        right: -6%;
        bottom: 10%;
        width: 240px;
        height: 240px;
        background: rgba(12, 126, 111, 0.22);
        animation-duration: 12s;
      }
      main {
        position: relative;
        width: min(620px, calc(100vw - 40px));
        padding: 36px 32px 34px;
        border: 1px solid var(--panel-border);
        border-radius: 24px;
        background: linear-gradient(
          180deg,
          rgba(28, 28, 28, 0.92) 0%,
          rgba(14, 14, 14, 0.9) 100%
        );
        box-shadow:
          0 28px 80px rgba(0, 0, 0, 0.48),
          inset 0 1px 0 rgba(255, 255, 255, 0.05);
        backdrop-filter: blur(18px);
      }
      .brand {
        display: flex;
        justify-content: center;
        margin-bottom: 28px;
      }
      .brand img {
        display: block;
        width: 164px;
        height: 70px;
        object-fit: cover;
        object-position: top center;
      }
      h1 {
        margin: 0 0 16px;
        font-size: clamp(34px, 6vw, 48px);
        line-height: 1.02;
        letter-spacing: -0.04em;
      }
      p {
        margin: 0 0 10px;
        max-width: 48ch;
        font-size: 16px;
        line-height: 1.65;
        color: var(--muted);
      }
      @keyframes drift {
        from {
          transform: translate3d(0, 0, 0);
        }
        to {
          transform: translate3d(26px, -18px, 0);
        }
      }
      @media (max-width: 640px) {
        body {
          padding-top: 32px;
        }
        main {
          padding: 30px 22px 26px;
          border-radius: 20px;
        }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <img src="/brand-logo-dark.png" alt="Datum" />
      </div>
      <h1>${MAINTENANCE_MESSAGE.title}</h1>
      <p>${MAINTENANCE_MESSAGE.body[0]}</p>
      <p>${MAINTENANCE_MESSAGE.body[1]}</p>
    </main>
  </body>
</html>`);
    return;
  }

  res.status(status).json({
    error: "service_temporarily_unavailable",
    title: MAINTENANCE_MESSAGE.title,
    message: MAINTENANCE_MESSAGE.body.join(" "),
  });
}

export default async function handler(req, res) {
  try {
    const rawTargetBase = (process.env.API_BASE_URL || "")
      .trim()
      .replace(/\/+$/, "");

    const { path, ...query } = req.query || {};
    const cleanedPath = path ? `/${path.replace(/^\/+/, "")}` : "";
    const isSocketIoPath = /(^|\/)socket\.io(\/|$)/i.test(cleanedPath);

    // Only normalize trailing /api for Socket.IO proxying.
    // This avoids changing behavior for regular REST endpoints.
    const targetBase = isSocketIoPath
      ? rawTargetBase.replace(/\/api$/i, "")
      : rawTargetBase;

    if (!targetBase) {
      res.status(500).json({ error: "API_BASE_URL not configured" });
      return;
    }

    const passthroughPrefixes = [
      "/auth",
      "/alerts",
      "/daily-insights",
      "/tenant",
      "/push",
      "/track",
      "/analytics",
      "/sessions",
      "/merchant-requests",
      "/health-monitor",
    ];


    const shouldPassthrough = passthroughPrefixes.some(
      (prefix) =>
        cleanedPath === prefix || cleanedPath.startsWith(`${prefix}/`),
    );
    const upstreamPath = shouldPassthrough
      ? cleanedPath
      : `/analytics${cleanedPath}`;
    const url = new URL(targetBase + upstreamPath);
    for (const [key, value] of Object.entries(query)) {
      if (Array.isArray(value)) {
        value.forEach((v) => url.searchParams.append(key, v));
      } else if (value !== undefined) {
        url.searchParams.append(key, value);
      }
    }

    const headers = { ...req.headers };
    delete headers.host;
    delete headers["content-length"];
    // Request upstream in identity encoding to avoid decode mismatches on the client.
    headers["accept-encoding"] = "identity";

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? Buffer.concat(chunks) : undefined;

    const upstreamRes = await fetch(url, {
      method: req.method,
      headers,
      redirect: "manual", // preserve upstream redirects; handle safely below
      body: body && ["GET", "HEAD"].includes(req.method) ? undefined : body,
    });

    if ([502, 503, 504].includes(upstreamRes.status)) {
      sendMaintenanceResponse(req, res, upstreamRes.status);
      return;
    }

    // If upstream wants to redirect (e.g., /auth/google 302), forward it as-is.
    if (upstreamRes.status >= 300 && upstreamRes.status < 400) {
      const location = upstreamRes.headers.get("location");
      if (location) {
        let rewrittenLocation = location;
        try {
          const targetUrl = new URL(targetBase);
          const locationUrl = new URL(location, targetBase);
          if (
            locationUrl.hostname === targetUrl.hostname &&
            locationUrl.protocol === "http:"
          ) {
            locationUrl.protocol = targetUrl.protocol;
            locationUrl.port = targetUrl.port;
            rewrittenLocation = locationUrl.toString();
          }
          // If the redirect stays on the same upstream host, follow it server-side to avoid CORS.
          if (locationUrl.hostname === targetUrl.hostname) {
            let followUrl = locationUrl;
            if (
              followUrl.pathname.startsWith("/alerts") &&
              followUrl.pathname.endsWith("/") &&
              followUrl.pathname !== "/"
            ) {
              followUrl = new URL(followUrl.toString());
              followUrl.pathname = followUrl.pathname.replace(/\/+$/, "");
            }
            let nextUrl = followUrl.toString();
            let followRes = await fetch(nextUrl, {
              method: req.method,
              headers,
              redirect: "manual",
              body:
                body && ["GET", "HEAD"].includes(req.method) ? undefined : body,
            });
            for (
              let i = 0;
              i < 3 && followRes.status >= 300 && followRes.status < 400;
              i += 1
            ) {
              const nextLocation = followRes.headers.get("location");
              if (!nextLocation) break;
              const nextLocationUrl = new URL(nextLocation, targetBase);
              if (nextLocationUrl.hostname !== targetUrl.hostname) break;
              if (nextLocationUrl.protocol === "http:") {
                nextLocationUrl.protocol = targetUrl.protocol;
                nextLocationUrl.port = targetUrl.port;
              }
              if (
                nextLocationUrl.pathname.startsWith("/alerts") &&
                nextLocationUrl.pathname.endsWith("/") &&
                nextLocationUrl.pathname !== "/"
              ) {
                nextLocationUrl.pathname = nextLocationUrl.pathname.replace(
                  /\/+$/,
                  "",
                );
              }
              nextUrl = nextLocationUrl.toString();
              followRes = await fetch(nextUrl, {
                method: req.method,
                headers,
                redirect: "manual",
                body:
                  body && ["GET", "HEAD"].includes(req.method)
                    ? undefined
                    : body,
              });
            }
            res.status(followRes.status);
            followRes.headers.forEach((value, key) => {
              const k = key.toLowerCase();
              if (k === "transfer-encoding") return;
              if (k === "content-encoding") return;
              if (k === "content-length") return;
              if (k === "set-cookie") return;
              res.setHeader(key, value);
            });
            const followCookies =
              typeof followRes.headers.getSetCookie === "function"
                ? followRes.headers.getSetCookie()
                : [];
            const followRawCookies =
              followRes.headers.raw?.()["set-cookie"] || [];
            const followSingleCookie = followRes.headers.get("set-cookie");
            const cookies =
              followCookies && followCookies.length
                ? followCookies
                : followRawCookies.length
                  ? followRawCookies
                  : followSingleCookie
                    ? [followSingleCookie]
                    : [];
            if (cookies.length) {
              const rewritten = cookies.map((c) =>
                c.replace(/;?\s*Domain=[^;]+/i, ""),
              );
              res.setHeader("Set-Cookie", rewritten);
            }
            const buf = Buffer.from(await followRes.arrayBuffer());
            res.send(buf);
            return;
          }
        } catch {
          // Fall back to the original Location header if parsing fails.
        }
        res.setHeader("Location", rewrittenLocation);
      }
      // Forward Set-Cookie on redirects so sessions stick after auth flows.
      const fromGet =
        typeof upstreamRes.headers.getSetCookie === "function"
          ? upstreamRes.headers.getSetCookie()
          : [];
      const rawSetCookies = upstreamRes.headers.raw?.()["set-cookie"] || [];
      const singleSetCookie = upstreamRes.headers.get("set-cookie");
      const cookies =
        fromGet && fromGet.length
          ? fromGet
          : rawSetCookies.length
            ? rawSetCookies
            : singleSetCookie
              ? [singleSetCookie]
              : [];
      if (cookies.length) {
        const rewritten = cookies.map((c) =>
          c.replace(/;?\s*Domain=[^;]+/i, ""),
        );
        res.setHeader("Set-Cookie", rewritten);
      }
      res.status(upstreamRes.status);
      res.end();
      return;
    }

    res.status(upstreamRes.status);
    upstreamRes.headers.forEach((value, key) => {
      const k = key.toLowerCase();
      if (k === "transfer-encoding") return;
      if (k === "content-encoding") return;
      if (k === "content-length") return;
      if (k === "set-cookie") return; // handled separately to adjust domain
      res.setHeader(key, value);
    });

    // Rewrite Set-Cookie to drop the upstream domain so the cookie sticks to the Vercel host.
    // Vercel/Node fetch exposes cookies via getSetCookie(); raw() is not guaranteed.
    const fromGet =
      typeof upstreamRes.headers.getSetCookie === "function"
        ? upstreamRes.headers.getSetCookie()
        : [];
    const rawSetCookies = upstreamRes.headers.raw?.()["set-cookie"] || [];
    const singleSetCookie = upstreamRes.headers.get("set-cookie");
    const cookies =
      fromGet && fromGet.length
        ? fromGet
        : rawSetCookies.length
          ? rawSetCookies
          : singleSetCookie
            ? [singleSetCookie]
            : [];
    if (cookies.length) {
      const rewritten = cookies.map((c) => c.replace(/;?\s*Domain=[^;]+/i, ""));
      res.setHeader("Set-Cookie", rewritten);
    }
    const buf = Buffer.from(await upstreamRes.arrayBuffer());
    res.send(buf);
  } catch (error) {
    console.error("API proxy failed", error);
    sendMaintenanceResponse(req, res, 502);
  }
}

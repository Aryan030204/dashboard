// Popup half of the "Connect with Google" flow on the P&L page.
//
// The main tab opens Google's OAuth dialog in a named popup. Google redirects
// the popup back to the P&L page URL with ?code=&state=; this module runs at
// app start (see main.jsx), notices it's in that popup, hands code/state to
// the main tab, and closes itself before the app even renders.
//
// The hand-off goes two ways at once because neither alone is reliable:
//   - window.opener.postMessage   fails when the browser severed the opener
//                                 (Cross-Origin-Opener-Policy on the way through Google)
//   - BroadcastChannel            same-origin, opener-independent; not in every old browser
// The main tab dedupes on `state`, so receiving both is harmless.

export const GOOGLE_OAUTH_POPUP_NAME = "google_ads_oauth_popup";
const CHANNEL_NAME = "google_ads_oauth";
const MESSAGE_TYPE = "google_ads_oauth_result";
const POPUP_FEATURES = "popup=yes,width=520,height=680,menubar=no,toolbar=no,location=yes,status=no";

function readOauthParams() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  const state = params.get("state");
  const error = params.get("error");
  if (!code && !error) return null;
  return { code, state, error };
}

// Call once, before rendering the app. Returns true when this window is the
// OAuth popup and the result has been relayed (the caller should not boot the
// app in that case, just show a "you can close this" note).
export function relayGoogleOauthResultIfPopup() {
  if (window.name !== GOOGLE_OAUTH_POPUP_NAME) return false;
  const result = readOauthParams();
  if (!result) return false;

  const message = { type: MESSAGE_TYPE, ...result };
  try {
    if (window.opener && !window.opener.closed) {
      window.opener.postMessage(message, window.location.origin);
    }
  } catch {
    // Opener severed; the channel below still delivers.
  }
  try {
    if (typeof BroadcastChannel !== "undefined") {
      const channel = new BroadcastChannel(CHANNEL_NAME);
      channel.postMessage(message);
      channel.close();
    }
  } catch {
    // Nothing else to do; the main tab will report the popup as closed.
  }

  // Never leave the one-time code sitting in a URL someone could copy.
  window.history.replaceState(null, "", window.location.pathname);
  window.close();
  return true;
}

// Opens Google's dialog in the named popup. Null when the browser blocked it,
// so the caller can fall back to a full-tab redirect.
export function openGoogleOauthPopup(url) {
  const left = Math.max(0, (window.screen.width - 520) / 2 + (window.screenX || 0));
  const top = Math.max(0, (window.screen.height - 680) / 2 + (window.screenY || 0));
  const popup = window.open(url, GOOGLE_OAUTH_POPUP_NAME, `${POPUP_FEATURES},left=${left},top=${top}`);
  if (!popup) return null;
  try {
    popup.focus();
  } catch {
    // Some browsers refuse focus() on popups; harmless.
  }
  return popup;
}

// Resolves with { code } when the popup reports back with a matching state,
// rejects when Google returned an error, the state doesn't match, or the user
// closed the popup without finishing.
export function waitForGoogleOauthResult({ popup, state, timeoutMs = 5 * 60 * 1000 }) {
  return new Promise((resolve, reject) => {
    let channel = null;
    let pollTimer = null;
    let timeoutTimer = null;
    let settled = false;

    const cleanup = () => {
      window.removeEventListener("message", onMessage);
      if (channel) channel.close();
      if (pollTimer) window.clearInterval(pollTimer);
      if (timeoutTimer) window.clearTimeout(timeoutTimer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const handleResult = (data) => {
      if (!data || data.type !== MESSAGE_TYPE) return;
      if (data.error) {
        finish(reject, new Error(data.error === "access_denied" ? "Google login was cancelled." : `Google returned: ${data.error}`));
        return;
      }
      if (!data.state || data.state !== state) {
        finish(reject, new Error("OAuth state mismatch — please start the Google connect again."));
        return;
      }
      if (!data.code) {
        finish(reject, new Error("Google did not return an authorization code."));
        return;
      }
      finish(resolve, { code: data.code });
    };
    const onMessage = (event) => {
      if (event.origin !== window.location.origin) return;
      handleResult(event.data);
    };

    window.addEventListener("message", onMessage);
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(CHANNEL_NAME);
      channel.onmessage = (event) => handleResult(event.data);
    }
    // Give a late-arriving message a beat after the popup closes itself.
    pollTimer = window.setInterval(() => {
      if (popup.closed) {
        window.setTimeout(() => finish(reject, new Error("The Google window was closed before finishing.")), 750);
        window.clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
    timeoutTimer = window.setTimeout(() => {
      try {
        popup.close();
      } catch {
        // Already gone.
      }
      finish(reject, new Error("Timed out waiting for Google."));
    }, timeoutMs);
  });
}

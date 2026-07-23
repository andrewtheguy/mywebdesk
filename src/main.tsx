import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { isWebGl2RendererSupported } from "./remoteDesktop/rendering/WebGl2FramebufferRenderer";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("Root element #root was not found");
}

if (
  !(
    window.crypto &&
    crypto.subtle &&
    typeof crypto.subtle.generateKey === "function"
  )
) {
  rootElement.innerHTML =
    '<p style="color:#ff6b6b;font-family:system-ui,sans-serif;text-align:center;padding:2rem">' +
    "This app requires the Web Crypto API (crypto.subtle).<br>" +
    "Use a modern browser over HTTPS or localhost.</p>";
  throw new Error("Web Crypto API unavailable");
}

if (!isWebGl2RendererSupported()) {
  rootElement.innerHTML =
    '<p style="color:#ff6b6b;font-family:system-ui,sans-serif;text-align:center;padding:2rem">' +
    "This app requires hardware-accelerated WebGL2.<br>" +
    "Enable WebGL2 and browser hardware acceleration, then reload.</p>";
  throw new Error("Required WebGL2 renderer unavailable");
}

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Register the network-only service worker so the app is installable as a PWA.
// It caches nothing, so registration never risks serving stale content.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Non-fatal: the app works fine without the service worker (no install).
    });
  });
}

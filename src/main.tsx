import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";

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

createRoot(rootElement).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

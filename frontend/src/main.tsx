import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

const FAVICON_HREF = "/favicon.svg?v=20260508-2";

const ensureFavicon = () => {
  const applyHref = (selector: string, rel: string) => {
    let link = document.head.querySelector<HTMLLinkElement>(selector);
    if (!link) {
      link = document.createElement("link");
      link.rel = rel;
      document.head.appendChild(link);
    }
    link.href = FAVICON_HREF;
    if (rel === "icon") {
      link.type = "image/svg+xml";
    }
  };

  document.querySelectorAll('link[href*="vite.svg"]').forEach((node) => node.remove());
  applyHref('link[rel="icon"]', "icon");
  applyHref('link[rel="shortcut icon"]', "shortcut icon");
  applyHref('link[rel="apple-touch-icon"]', "apple-touch-icon");
};

ensureFavicon();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);

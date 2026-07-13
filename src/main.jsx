import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";

const css = document.createElement("style");
css.textContent = `
  *{ -webkit-tap-highlight-color: transparent; }
  html,body,#root{ margin:0; min-height:100%; background:#F4F1E8; }
  body{ padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
`;
document.head.appendChild(css);

createRoot(document.getElementById("root")).render(<App />);

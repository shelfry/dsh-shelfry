import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import { applyLang } from "./lib/i18n";
import { applyTheme } from "./lib/theme";
import "./styles.css";

// 首屏的初始值由 index.html 的内联脚本先落一次，这里只负责和内存里的偏好对齐
applyTheme();
applyLang();

const el = document.getElementById("root");
if (!el) throw new Error("缺少 #root 容器");

createRoot(el).render(
  <StrictMode>
    <BrowserRouter>
      <App />
    </BrowserRouter>
  </StrictMode>,
);

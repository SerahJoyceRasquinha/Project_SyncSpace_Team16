import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App.jsx";
import "./assets/index.css";

// NOTE: No <React.StrictMode> on purpose. StrictMode double-mounts effects in
// dev, which would open/close two sockets and make debugging confusing.
ReactDOM.createRoot(document.getElementById("root")).render(
  <BrowserRouter>
    <App />
  </BrowserRouter>
);

import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route } from "react-router";
import App from "./app/App.tsx";
import RankPage from "./app/RankPage.tsx";
import "./styles/index.css";

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <Routes>
      <Route path="/"     element={<App />} />
      <Route path="/rank" element={<RankPage />} />
      <Route path="*"     element={<App />} />
    </Routes>
  </BrowserRouter>
);

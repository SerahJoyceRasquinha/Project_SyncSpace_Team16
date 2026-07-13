import { Routes, Route, Navigate } from "react-router-dom";
import Dashboard from "./pages/Dashboard.jsx";
import Workspace from "./pages/Workspace.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/room/:roomId" element={<Workspace />} />
      <Route path="*" element={<Navigate to="/" />} />
    </Routes>
  );
}

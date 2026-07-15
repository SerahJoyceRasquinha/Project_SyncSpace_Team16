import { Routes, Route, Navigate } from "react-router-dom";
import Landing from "./pages/Landing.jsx";
import CreateWorkspace from "./pages/CreateWorkspace.jsx";
import JoinWorkspace from "./pages/JoinWorkspace.jsx";
import WaitingRoom from "./pages/WaitingRoom.jsx";
import Workspace from "./pages/Workspace.jsx";

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/create" element={<CreateWorkspace />} />
      <Route path="/join" element={<JoinWorkspace />} />
      <Route path="/waiting/:workspaceId" element={<WaitingRoom />} />
      <Route path="/workspace/:workspaceId" element={<Workspace />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

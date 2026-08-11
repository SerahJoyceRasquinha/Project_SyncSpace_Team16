import { Routes, Route, Navigate } from "react-router";
import { ErrorBoundary } from "./components/ErrorBoundary.jsx";
import Landing from "./pages/Landing.jsx";
import CreateWorkspace from "./pages/CreateWorkspace.jsx";
import JoinWorkspace from "./pages/JoinWorkspace.jsx";
import WaitingRoom from "./pages/WaitingRoom.jsx";
import Workspace from "./pages/Workspace.jsx";
import AIPage from "./ai/AIPage.jsx";
import Auth from "./pages/Auth.jsx";
import Dashboard from "./pages/Dashboard.jsx";

export default function App() {
  return (
    <ErrorBoundary>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/create" element={<CreateWorkspace />} />
        <Route path="/join" element={<JoinWorkspace />} />
        <Route path="/waiting/:workspaceId" element={<WaitingRoom />} />
        <Route path="/workspace/:workspaceId" element={<Workspace />} />
        <Route path="/workspace/:workspaceId/ai" element={<AIPage />}/>
        <Route path="/login" element={<Auth mode="login" />} />
        <Route path="/signup" element={<Auth mode="signup" />} />
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </ErrorBoundary>
  );
}

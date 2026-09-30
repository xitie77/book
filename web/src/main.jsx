import React from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import "./index.css";

import { ThemeProvider, useTheme } from "./ThemeContext.jsx";
import { AuthProvider, useAuth } from "./AuthContext.jsx";
import Login from "./pages/Login.jsx";
import Shelf from "./pages/Shelf.jsx";
import Reader from "./pages/Reader.jsx";
import Settings from "./pages/Settings.jsx";
import Toast from "./components/Toast.jsx";

function Protected({ children }) {
  const { user, ready } = useAuth();
  const loc = useLocation();
  if (!ready) return <div className="spin" />;
  if (!user) return <Navigate to="/login" state={{ from: loc.pathname }} replace />;
  return children;
}

function Root() {
  const { ready } = useAuth();
  if (!ready) return <div className="spin" />;
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route
        path="/"
        element={
          <Protected>
            <Shelf />
          </Protected>
        }
      />
      <Route
        path="/book/:id"
        element={
          <Protected>
            <Reader />
          </Protected>
        }
      />
      <Route
        path="/settings"
        element={
          <Protected>
            <Settings />
          </Protected>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  const { theme } = useTheme();
  return (
    <BrowserRouter>
      <Toast />
      <Root />
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <ThemeProvider>
      <AuthProvider>
        <App />
      </AuthProvider>
    </ThemeProvider>
  </React.StrictMode>
);

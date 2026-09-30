import { createContext, useContext, useEffect, useState } from "react";
import { api } from "./api.js";

const AuthCtx = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    api
      .get("/api/auth/me")
      .then((d) => setUser(d.user))
      .catch(() => setUser(null))
      .finally(() => setReady(true));
  }, []);

  const login = async (username, password) => {
    const d = await api.post("/api/auth/login", { username, password });
    setUser(d.user);
    return d.user;
  };

  const logout = async () => {
    try {
      await api.post("/api/auth/logout", {});
    } catch {}
    setUser(null);
  };

  return (
    <AuthCtx.Provider value={{ user, ready, login, logout, setUser }}>{children}</AuthCtx.Provider>
  );
}

export const useAuth = () => useContext(AuthCtx);

import { useState } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import { useAuth } from "../AuthContext.jsx";

export default function Login() {
  const { login } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await login(username.trim(), password);
      nav(loc.state?.from || "/", { replace: true });
    } catch (e2) {
      setErr(e2.message || "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-wrap">
      <form className="card login-card" onSubmit={submit}>
        <h1>
          夜读 <span className="muted" style={{ fontSize: 14 }}>
            🌙
          </span>
        </h1>
        <div className="sub">你的私人书架</div>
        <input
          className="field"
          placeholder="账号"
          value={username}
          autoCapitalize="none"
          autoCorrect="off"
          onChange={(e) => setUsername(e.target.value)}
        />
        <input
          className="field"
          type="password"
          placeholder="密码"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {err && (
          <div style={{ color: "#c0392b", fontSize: 13, marginBottom: 12 }}>{err}</div>
        )}
        <button className="btn" style={{ width: "100%" }} disabled={busy || !username || !password}>
          {busy ? "登录中…" : "进入书架"}
        </button>
      </form>
    </div>
  );
}

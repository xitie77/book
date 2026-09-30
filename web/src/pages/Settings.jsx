import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../AuthContext.jsx";
import { useTheme } from "../ThemeContext.jsx";
import { toast } from "../components/Toast.jsx";

export default function Settings() {
  const { user, logout, setUser } = useAuth();
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const [name, setName] = useState(user?.displayName || "");
  const [oldPwd, setOldPwd] = useState("");
  const [newPwd, setNewPwd] = useState("");
  const [newPwd2, setNewPwd2] = useState("");
  const [busy, setBusy] = useState(false);

  const saveName = async () => {
    try {
      await api.patch("/api/auth/profile", { displayName: name });
      setUser({ ...user, displayName: name });
      toast("昵称已更新");
    } catch (e) {
      toast(e.message);
    }
  };

  const savePwd = async () => {
    if (newPwd.length < 6) return toast("新密码至少 6 位");
    if (newPwd !== newPwd2) return toast("两次输入不一致");
    setBusy(true);
    try {
      await api.patch("/api/auth/password", { oldPassword: oldPwd, newPassword: newPwd });
      toast("密码已修改");
      setOldPwd("");
      setNewPwd("");
      setNewPwd2("");
    } catch (e) {
      toast(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <button className="icon-btn" onClick={() => nav("/")}>
            ←
          </button>
          <div className="brand" style={{ fontSize: 16 }}>
            设置
          </div>
        </div>
      </header>

      <main className="container" style={{ paddingTop: 20, paddingBottom: 60 }}>
        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div className="row">
            <div>
              <div style={{ fontWeight: 700 }}>{user?.displayName || user?.username}</div>
              <div className="muted" style={{ fontSize: 13 }}>
                @{user?.username}
              </div>
            </div>
            <div className="spacer" />
            <button className="btn ghost" onClick={toggle}>
              {theme === "dark" ? "浅色模式" : "深色模式"}
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>昵称</div>
          <div className="row">
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} />
            <button className="btn" onClick={saveName} disabled={!name.trim()}>
              保存
            </button>
          </div>
        </div>

        <div className="card" style={{ padding: 18, marginBottom: 16 }}>
          <div style={{ fontWeight: 700, marginBottom: 12 }}>修改密码</div>
          <input
            className="field"
            type="password"
            placeholder="原密码"
            value={oldPwd}
            onChange={(e) => setOldPwd(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <input
            className="field"
            type="password"
            placeholder="新密码（至少 6 位）"
            value={newPwd}
            onChange={(e) => setNewPwd(e.target.value)}
            style={{ marginBottom: 10 }}
          />
          <input
            className="field"
            type="password"
            placeholder="再次输入新密码"
            value={newPwd2}
            onChange={(e) => setNewPwd2(e.target.value)}
            style={{ marginBottom: 12 }}
          />
          <button
            className="btn"
            onClick={savePwd}
            disabled={busy || !oldPwd || !newPwd || !newPwd2}
            style={{ width: "100%" }}
          >
            {busy ? "提交中…" : "修改密码"}
          </button>
          <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
            修改后其它设备会退出登录，当前设备保持在线。
          </div>
        </div>

        <button className="btn ghost" style={{ width: "100%" }} onClick={logout}>
          退出登录
        </button>
      </main>
    </>
  );
}

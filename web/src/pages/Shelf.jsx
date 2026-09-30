import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../api.js";
import { useAuth } from "../AuthContext.jsx";
import { useTheme } from "../ThemeContext.jsx";
import { toast } from "../components/Toast.jsx";

function fmtSize(n) {
  if (!n) return "0 字";
  if (n >= 10000) return (n / 10000).toFixed(1) + " 万字";
  return n + " 字";
}

export default function Shelf() {
  const { user, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const nav = useNavigate();
  const [books, setBooks] = useState(null);
  const [uploading, setUploading] = useState(false);
  const [pct, setPct] = useState(0);
  const [over, setOver] = useState(false);
  const [menu, setMenu] = useState(null); // 选中的书
  const [renaming, setRenaming] = useState(null);
  const [renameVal, setRenameVal] = useState("");
  const fileRef = useRef(null);

  const load = () => api.get("/api/books").then((d) => setBooks(d.books)).catch(() => setBooks([]));

  useEffect(() => {
    load();
  }, []);

  const doUpload = async (files) => {
    const file = files?.[0];
    if (!file) return;
    setUploading(true);
    setPct(0);
    const fd = new FormData();
    fd.append("file", file);
    try {
      await api.upload("/api/books", fd, setPct);
      toast("已加入书架");
      await load();
    } catch (e) {
      if (e.status === 409) toast("这本书已在书架里");
      else toast(e.message || "上传失败");
    } finally {
      setUploading(false);
      setPct(0);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const onDrop = (e) => {
    e.preventDefault();
    setOver(false);
    doUpload(e.dataTransfer.files);
  };

  const del = async (b) => {
    if (!confirm(`删除《${b.title}》？该操作不可恢复。`)) return;
    await api.del(`/api/books/${b.id}`);
    toast("已删除");
    setMenu(null);
    load();
  };

  const saveRename = async () => {
    await api.patch(`/api/books/${renaming.id}`, { title: renameVal });
    toast("已重命名");
    setRenaming(null);
    setMenu(null);
    load();
  };

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand">
            <span className="moon">🌙</span> 夜读
          </div>
          <div className="spacer" />
          <button className="icon-btn" title="换肤" onClick={toggle}>
            {theme === "dark" ? "☀️" : "🌙"}
          </button>
          <button className="icon-btn" title="设置" onClick={() => nav("/settings")}>
            ⚙️
          </button>
          <button className="icon-btn" title="退出" onClick={logout}>
            ⏏
          </button>
        </div>
      </header>

      <main className="container">
        <div
          className={"drop" + (over ? " over" : "")}
          style={{ marginTop: 20 }}
          onDragOver={(e) => {
            e.preventDefault();
            setOver(true);
          }}
          onDragLeave={() => setOver(false)}
          onDrop={onDrop}
          onClick={() => fileRef.current?.click()}
        >
          {uploading ? (
            <>
              <div className="spin" style={{ margin: "8px auto 12px" }} />
              上传中 {Math.round(pct * 100)}%
            </>
          ) : (
            <>
              <div style={{ fontSize: 30, marginBottom: 8 }}>📄</div>
              点这里选择 <b>txt / epub</b>，或把文件拖进来
            </>
          )}
          <input
            ref={fileRef}
            type="file"
            accept=".txt,.epub,text/plain,application/epub+zip"
            hidden
            onChange={(e) => doUpload(e.target.files)}
          />
        </div>

        {books === null ? (
          <div className="spin" />
        ) : books.length === 0 ? (
          <div className="empty">
            <div className="big">📚</div>
            书架还空着，先上传一本小说吧
          </div>
        ) : (
          <div className="shelf">
            {books.map((b) => (
              <div className="book" key={b.id} onClick={() => nav(`/book/${b.id}`)}>
                <div className="cover">
                  {b.hasCover ? (
                    <img src={`/api/books/${b.id}/cover`} alt="" loading="lazy" />
                  ) : (
                    <>
                      <div className="ctitle">{b.title}</div>
                      <div className="cauthor">{b.author || "佚名"}</div>
                    </>
                  )}
                  {b.reading && (
                    <div className="progress-flag">
                      读到 {b.reading.chapterIdx}/{b.chapterCount}
                    </div>
                  )}
                </div>
                <div className="bname">{b.title}</div>
                <div className="bmeta">
                  {b.chapterCount} 章 · {fmtSize(b.charCount)}
                </div>
                <button
                  className="icon-btn"
                  style={{
                    position: "absolute",
                    bottom: 34,
                    right: 6,
                    width: 30,
                    height: 30,
                    fontSize: 15,
                    background: "rgba(0,0,0,.35)",
                    color: "#fff",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    setMenu(b);
                  }}
                >
                  ⋯
                </button>
              </div>
            ))}
          </div>
        )}
      </main>

      {menu && (
        <>
          <div className="drawer-mask" onClick={() => setMenu(null)} />
          <div
            className="card"
            style={{
              position: "fixed",
              left: "50%",
              bottom: 0,
              transform: "translateX(-50%)",
              width: "100%",
              maxWidth: 420,
              zIndex: 60,
              borderRadius: "18px 18px 0 0",
              paddingBottom: "var(--safe-bottom)",
            }}
          >
            <div style={{ padding: "14px 16px", fontWeight: 700, borderBottom: "1px solid var(--border)" }}>
              {menu.title}
            </div>
            <button
              className="menu-item"
              onClick={() => {
                setRenaming(menu);
                setRenameVal(menu.title);
              }}
            >
              ✏️ 重命名
            </button>
            <button className="menu-item" style={{ color: "#c0392b" }} onClick={() => del(menu)}>
              🗑 删除
            </button>
            <button className="menu-item" onClick={() => setMenu(null)}>
              取消
            </button>
          </div>
        </>
      )}

      {renaming && (
        <>
          <div className="drawer-mask" onClick={() => setRenaming(null)} />
          <div
            className="card"
            style={{
              position: "fixed",
              left: "50%",
              top: "30%",
              transform: "translateX(-50%)",
              width: "88%",
              maxWidth: 380,
              zIndex: 60,
              padding: 18,
            }}
          >
            <div style={{ fontWeight: 700, marginBottom: 12 }}>重命名</div>
            <input
              className="field"
              value={renameVal}
              autoFocus
              onChange={(e) => setRenameVal(e.target.value)}
            />
            <div className="row" style={{ marginTop: 14, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setRenaming(null)}>
                取消
              </button>
              <button className="btn" onClick={saveRename} disabled={!renameVal.trim()}>
                保存
              </button>
            </div>
          </div>
        </>
      )}
    </>
  );
}

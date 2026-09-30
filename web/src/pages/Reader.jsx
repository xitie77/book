import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { api } from "../api.js";
import { toast } from "../components/Toast.jsx";
import ListeningPanel from "../components/ListeningPanel.jsx";
import { usePlayer } from "../usePlayer.js";

const READER_THEMES = {
  paper: { bg: "#f7f3e9", text: "#333029" },
  sepia: { bg: "#e9dcc0", text: "#4a3f2c" },
  green: { bg: "#d8e3d2", text: "#2f3a2c" },
  night: { bg: "#14161c", text: "#c6cad4" },
};

function loadPref() {
  try {
    return JSON.parse(localStorage.getItem("book-reader-pref")) || {};
  } catch {
    return {};
  }
}

export default function Reader() {
  const { id } = useParams();
  const nav = useNavigate();
  const [book, setBook] = useState(null);
  const [chapters, setChapters] = useState([]);
  const [chapter, setChapter] = useState(null);
  const [prevIdx, setPrevIdx] = useState(null);
  const [nextIdx, setNextIdx] = useState(null);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [showTools, setShowTools] = useState(false);
  const [showToc, setShowToc] = useState(false);

  const pref = loadPref();
  const [theme, setTheme] = useState(pref.theme || "paper");
  const [fontSize, setFontSize] = useState(pref.fontSize || 19);
  const [leading, setLeading] = useState(pref.leading || 1.9);

  /* 听书 */
  const [voice, setVoice] = useState(pref.voice || "zh-CN-XiaoxiaoNeural");
  const [rate, setRate] = useState(pref.rate ?? 0);
  const [showPlayer, setShowPlayer] = useState(false);
  const [listenMeta, setListenMeta] = useState(null);
  const ttsRef = useRef(null);        // 上次收听位置（来自接口）
  const startedRef = useRef(false);   // 本次阅读是否已启动听书
  const curChapterRef = useRef(null); // 当前正文章号

  const scrollRef = useRef(0);
  const restoreRef = useRef(null); // 待恢复的滚动比例
  const cache = useRef(new Map()); // idx -> chapter 数据
  const saveTimer = useRef(null);

  /* 保存偏好 */
  useEffect(() => {
    localStorage.setItem(
      "book-reader-pref",
      JSON.stringify({ theme, fontSize, leading, voice, rate })
    );
  }, [theme, fontSize, leading, voice, rate]);

  /* 初始加载：书信息 + 目录 + 进度 */
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await api.get(`/api/books/${id}`);
        if (!alive) return;
        setBook(d.book);
        setChapters(d.chapters);
        setTotal(d.chapters.length);
        const startIdx = d.progress?.chapterIdx || d.chapters[0]?.idx || 1;
        restoreRef.current = d.progress?.chapterIdx === startIdx ? d.progress.scrollPct : 0;
        ttsRef.current = d.ttsProgress || null;
        await openChapter(startIdx, false);
      } catch (e) {
        toast(e.message || "加载失败");
        nav("/", { replace: true });
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  const openChapter = useCallback(
    async (idx, scrollTop = true) => {
      setLoading(true);
      try {
        let data = cache.current.get(idx);
        if (!data) {
          data = await api.get(`/api/books/${id}/chapters/${idx}`);
          cache.current.set(idx, data);
        }
        setChapter(data.chapter);
        curChapterRef.current = data.chapter.idx;
        setPrevIdx(data.prevIdx);
        setNextIdx(data.nextIdx);
        setTotal(data.total);
        setLoading(false);
        requestAnimationFrame(() => {
          if (scrollTop) window.scrollTo(0, 0);
          else if (restoreRef.current != null) {
            const pct = restoreRef.current;
            restoreRef.current = null;
            const max = document.body.scrollHeight - window.innerHeight;
            window.scrollTo(0, max * pct);
          }
        });
        // 预取下一章，翻页更顺
        if (data.nextIdx) {
          api
            .get(`/api/books/${id}/chapters/${data.nextIdx}`)
            .then((nd) => cache.current.set(data.nextIdx, nd))
            .catch(() => {});
        }
      } catch (e) {
        setLoading(false);
        toast(e.message || "章节加载失败");
      }
    },
    [id]
  );

  /* ---------- 听书播放器 ---------- */
  const player = usePlayer({
    bookId: id,
    voice,
    rate,
    onPos: ({ chapterIdx, segIdx }) => {
      api.put(`/api/books/${id}/tts-progress`, { chapterIdx, segIdx }).catch(() => {});
    },
    onError: (m) => toast(m),
    onChapter: ({ chapterIdx, title }) => {
      setListenMeta({ title, chapterIdx });
      // 朗读推进到新章节时，正文跟着翻过去
      if (curChapterRef.current != null && curChapterRef.current !== chapterIdx) {
        openChapter(chapterIdx, true);
      }
    },
  });

  /* 点听力图标：首次启动播放；之后仅开合面板 */
  const onListenClick = () => {
    setShowTools(false);
    setShowToc(false);
    if (!startedRef.current) {
      startedRef.current = true;
      player.prime();
      const startCh = ttsRef.current?.chapterIdx || chapter?.idx || 1;
      const startSeg = ttsRef.current?.segIdx || 0;
      player.playAt(startCh, startSeg);
    }
    setShowPlayer((v) => !v);
  };

  /* 滚动保存进度（节流） */
  useEffect(() => {
    if (!chapter) return;
    const onScroll = () => {
      const max = document.body.scrollHeight - window.innerHeight;
      scrollRef.current = max > 0 ? window.scrollY / max : 0;
      if (saveTimer.current) return;
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        api
          .put(`/api/books/${id}/progress`, {
            chapterIdx: chapter.idx,
            scrollPct: Number(scrollRef.current.toFixed(4)),
          })
          .catch(() => {});
      }, 1500);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        api
          .put(`/api/books/${id}/progress`, {
            chapterIdx: chapter.idx,
            scrollPct: Number(scrollRef.current.toFixed(4)),
          })
          .catch(() => {});
      }
    };
  }, [chapter, id]);

  /* 键盘翻页 */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") nextIdx && go(nextIdx);
      if (e.key === "ArrowLeft" || e.key === "PageUp") prevIdx && go(prevIdx);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prevIdx, nextIdx]);

  /* 滑动翻页 */
  const touch = useRef({ x: 0, y: 0, t: 0 });
  const onTouchStart = (e) => {
    const t = e.changedTouches[0];
    touch.current = { x: t.clientX, y: t.clientY, t: Date.now() };
  };
  const onTouchEnd = (e) => {
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.current.x;
    const dy = t.clientY - touch.current.y;
    const dt = Date.now() - touch.current.t;
    if (Math.abs(dx) > 70 && Math.abs(dx) > Math.abs(dy) * 1.6 && dt < 600) {
      if (dx < 0 && nextIdx) go(nextIdx);
      else if (dx > 0 && prevIdx) go(prevIdx);
    }
  };

  const go = (idx) => {
    setShowTools(false);
    openChapter(idx, true);
  };

  const addBookmark = async () => {
    try {
      await api.post(`/api/books/${id}/bookmarks`, {
        chapterIdx: chapter.idx,
        scrollPct: Number(scrollRef.current.toFixed(4)),
        snippet: (chapter.content || "").slice(0, 60),
      });
      toast("已加书签");
    } catch {
      toast("书签失败");
    }
  };

  const paragraphs = (chapter?.content || "")
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const th = READER_THEMES[theme];

  return (
    <div className="reader" style={{ "--reader-bg": th.bg, "--reader-text": th.text }}>
      {/* 顶栏 */}
      <div className={"reader-head" + (showTools ? " show" : "")}>
        <div className="reader-head-inner">
          <button className="icon-btn" onClick={() => nav("/")}>
            ←
          </button>
          <div className="ct">{book?.title}</div>
          <div className="spacer" />
          <div className="reader-head-actions">
            <button
              className={"icon-btn" + (showPlayer ? " on" : "")}
              onClick={onListenClick}
              title="听书"
            >
              🎧
            </button>
            <button className="icon-btn" onClick={addBookmark} title="加书签">
              🔖
            </button>
          </div>
        </div>
      </div>

      {/* 正文 */}
      <div
        className="reader-body"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
        onClick={(e) => {
          // 点正文中部切换工具栏，点链接/按钮不触发
          if (e.target.closest("a,button")) return;
          setShowTools((v) => !v);
          setShowToc(false);
        }}
      >
        {loading && !chapter ? (
          <div className="spin" />
        ) : (
          <>
            <h1 className="chapter-title">{chapter?.title}</h1>
            <div
              className="chapter-text"
              style={{ "--read-size": fontSize + "px", "--read-leading": leading }}
            >
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </>
        )}

        <div className="reader-foot">
          <button className="btn ghost" disabled={!prevIdx} onClick={() => prevIdx && go(prevIdx)}>
            上一章
          </button>
          <button className="btn" disabled={!nextIdx} onClick={() => nextIdx && go(nextIdx)}>
            下一章
          </button>
        </div>
      </div>

      {/* 底部工具条 */}
      <div className={"reader-tools" + (showTools ? " show" : "")}>
        <button className="btn" style={{ width: "100%", marginBottom: 14 }} onClick={onListenClick}>
          🎧 听这本书
        </button>
        <div className="tool-themes">
          {Object.entries(READER_THEMES).map(([k, v]) => (
            <button
              key={k}
              className={"theme-dot" + (theme === k ? " active" : "")}
              style={{ background: v.bg, borderColor: theme === k ? "var(--accent)" : v.text }}
              onClick={() => setTheme(k)}
              title={k}
            />
          ))}
          <div className="spacer" />
          <span className="muted" style={{ fontSize: 13 }}>
            {chapter?.idx}/{total}
          </span>
        </div>

        <div className="tool-row">
          <label>字号</label>
          <input
            type="range"
            min="15"
            max="30"
            step="1"
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
          />
        </div>
        <div className="tool-row">
          <label>行距</label>
          <input
            type="range"
            min="1.4"
            max="2.6"
            step="0.1"
            value={leading}
            onChange={(e) => setLeading(Number(e.target.value))}
          />
        </div>

        <div className="chapter-nav">
          <button className="btn ghost" onClick={() => setShowToc(true)}>
            目录
          </button>
          <button className="btn ghost" disabled={!prevIdx} onClick={() => prevIdx && go(prevIdx)}>
            上一章
          </button>
          <button className="btn" disabled={!nextIdx} onClick={() => nextIdx && go(nextIdx)}>
            下一章
          </button>
        </div>
      </div>

      {/* 目录抽屉 */}
      {showToc && (
        <>
          <div className="drawer-mask" onClick={() => setShowToc(false)} />
          <div className="drawer">
            <div className="drawer-head">
              <span className="spacer" />
              目录（{total}）
              <span className="spacer" />
              <button className="icon-btn" onClick={() => setShowToc(false)}>
                ✕
              </button>
            </div>
            <div className="drawer-list">
              {chapters.map((c) => (
                <div
                  key={c.idx}
                  className={"drawer-item" + (c.idx === chapter?.idx ? " active" : "")}
                  onClick={() => {
                    setShowToc(false);
                    if (c.idx !== chapter?.idx) go(c.idx);
                  }}
                >
                  <span className="n">{String(c.idx).padStart(3, "0")}</span>
                  <span>{c.title}</span>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {/* 听书面板 */}
      <ListeningPanel
        player={player}
        voice={voice}
        setVoice={setVoice}
        rate={rate}
        setRate={setRate}
        meta={listenMeta}
        open={showPlayer}
        onClose={() => setShowPlayer(false)}
      />
    </div>
  );
}

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

const PAGE_GAP = 40; // 翻页模式下两栏之间的间距（px）

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
  const [mode, setMode] = useState(pref.mode || "paged"); // paged | scroll
  const [page, setPageState] = useState(0);
  const [pages, setPages] = useState(1);

  /* 听书 */
  const [voice, setVoice] = useState(pref.voice || "zh-CN-XiaoxiaoNeural");
  const [rate, setRate] = useState(pref.rate ?? 0);
  const [pitch, setPitch] = useState(pref.pitch ?? 0);
  const [showPlayer, setShowPlayer] = useState(false);
  const [listenMeta, setListenMeta] = useState(null);
  const ttsRef = useRef(null);        // 上次收听位置（来自接口）
  const startedRef = useRef(false);   // 本次阅读是否已启动听书
  const curChapterRef = useRef(null); // 当前正文章号
  const chapterIdxRef = useRef(1);    // 当前章号（供翻页进度回传用）

  const scrollRef = useRef(0);
  const restoreRef = useRef(null); // 待恢复的「章节内进度比例」(0~1)，翻页/滚动共用
  const cache = useRef(new Map()); // idx -> chapter 数据
  const saveTimer = useRef(null);

  const pageRef = useRef(0);
  const pagesRef = useRef(1);
  const pagedViewportRef = useRef(null);
  const pagedTrackRef = useRef(null);
  const measuredRef = useRef({ step: 0 });
  const pendingPageRef = useRef(undefined); // number | "end" | "restore"
  const justLeftPagedRef = useRef(false);

  /* 保存偏好 */
  useEffect(() => {
    localStorage.setItem(
      "book-reader-pref",
      JSON.stringify({ theme, fontSize, leading, voice, rate, pitch, mode })
    );
  }, [theme, fontSize, leading, voice, rate, pitch, mode]);

  /* ---------- 翻页：测量与定位 ---------- */
  const measurePaged = useCallback(() => {
    const vp = pagedViewportRef.current;
    const track = pagedTrackRef.current;
    if (!vp || !track) return;
    const cs = getComputedStyle(vp);
    const W = vp.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const H = vp.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
    if (W <= 0 || H <= 0) return;

    track.classList.add("no-anim");
    track.style.width = W + "px";
    track.style.columnWidth = W + "px";
    track.style.height = H + "px";
    void track.offsetHeight; // 强制完成分栏
    const totalW = track.scrollWidth;
    const newPages = Math.max(1, Math.round((totalW + PAGE_GAP) / (W + PAGE_GAP)));
    const step = W + PAGE_GAP;
    measuredRef.current = { step };
    pagesRef.current = newPages;
    setPages(newPages);

    const pend = pendingPageRef.current;
    pendingPageRef.current = undefined;
    let target;
    if (pend === "end") target = newPages - 1;
    else if (pend === "restore") {
      const pct = restoreRef.current ?? 0;
      restoreRef.current = null;
      target = Math.round(pct * (newPages - 1));
    } else if (typeof pend === "number") target = pend;
    else target = pageRef.current;

    target = Math.max(0, Math.min(newPages - 1, target));
    pageRef.current = target;
    setPageState(target);
    track.style.transform = `translateX(${-target * step}px)`;
    requestAnimationFrame(() =>
      requestAnimationFrame(() => track.classList.remove("no-anim"))
    );
  }, []);

  const saveChapterProgress = useCallback(
    (pct) => {
      const cidx = chapterIdxRef.current;
      if (!cidx) return;
      api
        .put(`/api/books/${id}/progress`, {
          chapterIdx: cidx,
          scrollPct: Number((pct || 0).toFixed(4)),
        })
        .catch(() => {});
    },
    [id]
  );

  const setPage = useCallback(
    (p) => {
      const track = pagedTrackRef.current;
      const { step } = measuredRef.current;
      const n = pagesRef.current;
      if (!track || !step) return;
      const clamped = Math.max(0, Math.min(n - 1, p));
      pageRef.current = clamped;
      setPageState(clamped);
      track.style.transform = `translateX(${-clamped * step}px)`;
      saveChapterProgress(n > 1 ? clamped / (n - 1) : 0);
    },
    [saveChapterProgress]
  );

  const openChapter = useCallback(
    async (idx, opts = {}) => {
      setLoading(true);
      try {
        let data = cache.current.get(idx);
        if (!data) {
          data = await api.get(`/api/books/${id}/chapters/${idx}`);
          cache.current.set(idx, data);
        }
        setChapter(data.chapter);
        curChapterRef.current = data.chapter.idx;
        chapterIdxRef.current = data.chapter.idx;
        setPrevIdx(data.prevIdx);
        setNextIdx(data.nextIdx);
        setTotal(data.total);
        setLoading(false);

        if (mode === "paged") {
          if (opts.toEnd) pendingPageRef.current = "end";
          else if (opts.page != null) pendingPageRef.current = opts.page;
          else if (restoreRef.current != null) pendingPageRef.current = "restore";
          else pendingPageRef.current = 0;
        } else {
          requestAnimationFrame(() => {
            if (opts.scrollTop) window.scrollTo(0, 0);
            else if (restoreRef.current != null) {
              const pct = restoreRef.current;
              restoreRef.current = null;
              const max = document.body.scrollHeight - window.innerHeight;
              window.scrollTo(0, max * pct);
            }
          });
        }

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
    [id, mode]
  );

  const go = useCallback(
    (idx, opts = {}) => {
      setShowTools(false);
      setShowToc(false);
      openChapter(idx, { page: 0, scrollTop: true, ...opts });
    },
    [openChapter]
  );

  const goNextPage = useCallback(() => {
    if (pageRef.current < pagesRef.current - 1) return setPage(pageRef.current + 1);
    if (nextIdx != null) openChapter(nextIdx, { page: 0 });
  }, [setPage, nextIdx, openChapter]);

  const goPrevPage = useCallback(() => {
    if (pageRef.current > 0) return setPage(pageRef.current - 1);
    if (prevIdx != null) openChapter(prevIdx, { toEnd: true });
  }, [setPage, prevIdx, openChapter]);

  /* ---------- 听书播放器 ---------- */
  const player = usePlayer({
    bookId: id,
    voice,
    rate,
    pitch,
    onPos: ({ chapterIdx, segIdx }) => {
      api.put(`/api/books/${id}/tts-progress`, { chapterIdx, segIdx }).catch(() => {});
    },
    onError: (m) => toast(m),
    onChapter: ({ chapterIdx, title }) => {
      setListenMeta({ title, chapterIdx });
      // 朗读推进到新章节时，正文跟着翻过去
      if (curChapterRef.current != null && curChapterRef.current !== chapterIdx) {
        openChapter(chapterIdx, { page: 0, scrollTop: true });
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

  /* ---------- 初始加载 ---------- */
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
        restoreRef.current = d.progress?.chapterIdx === startIdx ? d.progress.scrollPct || 0 : 0;
        ttsRef.current = d.ttsProgress || null;
        await openChapter(startIdx, {});
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

  /* 章节 / 字号 / 行距 / 模式 变化时（重新）分页 */
  useEffect(() => {
    if (mode !== "paged" || !chapter) return;
    const raf = requestAnimationFrame(() => measurePaged());
    return () => cancelAnimationFrame(raf);
  }, [chapter, mode, fontSize, leading, measurePaged]);

  /* 转屏 / 缩放 / 字体加载完成 → 重分页 */
  useEffect(() => {
    if (mode !== "paged") return;
    const onResize = () => measurePaged();
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    if (document.fonts?.ready?.then) {
      document.fonts.ready.then(() => measurePaged()).catch(() => {});
    }
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, [mode, measurePaged]);

  /* 从翻页切回滚动时，把滚动位置定位到当前页比例 */
  useEffect(() => {
    if (mode === "scroll" && chapter && justLeftPagedRef.current) {
      justLeftPagedRef.current = false;
      const frac = pages > 1 ? page / (pages - 1) : 0;
      requestAnimationFrame(() => {
        const max = document.body.scrollHeight - window.innerHeight;
        window.scrollTo(0, frac * max);
      });
    }
  }, [mode, chapter, page, pages]);

  /* 滚动模式：保存进度（节流） */
  useEffect(() => {
    if (mode !== "scroll" || !chapter) return;
    const onScroll = () => {
      const max = document.body.scrollHeight - window.innerHeight;
      scrollRef.current = max > 0 ? window.scrollY / max : 0;
      if (saveTimer.current) return;
      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        saveChapterProgress(scrollRef.current);
      }, 1500);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (saveTimer.current) {
        clearTimeout(saveTimer.current);
        saveTimer.current = null;
        saveChapterProgress(scrollRef.current);
      }
    };
  }, [mode, chapter, id, saveChapterProgress]);

  /* 键盘翻页 */
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
        e.preventDefault();
        if (mode === "paged") goNextPage();
        else if (nextIdx) go(nextIdx);
      } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
        e.preventDefault();
        if (mode === "paged") goPrevPage();
        else if (prevIdx) go(prevIdx);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [mode, prevIdx, nextIdx, goNextPage, goPrevPage, go]);

  /* 滑动翻页 / 切章 */
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
      if (mode === "paged") {
        if (dx < 0) goNextPage();
        else goPrevPage();
      } else {
        if (dx < 0 && nextIdx) go(nextIdx);
        else if (dx > 0 && prevIdx) go(prevIdx);
      }
    }
  };

  const tripleRef = useRef({ times: [] });

  const doReparse = useCallback(async () => {
    try {
      toast("正在重新解析…");
      await api.reparse(`/api/books/${id}`);
      cache.current.clear();
      await openChapter(chapterIdxRef.current, { page: 0, scrollTop: true });
      toast("已修复，重新解析完成");
    } catch (e) {
      toast(e.message || "重新解析失败");
    }
  }, [id, openChapter]);

  /* 三连点/三连击 = 重新解析（修复乱码）；单点仍走原逻辑 */
  const trackTriple = (single) => (e) => {
    if (e.target.closest("a,button")) return;
    const now = Date.now();
    const times = tripleRef.current.times;
    times.push(now);
    if (times.length > 3) times.shift();
    if (times.length === 3 && now - times[0] < 650) {
      times.length = 0;
      doReparse();
      return;
    }
    single(e);
  };

  const onPagedClick = trackTriple((e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const w = rect.width;
    if (x < w * 0.3) goPrevPage();
    else if (x > w * 0.7) goNextPage();
    else {
      setShowTools((v) => !v);
      setShowToc(false);
    }
  });

  const onScrollClick = trackTriple(() => {
    setShowTools((v) => !v);
    setShowToc(false);
  });

  const setModeAndApply = (m) => {
    if (m === mode) return;
    if (m === "paged") {
      restoreRef.current = scrollRef.current || 0;
      pendingPageRef.current = "restore";
      setMode("paged");
    } else {
      justLeftPagedRef.current = true;
      setMode("scroll");
    }
  };

  const addBookmark = async () => {
    try {
      const frac =
        mode === "paged"
          ? pages > 1
            ? page / (pages - 1)
            : 0
          : scrollRef.current || 0;
      await api.post(`/api/books/${id}/bookmarks`, {
        chapterIdx: chapter.idx,
        scrollPct: Number(frac.toFixed(4)),
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

      {/* 正文：翻页模式 */}
      {mode === "paged" ? (
        <div
          className="paged-viewport"
          ref={pagedViewportRef}
          onClick={onPagedClick}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {loading && !chapter ? (
            <div className="spin" />
          ) : (
            <div className="paged-track" ref={pagedTrackRef}>
              <h1 className="chapter-title">{chapter?.title}</h1>
              {paragraphs.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          )}
          <div className="paged-indicator">
            {page + 1} / {pages}
          </div>
        </div>
      ) : (
        /* 正文：滚动模式 */
        <div
          className="reader-body"
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onClick={onScrollClick}
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
      )}

      {/* 底部工具条 */}
      <div className={"reader-tools" + (showTools ? " show" : "")}>
        <div className="seg" style={{ marginBottom: 14 }}>
          <button className={mode === "paged" ? "on" : ""} onClick={() => setModeAndApply("paged")}>
            📖 翻页
          </button>
          <button className={mode === "scroll" ? "on" : ""} onClick={() => setModeAndApply("scroll")}>
            📜 滚动
          </button>
        </div>
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

        <button className="btn ghost" style={{ width: "100%", marginTop: 10 }} onClick={doReparse}>
          🔄 重新解析（修复乱码）
        </button>
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
        pitch={pitch}
        setPitch={setPitch}
        meta={listenMeta}
        open={showPlayer}
        onClose={() => setShowPlayer(false)}
      />
    </div>
  );
}

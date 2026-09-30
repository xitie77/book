/**
 * 听书播放器：按「章节 + 片段」顺序请求后端合成好的 MP3，逐段播放，
 * 自动连播下一段/下一章；带预取、进度回传、锁屏媒体控制。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function usePlayer({ bookId, voice, rate, pitch, onPos, onError, onChapter }) {
  const audioRef = useRef(null);
  const [playing, setPlaying] = useState(false);
  const [loading, setLoading] = useState(false);
  const [segCount, setSegCount] = useState(0);
  const [pos, setPos] = useState({ chapterIdx: 1, segIdx: 0 });
  const primedRef = useRef(false);

  const posRef = useRef({ chapterIdx: 1, segIdx: 0 });
  const metaCache = useRef(new Map()); // chapterIdx -> { segCount, nextIdx, prevIdx, title }
  const tokenRef = useRef(0);          // 防止过期的异步加载覆盖当前播放
  const prefetchRef = useRef({ key: "", url: "" });
  const urlRef = useRef("");           // 当前 objectURL
  const voiceRef = useRef(voice);
  const rateRef = useRef(rate);
  const pitchRef = useRef(pitch);
  const onPosRef = useRef(onPos);
  const onErrorRef = useRef(onError);
  const onChapterRef = useRef(onChapter);
  voiceRef.current = voice;
  rateRef.current = rate;
  pitchRef.current = pitch;
  onPosRef.current = onPos;
  onErrorRef.current = onError;
  onChapterRef.current = onChapter;

  /**
   * 取一段合成音频。
   * 显式传 opts 是关键：切音色/语速后立刻重播时，voiceRef 要等 React 重渲染才更新，
   * 若只用 ref，会拿【旧音色】去合成 => 用户看到“换了没反应/都是一个调”。
   */
  const ttsFetch = (ch, seg, opts = {}) => {
    const v = opts.voice ?? voiceRef.current;
    const r = opts.rate ?? rateRef.current;
    const p = opts.pitch ?? pitchRef.current;
    return fetch(
      `/api/books/${bookId}/tts?chapter=${ch}&seg=${seg}&voice=${encodeURIComponent(v)}&rate=${r}&pitch=${p}`,
      { credentials: "same-origin" }
    );
  };

  const getMeta = useCallback(
    async (chapterIdx) => {
      const cached = metaCache.current.get(chapterIdx);
      if (cached) return cached;
      const res = await fetch(`/api/books/${bookId}/chapters/${chapterIdx}`, {
        credentials: "same-origin",
      });
      if (!res.ok) throw new Error("章节加载失败");
      const d = await res.json();
      const m = {
        segCount: d.segmentCount || 0,
        nextIdx: d.nextIdx ?? null,
        prevIdx: d.prevIdx ?? null,
        title: d.chapter?.title || "",
      };
      metaCache.current.set(chapterIdx, m);
      return m;
    },
    [bookId]
  );

  const getAudio = useCallback(() => {
    if (!audioRef.current) {
      const a = new Audio();
      a.preload = "auto";
      a.addEventListener("play", () => setPlaying(true));
      a.addEventListener("pause", () => setPlaying(false));
      a.addEventListener("ended", () => {
        const p = posRef.current;
        const m = metaCache.current.get(p.chapterIdx);
        if (!m) return;
        if (p.segIdx + 1 < m.segCount) playAtRef.current(p.chapterIdx, p.segIdx + 1);
        else if (m.nextIdx != null) playAtRef.current(m.nextIdx, 0);
        else setPlaying(false);
      });
      audioRef.current = a;
    }
    return audioRef.current;
  }, []);

  const prefetch = useCallback(
    (m, ch, seg, opts = {}) => {
      let nch = ch;
      let nseg = seg + 1;
      if (nseg >= m.segCount) {
        if (m.nextIdx == null) return;
        nch = m.nextIdx;
        nseg = 0;
      }
      const v = opts.voice ?? voiceRef.current;
      const r = opts.rate ?? rateRef.current;
      const p = opts.pitch ?? pitchRef.current;
      const key = `${nch}:${nseg}:${v}:${r}:${p}`;
      ttsFetch(nch, nseg, { voice: v, rate: r, pitch: p })
        .then((r2) => (r2.ok ? r2.blob() : null))
        .then((b) => {
          if (b) prefetchRef.current = { key, url: URL.createObjectURL(b) };
        })
        .catch(() => {});
    },
    []
  );

  const playAt = useCallback(
    async (ch, seg, opts = {}) => {
      const token = ++tokenRef.current;
      setLoading(true);
      try {
        const v = opts.voice ?? voiceRef.current;
        const r = opts.rate ?? rateRef.current;
        const p = opts.pitch ?? pitchRef.current;
        let meta = await getMeta(ch);
        if (token !== tokenRef.current) return;

        let chapterIdx = ch;
        let segIdx = seg;
        if (segIdx >= meta.segCount) {
          if (meta.nextIdx == null) {
            setLoading(false);
            setPlaying(false);
            return;
          }
          chapterIdx = meta.nextIdx;
          segIdx = 0;
          meta = await getMeta(chapterIdx);
          if (token !== tokenRef.current) return;
        }

        setSegCount(meta.segCount);
        posRef.current = { chapterIdx, segIdx };
        setPos({ chapterIdx, segIdx });
        onPosRef.current?.({ chapterIdx, segIdx });
        onChapterRef.current?.({ chapterIdx, title: meta.title });

        const key = `${chapterIdx}:${segIdx}:${v}:${r}:${p}`;
        let objUrl;
        if (prefetchRef.current.key === key && prefetchRef.current.url) {
          objUrl = prefetchRef.current.url;
          prefetchRef.current = { key: "", url: "" };
        } else {
          const res = await ttsFetch(chapterIdx, segIdx, { voice: v, rate: r, pitch: p });
          if (token !== tokenRef.current) return;
          if (!res.ok) {
            throw new Error(
              res.status === 404 ? "该片段不存在" : `语音合成失败（${res.status}）`
            );
          }
          const blob = await res.blob();
          if (token !== tokenRef.current) return;
          objUrl = URL.createObjectURL(blob);
        }

        const a = getAudio();
        const old = urlRef.current;
        urlRef.current = objUrl;
        a.src = objUrl;
        if (old) setTimeout(() => URL.revokeObjectURL(old), 1000);

        try {
          await a.play();
        } catch (e) {
          if (e?.name === "NotAllowedError") {
            onErrorRef.current?.("浏览器不允许自动播放，请再点一次播放键");
          } else {
            throw e;
          }
        }
        setLoading(false);
        prefetch(meta, chapterIdx, segIdx, { voice: v, rate: r, pitch: p });
      } catch (e) {
        if (token !== tokenRef.current) return;
        setLoading(false);
        onErrorRef.current?.(e.message || "播放失败");
      }
    },
    [getMeta, getAudio, prefetch]
  );

  // 供 ended 事件回调（避免闭包过期）
  const playAtRef = useRef(playAt);
  playAtRef.current = playAt;

  /** iOS/Safari：首次需在用户手势中启动一次播放，后续程序化播放才不被拦 */
  const SILENT =
    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=";
  const prime = useCallback(() => {
    if (primedRef.current) return;
    primedRef.current = true;
    const a = getAudio();
    a.src = SILENT;
    a.play().catch(() => {});
  }, [getAudio]);

  const resume = useCallback(() => {
    prime();
    const a = getAudio();
    if (a.src && !a.src.startsWith("data:") && a.paused && a.currentTime > 0) {
      a.play().catch(() => playAt(posRef.current.chapterIdx, posRef.current.segIdx));
    } else {
      playAt(posRef.current.chapterIdx, posRef.current.segIdx);
    }
  }, [prime, getAudio, playAt]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
  }, []);

  const toggle = useCallback(() => {
    const a = audioRef.current;
    if (a && !a.paused) a.pause();
    else resume();
  }, [resume]);

  const next = useCallback(() => {
    const p = posRef.current;
    const m = metaCache.current.get(p.chapterIdx);
    if (!m) return playAt(p.chapterIdx, p.segIdx);
    if (p.segIdx + 1 < m.segCount) return playAt(p.chapterIdx, p.segIdx + 1);
    if (m.nextIdx != null) return playAt(m.nextIdx, 0);
    setPlaying(false);
  }, [playAt]);

  const prev = useCallback(() => {
    const p = posRef.current;
    const m = metaCache.current.get(p.chapterIdx);
    if (p.segIdx > 0) return playAt(p.chapterIdx, p.segIdx - 1);
    if (m?.prevIdx != null) return playAt(m.prevIdx, 0);
    playAt(p.chapterIdx, 0);
  }, [playAt]);

  /** 仅定位不播放（用于恢复上次收听位置） */
  const seekTo = useCallback(
    async (chapterIdx, segIdx = 0) => {
      try {
        const m = await getMeta(chapterIdx);
        metaCache.current.set(chapterIdx, m);
        setSegCount(m.segCount);
        posRef.current = { chapterIdx, segIdx };
        setPos({ chapterIdx, segIdx });
        onChapterRef.current?.({ chapterIdx, title: m.title });
      } catch {}
    },
    [getMeta]
  );

  const stop = useCallback(() => {
    tokenRef.current++;
    const a = audioRef.current;
    if (a) {
      a.pause();
      a.removeAttribute("src");
      a.load();
    }
    if (urlRef.current) {
      URL.revokeObjectURL(urlRef.current);
      urlRef.current = "";
    }
    setPlaying(false);
    setLoading(false);
  }, []);

  /* 卸载时清理 */
  useEffect(() => () => stop(), [stop]);

  /* 锁屏/耳机媒体控制 */
  useEffect(() => {
    const ms = typeof navigator !== "undefined" ? navigator.mediaSession : null;
    if (!ms) return;
    ms.setActionHandler?.("play", () => resume());
    ms.setActionHandler?.("pause", () => pause());
    ms.setActionHandler?.("previoustrack", () => prev());
    ms.setActionHandler?.("nexttrack", () => next());
    return () => {
      ms.setActionHandler?.("play", null);
      ms.setActionHandler?.("pause", null);
      ms.setActionHandler?.("previoustrack", null);
      ms.setActionHandler?.("nexttrack", null);
    };
  }, [resume, pause, prev, next]);

  return { playing, loading, pos, segCount, playAt, resume, pause, toggle, next, prev, seekTo, stop, prime };
}

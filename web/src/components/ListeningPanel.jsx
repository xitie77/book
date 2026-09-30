/**
 * 听书面板：选择音色、语速，播放/暂停、上一段/下一段，显示章节与进度。
 */
import { useEffect, useState } from "react";
import { api } from "../api.js";
import { toast } from "../components/Toast.jsx";

const RATE_PRESETS = [
  { v: -20, label: "0.8x" },
  { v: 0, label: "1.0x" },
  { v: 20, label: "1.2x" },
  { v: 40, label: "1.4x" },
];

const PITCH_PRESETS = [
  { v: -8, label: "低" },
  { v: 0, label: "标准" },
  { v: 8, label: "高" },
];

function fmtChars(n) {
  if (!n) return "";
  return n >= 10000 ? (n / 10000).toFixed(1) + " 万字" : n + " 字";
}

export default function ListeningPanel({ player, voice, setVoice, rate, setRate, pitch, setPitch, meta, open, onClose }) {
  const [voices, setVoices] = useState([]);

  useEffect(() => {
    api
      .get("/api/voices")
      .then((d) => setVoices(d.voices || []))
      .catch(() => toast("音色列表加载失败"));
  }, []);

  const females = voices.filter((v) => v.gender === "女");
  const males = voices.filter((v) => v.gender === "男");
  const curVoice = voices.find((v) => v.id === voice);
  const { playing, loading, pos, segCount } = player;

  const groups = [
    { label: "女声", list: females },
    { label: "男声", list: males },
  ];

  const pickVoice = (id) => {
    setVoice(id);
    // 显式传 voice：setState 要等重渲染才生效，直接传才能立即用新音色重合成
    if (playing) player.playAt(pos.chapterIdx, pos.segIdx, { voice: id });
  };

  return (
    <div className={"player" + (open ? " show" : "")}>
      <div className="player-inner">
        <button className="icon-btn" onClick={onClose} title="收起">
          ▾
        </button>
        <div className="player-now">
          <div className="pt">{meta?.title || "准备中…"}</div>
          <div className="pm muted">
            第 {pos.chapterIdx} 章
            {segCount ? ` · ${pos.segIdx + 1}/${segCount} 段` : ""}
            {curVoice ? ` · ${curVoice.name}` : ""}
          </div>
        </div>
      </div>

      <div className="player-controls">
        <button className="pctl" onClick={() => player.prev()} title="上一段">
          ⏮
        </button>
        <button className="pctl big" onClick={() => player.toggle()} title="播放/暂停">
          {loading ? <span className="pmini-spin" /> : playing ? "⏸" : "▶"}
        </button>
        <button className="pctl" onClick={() => player.next()} title="下一段">
          ⏭
        </button>
      </div>

      <div className="player-sec">
        <label>音色</label>
        <div className="voice-grid">
          {groups.map((g) =>
            g.list.length ? (
              <div key={g.label} className="voice-group">
                <div className="vg-label muted">{g.label}</div>
                <div className="vg-items">
                  {g.list.map((v) => (
                    <button
                      key={v.id}
                      className={"voice-chip" + (v.id === voice ? " active" : "")}
                      onClick={() => pickVoice(v.id)}
                      title={`${v.accent || ""} · ${v.style || ""}`}
                    >
                      {v.name}
                      {v.accent && v.accent !== "普通话" ? (
                        <span className="vacc">{v.accent}</span>
                      ) : null}
                      {v.tag ? <span className="vtag">{v.tag}</span> : null}
                    </button>
                  ))}
                </div>
              </div>
            ) : null
          )}
        </div>
      </div>

      <div className="player-sec">
        <label>语速</label>
        <div className="rate-row">
          {RATE_PRESETS.map((r) => (
            <button
              key={r.v}
              className={"rate-chip" + (rate === r.v ? " active" : "")}
              onClick={() => {
                setRate(r.v);
                if (playing) player.playAt(pos.chapterIdx, pos.segIdx, { rate: r.v });
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      <div className="player-sec">
        <label>音调</label>
        <div className="rate-row">
          {PITCH_PRESETS.map((p) => (
            <button
              key={p.v}
              className={"rate-chip" + (pitch === p.v ? " active" : "")}
              onClick={() => {
                setPitch(p.v);
                if (playing) player.playAt(pos.chapterIdx, pos.segIdx, { pitch: p.v });
              }}
            >
              {p.label}
            </button>
          ))}
        </div>
        <div className="muted" style={{ fontSize: 12, marginTop: 8 }}>
          首次合成一段约需 1~3 秒，之后自动缓存、重复收听秒开。
        </div>
      </div>
    </div>
  );
}

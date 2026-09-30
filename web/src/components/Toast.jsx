import { useEffect, useState } from "react";

export function toast(msg, ms = 2200) {
  window.dispatchEvent(new CustomEvent("book-toast", { detail: { msg, ms } }));
}

export default function Toast() {
  const [item, setItem] = useState(null);

  useEffect(() => {
    let timer;
    const on = (e) => {
      setItem(e.detail);
      clearTimeout(timer);
      timer = setTimeout(() => setItem(null), e.detail.ms || 2200);
    };
    window.addEventListener("book-toast", on);
    return () => {
      window.removeEventListener("book-toast", on);
      clearTimeout(timer);
    };
  }, []);

  if (!item) return null;
  return <div className="toast">{item.msg}</div>;
}

const json = { "Content-Type": "application/json" };

async function req(url, options = {}) {
  const res = await fetch(url, { credentials: "same-origin", ...options });
  if (res.status === 204) return null;
  let data = null;
  const text = await res.text();
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export const api = {
  get: (url) => req(url),
  post: (url, body) =>
    req(url, { method: "POST", headers: json, body: JSON.stringify(body) }),
  put: (url, body) => req(url, { method: "PUT", headers: json, body: JSON.stringify(body) }),
  patch: (url, body) =>
    req(url, { method: "PATCH", headers: json, body: JSON.stringify(body) }),
  del: (url) => req(url, { method: "DELETE" }),

  /* 上传（FormData，不设 Content-Type，让浏览器带 boundary） */
  upload(url, formData, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      xhr.withCredentials = true;
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && onProgress) onProgress(e.loaded / e.total);
      };
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch {
          data = xhr.responseText;
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else {
          const err = new Error((data && data.error) || `上传失败 (${xhr.status})`);
          err.status = xhr.status;
          err.data = data;
          reject(err);
        }
      };
      xhr.onerror = () => reject(new Error("网络错误"));
      xhr.send(formData);
    });
  },
};

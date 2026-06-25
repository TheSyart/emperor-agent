(function expose(factory) {
  if (typeof module === "object" && module.exports) {
    module.exports = factory();
  } else {
    window.EmperorPetUrls = factory();
  }
})(function buildRuntimeUrls() {
  function trimBase(base) {
    return String(base || "http://127.0.0.1:8765").replace(/\/$/, "");
  }

  function appendToken(url, token) {
    const value = String(token || "").trim();
    if (!value) return url;
    return `${url}${url.includes("?") ? "&" : "?"}token=${encodeURIComponent(value)}`;
  }

  function apiUrl(base, path, token) {
    return appendToken(`${trimBase(base)}${path}`, token);
  }

  function wsUrl(base, lastSeq, token) {
    const wsBase = trimBase(base).replace(/^http/i, "ws");
    const seq = encodeURIComponent(Number.isFinite(Number(lastSeq)) ? Number(lastSeq) : 0);
    return appendToken(`${wsBase}/ws?last_seq=${seq}`, token);
  }

  return {
    apiUrl,
    appendToken,
    wsUrl,
  };
});

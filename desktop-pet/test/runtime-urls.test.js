const test = require("node:test");
const assert = require("node:assert/strict");
const { apiUrl, appendToken, wsUrl } = require("../runtime-urls");

test("appends auth token to api and websocket urls", () => {
  assert.equal(
    apiUrl("http://127.0.0.1:8765", "/api/bootstrap", "tok value"),
    "http://127.0.0.1:8765/api/bootstrap?token=tok%20value",
  );
  assert.equal(
    wsUrl("http://127.0.0.1:8765", 42, "tok"),
    "ws://127.0.0.1:8765/ws?last_seq=42&token=tok",
  );
});

test("keeps token-free urls unchanged for development", () => {
  assert.equal(appendToken("http://127.0.0.1:8765/api/bootstrap", ""), "http://127.0.0.1:8765/api/bootstrap");
  assert.equal(wsUrl("http://127.0.0.1:8765/", 0, ""), "ws://127.0.0.1:8765/ws?last_seq=0");
});

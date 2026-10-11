import { createHash } from "node:crypto";

const stable = (...parts) => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 32);

export function createRoomClient({ origin, roomId, token, fetchImpl = fetch }) {
  const base = `${origin.replace(/\/$/, "")}/api/rooms/${encodeURIComponent(roomId)}`;
  async function call(method, path, body) {
    const response = await fetchImpl(`${base}${path}`, {
      method, headers: { authorization: `Bearer ${token}`, origin, ...(body ? { "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {})
    });
    const text = await response.text();
    let value = null; try { value = text ? JSON.parse(text) : null; } catch { value = { raw: text.slice(0, 200) }; }
    if (!response.ok) throw Object.assign(new Error(value?.error?.message || `HTTP ${response.status}`), { status: response.status, code: value?.error?.code, value });
    return value;
  }
  return {
    roomId,
    assistant: () => call("GET", "/assistant"),
    act: input => call("POST", "/assistant", input),
    message: async id => (await call("GET", `/conversation?messageId=${encodeURIComponent(id)}`)).messages?.find(m => m.id === id) ?? null,
    recent: async (limit = 100) => (await call("GET", `/conversation?limit=${limit}`)).messages ?? [],
    members: async () => (await call("GET", ""))?.state?.members ?? {},
    post: (messageId, body, extra = {}) => call("POST", "/commands", { id: stable("cmd", messageId), type: "message.posted", data: { messageId, body, ...extra } })
  };
}

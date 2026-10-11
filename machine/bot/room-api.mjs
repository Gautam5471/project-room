import { randomUUID } from "node:crypto";
import { redact } from "./redact.mjs";

export const BOT_HOST_ID = "room-machine";

async function call(origin, path, { token, method = "GET", body, signal } = {}) {
  try {
    const headers = { accept: "application/json", origin };
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(new URL(path, origin), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    let value = null;
    if (text) {
      try { value = JSON.parse(text); } catch { value = null; }
    }
    return { ok: response.ok, status: response.status, value };
  } catch {
    return { ok: false, status: 0, value: null };
  }
}

export function createRoomApi({ origin, secret, signal }) {
  const auth = { token: secret, signal };
  return {
    async heartbeat() {
      // The heartbeat body is hostId, mode, wakeUrl, cadenceSeconds,
      // pushNotification, and workWakes. U does not accept host metadata, so
      // hosted_by is not sent.
      return call(origin, "/api/agent-heartbeats", {
        ...auth,
        method: "POST",
        body: { hostId: BOT_HOST_ID, mode: "wakeable", cadenceSeconds: 300, workWakes: true },
      });
    },
    async poll(waitMs) {
      const wait = Number.isInteger(waitMs) && waitMs >= 0 ? waitMs : 0;
      return call(origin, `/api/agent-wakes/poll?hostId=${encodeURIComponent(BOT_HOST_ID)}&waitMs=${wait}`, auth);
    },
    async ack(signalIds) {
      if (!Array.isArray(signalIds) || signalIds.length === 0) return { ok: true, value: { acknowledged: [] } };
      return call(origin, "/api/agent-heartbeats/ack", { ...auth, method: "POST", body: { signalIds } });
    },
    async orient(roomId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/orient`, auth);
    },
    async updates(roomId) {
      const items = [];
      let cursor = "";
      let incomplete = null;
      for (let page = 0; page < 5; page += 1) {
        const params = new URLSearchParams({ state: "actionable", limit: "100" });
        if (cursor) params.set("cursor", cursor);
        const listed = await call(origin, `/api/rooms/${encodeURIComponent(roomId)}/updates?${params}`, auth);
        if (!listed.ok) {
          if (items.length === 0) return listed;
          return { ok: true, status: 200, value: { items, incompleteSources: { ...(incomplete ?? {}), mentions: true } } };
        }
        incomplete = listed.value?.incompleteSources ?? incomplete;
        items.push(...(listed.value?.items ?? []));
        if (!listed.value?.hasMore || typeof listed.value.cursor !== "string" || !listed.value.cursor) break;
        cursor = listed.value.cursor;
      }
      return { ok: true, status: 200, value: { items, incompleteSources: incomplete } };
    },
    async markUpdate(roomId, itemId, action, expectedBasis, requestId = randomUUID()) {
      if (typeof itemId !== "string" || !itemId) return { ok: false, skipped: true, reason: "update_id_required", value: null };
      // Old saved tasks cannot safely mark a revision they never observed.
      if (typeof expectedBasis !== "string" || !expectedBasis) {
        return { ok: false, skipped: true, reason: "update_basis_required", value: null };
      }
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/updates/${encodeURIComponent(itemId)}/${action}`, {
        ...auth,
        method: "POST",
        body: { requestId, expectedBasis },
      });
    },
    async conversation(roomId, { messageId, limit } = {}) {
      const query = messageId
        ? `messageId=${encodeURIComponent(messageId)}`
        : `limit=${limit ?? 40}`;
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/conversation?${query}`, auth);
    },
    async post(roomId, body, { replyToId = null, secrets = [], messageId = randomUUID() } = {}) {
      const id = messageId;
      const clean = redact(body, secrets);
      const data = { messageId: id, body: clean };
      if (replyToId) data.replyToId = replyToId;
      const posted = await call(origin, `/api/rooms/${encodeURIComponent(roomId)}/commands`, {
        ...auth,
        method: "POST",
        body: { id, type: "message.posted", data },
      });
      return { ...posted, messageId: id };
    },
    async claims(roomId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims?limit=200`, auth);
    },
    async claim(roomId, claimId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}`, auth);
    },
    async createClaim(roomId, body) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims`, { ...auth, method: "POST", body });
    },
    async takeClaim(roomId, claimId, body) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/claim`, {
        ...auth, method: "POST", body,
      });
    },
    async updateClaim(roomId, claimId, body) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/work-claims/${encodeURIComponent(claimId)}/update`, {
        ...auth, method: "POST", body,
      });
    },
    async pause(roomId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/agent-pause`, auth);
    },
    async tier(roomId, memberId) {
      return call(origin, `/api/rooms/${encodeURIComponent(roomId)}/operator/agents/${encodeURIComponent(memberId)}`, auth);
    },
  };
}

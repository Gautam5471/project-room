import test from "node:test";
import assert from "node:assert/strict";
import { createWebhooks, validateWebhookUrl, WebhookError } from "../server/outbound-webhooks.mjs";

const throwsInvalid = fn => assert.throws(fn, error => error instanceof WebhookError && error.code === "invalid_webhook");

test("validateWebhookUrl rejects https userinfo before a public host is stored", () => {
  throwsInvalid(() => validateWebhookUrl("https://ops:s3cret@hooks.example.com/hook"));
  throwsInvalid(() => validateWebhookUrl("https://ops@hooks.example.com/hook"));
  throwsInvalid(() => validateWebhookUrl("https://:s3cret@hooks.example.com:8443/hook"));
  assert.equal(validateWebhookUrl("https://hooks.example.com/user@path"), "https://hooks.example.com/user@path");
  assert.equal(validateWebhookUrl("https://hooks.example.com:8443/hook"), "https://hooks.example.com:8443/hook");
});

test("register does not keep a webhook URL that would be sent as Basic auth", () => {
  const hooks = createWebhooks();
  throwsInvalid(() => hooks.register({
    webhookId: "cred",
    url: "https://ops:s3cret@hooks.example.com/hook",
    events: ["message.posted"],
  }));
  assert.equal(hooks.size(), 0);
});

import assert from "node:assert/strict";
import { test } from "node:test";
import { BILLING_RETURN_DEEP_LINK, buildBillingForward } from "./forward.js";

test("forwards a whitelisted status to the fixed deep link", () => {
  assert.deepEqual(buildBillingForward("?modus_billing=success"), {
    target: "modus://billing/return?status=success",
    status: "success",
  });
  assert.equal(
    buildBillingForward("modus_billing=portal").target,
    `${BILLING_RETURN_DEEP_LINK}?status=portal`,
  );
});

test("unknown or missing status is dropped", () => {
  for (const search of [
    "",
    "?",
    "?modus_billing=paid",
    "?modus_billing=SUCCESS",
    "?modus_billing=success%0A",
  ]) {
    assert.deepEqual(buildBillingForward(search), {
      target: BILLING_RETURN_DEEP_LINK,
      status: null,
    });
  }
});

test("the destination never comes from the query (no open redirect)", () => {
  for (const search of [
    "?modus_billing=success&redirect=https://evil.example",
    "?modus_billing=success&next=javascript:alert(1)",
    "?modus_billing=https://evil.example",
    "?target=modus://auth/callback?code=x",
    "?modus_billing=success&status=cancel",
  ]) {
    const { target } = buildBillingForward(search);
    assert.ok(
      target === BILLING_RETURN_DEEP_LINK || target.startsWith(`${BILLING_RETURN_DEEP_LINK}?`),
    );
    const url = new URL(target);
    assert.equal(url.protocol, "modus:");
    assert.equal(url.hostname + url.pathname, "billing/return");
    for (const key of url.searchParams.keys()) assert.ok(["status", "session_id"].includes(key));
    assert.ok(
      !target.includes("evil") && !target.includes("javascript") && !target.includes("auth"),
    );
  }
});

test("session_id is forwarded only in Checkout Session format", () => {
  assert.equal(
    buildBillingForward("?modus_billing=success&session_id=cs_test_a1B2c3").target,
    "modus://billing/return?status=success&session_id=cs_test_a1B2c3",
  );
  assert.equal(
    buildBillingForward("?session_id=cs_live_XYZ9").target,
    "modus://billing/return?session_id=cs_live_XYZ9",
  );
  for (const bad of [
    "cs_test_",
    "cs_prod_abc",
    "pi_test_abc",
    "cs_test_abc&x=1",
    "cs_test_abc<script>",
    "cs_test_abc def",
    `cs_test_${"a".repeat(300)}`,
    "{CHECKOUT_SESSION_ID}",
  ]) {
    const { target } = buildBillingForward(
      `?modus_billing=success&session_id=${encodeURIComponent(bad)}`,
    );
    assert.equal(target, "modus://billing/return?status=success", bad);
  }
});

test("non-string input is treated as empty", () => {
  assert.equal(buildBillingForward(undefined).target, BILLING_RETURN_DEEP_LINK);
});

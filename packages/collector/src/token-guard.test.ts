import assert from "node:assert/strict";
import { test } from "node:test";

import { isAuthError } from "./token-guard.ts";

test("isAuthError：401 判为令牌失效", () => {
  assert.equal(isAuthError('GitHub 检索失败: HTTP 401 {"message":"Bad credentials"}'), true);
});

test("isAuthError：403 判为权限不足", () => {
  assert.equal(isAuthError("GitHub 检索失败: HTTP 403 rate limit"), true);
});

test("isAuthError：404 不算鉴权问题，仍走降级", () => {
  assert.equal(isAuthError("GitHub 检索失败: HTTP 404 Not Found"), false);
});

test("isAuthError：网络类错误不算鉴权问题", () => {
  assert.equal(isAuthError("fetch failed"), false);
  // 状态码出现在别的上下文里（例如配额数字）不应误判
  assert.equal(isAuthError("GitHub 检索失败: HTTP 422 超过 401 条上限"), false);
});

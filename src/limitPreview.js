'use strict';

/**
 * 额度下调预演凭证（内存存储，单实例部署与会话表同策略）。
 * 凭证不改变任何业务状态，仅固化“预演时的请求字段 + 占用状态指纹”，
 * 提交时据此判断额度或相关占用是否已变化（乐观并发）。
 */

const crypto = require('crypto');

const TTL_MS = 30 * 60 * 1000; // 30 分钟

// token -> { token, payload, createdAt, expiresAt }
const tokens = new Map();

function sweep(now = Date.now()) {
  for (const [t, rec] of tokens) {
    if (now > rec.expiresAt) tokens.delete(t);
  }
}

/** 签发预演凭证。payload: { request:{exhibitId,year,limitLxh}, fingerprint }。 */
function createToken(payload, now = Date.now()) {
  sweep(now);
  const token = crypto.randomBytes(24).toString('hex');
  const rec = { token, payload, createdAt: now, expiresAt: now + TTL_MS };
  tokens.set(token, rec);
  return rec;
}

/** 读取凭证（过期返回 null，不删除由 takeToken 负责）。 */
function getToken(token, now = Date.now()) {
  const rec = tokens.get(token);
  if (!rec) return null;
  if (now > rec.expiresAt) {
    tokens.delete(token);
    return null;
  }
  return rec;
}

/** 取出并销毁凭证（一次性）；过期/不存在返回 null。 */
function takeToken(token, now = Date.now()) {
  const rec = getToken(token, now);
  if (rec) tokens.delete(token);
  return rec;
}

module.exports = { createToken, getToken, takeToken, TTL_MS };

const { TYPING_TTL_MS } = require('../constants');

// Ephemeral typing state — in-memory only, nothing persisted.
// scopeKey: 'chan:<channelId>' or 'dm:<minUserId>:<maxUserId>'
const typing = new Map();

function dmScope(a, b) {
    return a < b ? `dm:${a}:${b}` : `dm:${b}:${a}`;
}

function setTyping(scopeKey, userId) {
    let scope = typing.get(scopeKey);
    if (!scope) { scope = new Map(); typing.set(scopeKey, scope); }
    scope.set(userId, Date.now());
}

function getTyping(scopeKey, excludeUserId) {
    const scope = typing.get(scopeKey);
    if (!scope) return [];
    const cutoff = Date.now() - TYPING_TTL_MS;
    const out = [];
    for (const [userId, ts] of scope) {
        if (ts < cutoff) { scope.delete(userId); continue; }
        if (userId !== excludeUserId) out.push(userId);
    }
    if (scope.size === 0) typing.delete(scopeKey);
    return out;
}

function sweep() {
    const cutoff = Date.now() - TYPING_TTL_MS;
    for (const [key, scope] of typing) {
        for (const [userId, ts] of scope) if (ts < cutoff) scope.delete(userId);
        if (scope.size === 0) typing.delete(key);
    }
}

module.exports = { setTyping, getTyping, sweep, dmScope };

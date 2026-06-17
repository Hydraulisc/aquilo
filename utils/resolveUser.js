const db = require('../database/helpers');
const { USER_CACHE_TTL_MS, USER_CACHE_MAX } = require('../constants');

// Bounded LRU: Map iteration order is insertion order, so re-inserting on
// hit keeps recently used entries at the tail and evicts from the head.
const userCache = new Map();

async function resolveUser(userId) {
    const cached = userCache.get(userId);
    if (cached && Date.now() - cached.ts < USER_CACHE_TTL_MS) {
        userCache.delete(userId);
        userCache.set(userId, cached);
        return cached.data;
    }

    const row = db.getCachedUser(userId);
    const pfp = row?.pfp?.startsWith('/') ? `https://hydraulisc.net${row.pfp}` : (row?.pfp || null);
    const data = row
        ? { uid: row.id, username: row.username, ownPfp: pfp }
        : { uid: userId, username: `User#${userId}`, ownPfp: null };

    userCache.delete(userId);
    userCache.set(userId, { data, ts: Date.now() });
    if (userCache.size > USER_CACHE_MAX) {
        userCache.delete(userCache.keys().next().value);
    }
    return data;
}

module.exports = { resolveUser };

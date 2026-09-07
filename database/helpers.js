const crypto = require('crypto');
const db = require('./init');

function coarseTimestamp() {
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5);
    return now.toISOString().replace('T', ' ').slice(0, 16);
}

// it is good practice to keep all db helper functions in here instead of doing this in api.js
// you can just import like this: const db = require('../database/helpers');
// and use the helper function like this: db.createServer()

// Servers
const createServer = db.transaction((name, ownerId, icon = null) => {
    const serverId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();

    db.prepare(
        'INSERT INTO servers (id, name, icon, owner_id) VALUES (?, ?, ?, ?)'
    ).run(serverId, name, icon, ownerId);

    db.prepare(
        'INSERT INTO channels (id, server_id, name, position) VALUES (?, ?, ?, 0)'
    ).run(channelId, serverId, 'general');

    db.prepare(
        'INSERT INTO memberships (id, server_id, user_id) VALUES (?, ?, ?)'
    ).run(membershipId, serverId, ownerId);

    return { serverId, channelId };
});

function getServer(id) {
    return db.prepare('SELECT * FROM servers WHERE id = ?').get(id);
}

function getServersForUser(userId) {
    return db.prepare(
        `SELECT s.* FROM servers s
         JOIN memberships m ON m.server_id = s.id
         WHERE m.user_id = ?
         ORDER BY s.created_at`
    ).all(userId);
}

function updateServer(id, userId, { name, icon }) {
    const sets = [];
    const params = [];
    if (name !== undefined) { sets.push('name = ?'); params.push(name); }
    if (icon !== undefined) { sets.push('icon = ?'); params.push(icon); }
    if (sets.length === 0) return false;
    params.push(id, userId);
    const result = db.prepare(
        `UPDATE servers SET ${sets.join(', ')} WHERE id = ? AND owner_id = ?`
    ).run(...params);
    return result.changes > 0;
}

const deleteServer = db.transaction((id, userId) => {
    db.prepare('DELETE FROM reports WHERE server_id = ?').run(id);
    return db.prepare('DELETE FROM servers WHERE id = ? AND owner_id = ?').run(id, userId).changes > 0;
});

const deleteServerAdmin = db.transaction((id) => {
    db.prepare('DELETE FROM reports WHERE server_id = ?').run(id);
    return db.prepare('DELETE FROM servers WHERE id = ?').run(id).changes > 0;
});

// Channels
function createChannel(serverId, name) {
    const id = crypto.randomUUID();
    const maxPos = db.prepare(
        'SELECT COALESCE(MAX(position), -1) AS max FROM channels WHERE server_id = ?'
    ).get(serverId).max;

    db.prepare(
        'INSERT INTO channels (id, server_id, name, position) VALUES (?, ?, ?, ?)'
    ).run(id, serverId, name, maxPos + 1);

    return { id, server_id: serverId, name, position: maxPos + 1 };
}

function getChannelsForServer(serverId) {
    return db.prepare(
        'SELECT * FROM channels WHERE server_id = ? ORDER BY position'
    ).all(serverId);
}

function deleteChannel(id) {
    const result = db.prepare('DELETE FROM channels WHERE id = ?').run(id);
    return result.changes > 0;
}

function getChannel(id) {
    return db.prepare('SELECT * FROM channels WHERE id = ?').get(id);
}

function updateChannel(id, name) {
    const result = db.prepare('UPDATE channels SET name = ? WHERE id = ?').run(name, id);
    return result.changes > 0;
}

const reorderChannels = db.transaction((serverId, orderedIds) => {
    const stmt = db.prepare('UPDATE channels SET position = ? WHERE id = ? AND server_id = ?');
    for (let i = 0; i < orderedIds.length; i++) {
        stmt.run(i, orderedIds[i], serverId);
    }
});

function channelCount(serverId) {
    return db.prepare('SELECT COUNT(*) AS count FROM channels WHERE server_id = ?').get(serverId).count;
}

// Messages
function createMessage(id, channelId, userId, content, opts = {}) {
    const ts = coarseTimestamp();
    db.prepare(
        `INSERT INTO messages (id, channel_id, user_id, content, frank, expires_at, burn_after_read, reply_to_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, channelId, userId, content, opts.frank || null, opts.expiresAt || null,
          opts.burnAfterRead ? 1 : 0, opts.replyToId || null, ts);
    return { id, channel_id: channelId, user_id: userId, content, frank: opts.frank || null,
             expires_at: opts.expiresAt || null, burn_after_read: opts.burnAfterRead ? 1 : 0,
             reply_to_id: opts.replyToId || null, created_at: ts };
}

function getMessages(channelId, limit = 50, before = null, after = null) {
    limit = Math.min(Math.max(1, limit), 50);
    if (before) {
        return db.prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
             ORDER BY rowid DESC LIMIT ?`
        ).all(channelId, before, limit);
    }
    if (after) {
        return db.prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND rowid > (SELECT rowid FROM messages WHERE id = ?)
             ORDER BY rowid ASC LIMIT ?`
        ).all(channelId, after, limit);
    }
    return db.prepare(
        'SELECT * FROM messages WHERE channel_id = ? ORDER BY rowid DESC LIMIT ?'
    ).all(channelId, limit);
}

function getMessagesAfter(channelId, afterId, limit = 50) {
    limit = Math.min(Math.max(1, limit), 50);
    return db.prepare(
        `SELECT * FROM messages
         WHERE channel_id = ? AND created_at >= (SELECT created_at FROM messages WHERE id = ?)
           AND id != ?
         ORDER BY created_at ASC LIMIT ?`
    ).all(channelId, afterId, afterId, limit);
}

function editMessage(id, userId, content) {
    const result = db.prepare(
        'UPDATE messages SET content = ?, edited_at = ? WHERE id = ? AND user_id = ?'
    ).run(content, coarseTimestamp(), id, userId);
    return result.changes > 0;
}

function deleteMessage(id, userId) {
    const result = db.prepare(
        'DELETE FROM messages WHERE id = ? AND user_id = ?'
    ).run(id, userId);
    return result.changes > 0;
}

function deleteMessageAsOwner(id) {
    const result = db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    return result.changes > 0;
}

function getMessage(id) {
    return db.prepare('SELECT * FROM messages WHERE id = ?').get(id);
}

// Memberships
function joinServer(serverId, userId) {
    const id = crypto.randomUUID();
    try {
        db.prepare(
            'INSERT INTO memberships (id, server_id, user_id) VALUES (?, ?, ?)'
        ).run(id, serverId, userId);
        return true;
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') return false;
        throw err;
    }
}

function leaveServer(serverId, userId) {
    const result = db.prepare(
        'DELETE FROM memberships WHERE server_id = ? AND user_id = ?'
    ).run(serverId, userId);
    return result.changes > 0;
}

function getMembers(serverId) {
    return db.prepare(
        'SELECT * FROM memberships WHERE server_id = ? ORDER BY joined_at'
    ).all(serverId);
}

function isMember(serverId, userId) {
    return !!db.prepare(
        'SELECT 1 FROM memberships WHERE server_id = ? AND user_id = ?'
    ).get(serverId, userId);
}

function removeMember(serverId, userId) {
    const result = db.prepare(
        'DELETE FROM memberships WHERE server_id = ? AND user_id = ?'
    ).run(serverId, userId);
    return result.changes > 0;
}

// Invites
function createInvite(serverId, userId, { maxUses = null, expiresAt = null } = {}) {
    const code = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    db.prepare(
        'INSERT INTO invites (code, server_id, created_by, max_uses, expires_at) VALUES (?, ?, ?, ?, ?)'
    ).run(code, serverId, userId, maxUses, expiresAt);
    return code;
}

function getInvite(code) {
    const invite = db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
    if (!invite) return null;
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return null;
    if (invite.max_uses !== null && invite.uses >= invite.max_uses) return null;
    return invite;
}

function getRawInvite(code) {
    return db.prepare('SELECT * FROM invites WHERE code = ?').get(code);
}

function getInvitesForServer(serverId) {
    return db.prepare('SELECT * FROM invites WHERE server_id = ? ORDER BY created_at').all(serverId);
}

function deleteInvite(code) {
    const result = db.prepare('DELETE FROM invites WHERE code = ?').run(code);
    return result.changes > 0;
}

function useInvite(code) {
    const result = db.prepare('UPDATE invites SET uses = uses + 1 WHERE code = ?').run(code);
    return result.changes > 0;
}

// Reports
function createReport(messageId, channelId, serverId, reporterId, content, frankVerified = null) {
    const id = crypto.randomUUID();
    db.prepare(
        'INSERT INTO reports (id, message_id, channel_id, server_id, reporter_id, content, frank_verified) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).run(id, messageId, channelId, serverId, reporterId, content, frankVerified);
    return id;
}

function getReportsForServer(serverId) {
    return db.prepare(
        'SELECT * FROM reports WHERE server_id = ? ORDER BY reported_at DESC'
    ).all(serverId);
}

function getAllReports() {
    return db.prepare(`
        SELECT r.*, s.name AS server_name, s.owner_id AS server_owner_id,
               c.name AS channel_name, m.user_id AS sender_id
        FROM reports r
        JOIN servers s ON s.id = r.server_id
        JOIN channels c ON c.id = r.channel_id
        LEFT JOIN messages m ON m.id = r.message_id
        ORDER BY r.reported_at DESC
    `).all();
}

function getReport(id) {
    return db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
}

function deleteReport(id) {
    return db.prepare('DELETE FROM reports WHERE id = ?').run(id).changes > 0;
}

// Users cache
function upsertUser(id, username, pfp) {
    db.prepare(
        `INSERT INTO users (id, username, pfp, updated_at) VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET username=excluded.username, pfp=excluded.pfp, updated_at=excluded.updated_at`
    ).run(id, username, pfp || null);
}

function getCachedUser(id) {
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}

// PGP Keys
function setUserKey(userId, publicKey, fingerprint) {
    db.prepare(
        `INSERT OR REPLACE INTO user_keys (user_id, public_key, fingerprint, verified_at, created_at)
         VALUES (?, ?, ?, NULL, datetime('now'))`
    ).run(userId, publicKey, fingerprint);
}

function getUserKey(userId) {
    return db.prepare('SELECT * FROM user_keys WHERE user_id = ?').get(userId);
}

function verifyUserKey(userId) {
    db.prepare(`UPDATE user_keys SET verified_at = datetime('now') WHERE user_id = ?`).run(userId);
}

// Channel keys (per-channel client-generated, PGP-wrapped)
function setChannelKey(channelId, userId, wrappedKey, version = 1) {
    db.prepare(
        `INSERT OR REPLACE INTO channel_keys (channel_id, user_id, wrapped_key, key_version)
         VALUES (?, ?, ?, ?)`
    ).run(channelId, userId, wrappedKey, version);
}

function getChannelKey(channelId, userId) {
    return db.prepare(
        'SELECT * FROM channel_keys WHERE channel_id = ? AND user_id = ?'
    ).get(channelId, userId);
}

function getChannelKeyVersion(channelId) {
    const row = db.prepare(
        'SELECT MAX(key_version) AS version FROM channel_keys WHERE channel_id = ?'
    ).get(channelId);
    return row?.version ?? 0;
}

const rotateChannelKeys = db.transaction((channelId, newVersion, entries) => {
    db.prepare('DELETE FROM channel_keys WHERE channel_id = ?').run(channelId);
    const stmt = db.prepare(
        'INSERT INTO channel_keys (channel_id, user_id, wrapped_key, key_version) VALUES (?, ?, ?, ?)'
    );
    for (const { userId, wrappedKey } of entries) {
        stmt.run(channelId, userId, wrappedKey, newVersion);
    }
});

function deleteChannelKey(channelId, userId) {
    db.prepare('DELETE FROM channel_keys WHERE channel_id = ? AND user_id = ?').run(channelId, userId);
}

// Message expiry & burn-after-read
function deleteExpiredMessages() {
    db.prepare("DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
}

function burnMessage(id) {
    db.prepare("UPDATE messages SET content = '', viewed = 1 WHERE id = ?").run(id);
}

// Exactly one reader gets content, then content is destroyed 
const claimBurn = db.transaction((id) => {
    const r = db.prepare(
        'UPDATE messages SET viewed = 1 WHERE id = ? AND burn_after_read = 1 AND viewed = 0'
    ).run(id);
    if (r.changes === 0) return false;
    db.prepare("UPDATE messages SET content = '' WHERE id = ?").run(id);
    return true;
});

const claimBurnDm = db.transaction((id) => {
    const r = db.prepare(
        'UPDATE dms SET viewed = 1 WHERE id = ? AND burn_after_read = 1 AND viewed = 0'
    ).run(id);
    if (r.changes === 0) return false;
    db.prepare("UPDATE dms SET content = '' WHERE id = ?").run(id);
    return true;
});

function markMessageViewed(id) {
    db.prepare('UPDATE messages SET viewed = 1 WHERE id = ?').run(id);
}

// DMs
function createDm(senderId, recipientId, content, encryptionMode = 'none', opts = {}) {
    const id = crypto.randomUUID();
    db.prepare(
        `INSERT INTO dms (id, sender_id, recipient_id, content, encryption_mode, expires_at, burn_after_read, reply_to_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, senderId, recipientId, content, encryptionMode,
          opts.expiresAt || null, opts.burnAfterRead ? 1 : 0, opts.replyToId || null);
    return { id, sender_id: senderId, recipient_id: recipientId, content,
             encryption_mode: encryptionMode, reply_to_id: opts.replyToId || null,
             created_at: new Date().toISOString() };
}

function getDm(id) {
    return db.prepare('SELECT * FROM dms WHERE id = ?').get(id);
}

function getDms(userId, withUserId, limit = 50, before = null) {
    limit = Math.min(Math.max(1, limit), 50);
    if (before) {
        return db.prepare(
            `SELECT * FROM dms
             WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
               AND created_at < (SELECT created_at FROM dms WHERE id = ?)
             ORDER BY created_at DESC LIMIT ?`
        ).all(userId, withUserId, withUserId, userId, before, limit);
    }
    return db.prepare(
        `SELECT * FROM dms
         WHERE (sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?)
         ORDER BY created_at DESC LIMIT ?`
    ).all(userId, withUserId, withUserId, userId, limit);
}

function getDmsAfter(userId, withUserId, afterId, limit = 50) {
    limit = Math.min(Math.max(1, limit), 50);
    return db.prepare(
        `SELECT * FROM dms
         WHERE ((sender_id = ? AND recipient_id = ?) OR (sender_id = ? AND recipient_id = ?))
           AND created_at >= (SELECT created_at FROM dms WHERE id = ?)
           AND id != ?
         ORDER BY created_at ASC LIMIT ?`
    ).all(userId, withUserId, withUserId, userId, afterId, afterId, limit);
}

function getDmUnreadCounts(userId) {
    return db.prepare(
        `SELECT d.sender_id AS partner_id, COUNT(*) AS unread
         FROM dms d
         LEFT JOIN dm_reads r ON r.user_id = ? AND r.partner_id = d.sender_id
         WHERE d.recipient_id = ?
           AND d.created_at > COALESCE(r.last_read_at, '1970-01-01')
         GROUP BY d.sender_id`
    ).all(userId, userId);
}

function markDmRead(userId, partnerId) {
    db.prepare(
        `INSERT INTO dm_reads (user_id, partner_id, last_read_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id, partner_id) DO UPDATE SET last_read_at = datetime('now')`
    ).run(userId, partnerId);
}

// Channel read tracking (mirrors dm_reads)
function getChannelLastRead(userId, channelId) {
    const row = db.prepare(
        'SELECT last_read_at FROM channel_reads WHERE user_id = ? AND channel_id = ?'
    ).get(userId, channelId);
    return row?.last_read_at || '1970-01-01';
}

function markChannelRead(userId, channelId) {
    db.prepare(
        `INSERT INTO channel_reads (user_id, channel_id, last_read_at) VALUES (?, ?, datetime('now'))
         ON CONFLICT(user_id, channel_id) DO UPDATE SET last_read_at = datetime('now')`
    ).run(userId, channelId);
}

function getChannelUnreadCounts(userId, serverId) {
    return db.prepare(
        `SELECT m.channel_id, COUNT(*) AS unread
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN channel_reads r ON r.user_id = ? AND r.channel_id = m.channel_id
         WHERE c.server_id = ?
           AND m.user_id != ?
           AND m.created_at > COALESCE(r.last_read_at, '1970-01-01')
         GROUP BY m.channel_id`
    ).all(userId, serverId, userId);
}

function getDmConversations(userId) {
    return db.prepare(
        `SELECT DISTINCT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END AS partner_id
         FROM dms WHERE sender_id = ? OR recipient_id = ?`
    ).all(userId, userId, userId);
}

function getDmSettings(userA, userB) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    return db.prepare('SELECT * FROM dm_settings WHERE user_a = ? AND user_b = ?').get(a, b)
        || { user_a: a, user_b: b, encryption_mode: 'none' };
}

function setDmEncryptionMode(userA, userB, mode) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    db.prepare(
        `INSERT OR REPLACE INTO dm_settings (user_a, user_b, encryption_mode) VALUES (?, ?, ?)`
    ).run(a, b, mode);
}

// DM AES keys (client-generated, PGP-wrapped per participant)
function getDmKey(userA, userB, userId) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    return db.prepare(
        'SELECT * FROM dm_keys WHERE user_a = ? AND user_b = ? AND user_id = ?'
    ).get(a, b, userId);
}

const setDmKeys = db.transaction((userA, userB, entries) => {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    const stmt = db.prepare(
        'INSERT OR REPLACE INTO dm_keys (user_a, user_b, user_id, wrapped_key) VALUES (?, ?, ?, ?)'
    );
    for (const { userId, wrappedKey } of entries) {
        stmt.run(a, b, userId, wrappedKey);
    }
});

function markDmViewed(id) {
    db.prepare('UPDATE dms SET viewed = 1 WHERE id = ?').run(id);
}

function burnDm(id) {
    db.prepare("UPDATE dms SET content = '', viewed = 1 WHERE id = ?").run(id);
}

function deleteExpiredDms() {
    db.prepare("DELETE FROM dms WHERE expires_at IS NOT NULL AND expires_at < datetime('now')").run();
}

// Pins
function pinMessage(messageId, channelId, userId) {
    try {
        db.prepare(
            'INSERT INTO pins (message_id, channel_id, pinned_by) VALUES (?, ?, ?)'
        ).run(messageId, channelId, userId);
        return true;
    } catch (err) {
        if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') return false; // already pinned
        throw err;
    }
}

function unpinMessage(messageId) {
    return db.prepare('DELETE FROM pins WHERE message_id = ?').run(messageId).changes > 0;
}

function getPin(messageId) {
    return db.prepare('SELECT * FROM pins WHERE message_id = ?').get(messageId);
}

function getPins(channelId, limit = 50) {
    return db.prepare(
        `SELECT p.message_id, p.pinned_by, p.pinned_at, m.user_id, m.content, m.created_at
         FROM pins p JOIN messages m ON m.id = p.message_id
         WHERE p.channel_id = ?
         ORDER BY p.pinned_at DESC LIMIT ?`
    ).all(channelId, limit);
}

// Dead man's switch
function touchLastActive(userId) {
    db.prepare("UPDATE users SET last_active = datetime('now') WHERE id = ?").run(userId);
}

function getUsersForDeletion() {
    return db.prepare(
        `SELECT id FROM users
         WHERE auto_delete_after_days IS NOT NULL
           AND last_active < datetime('now', '-' || auto_delete_after_days || ' days')`
    ).all();
}

const deleteUserAndData = db.transaction((userId) => {
    db.prepare('DELETE FROM dms WHERE sender_id = ? OR recipient_id = ?').run(userId, userId);
    db.prepare('DELETE FROM messages WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM memberships WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM user_keys WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM channel_keys WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM dm_settings WHERE user_a = ? OR user_b = ?').run(userId, userId);
    db.prepare('DELETE FROM dm_keys WHERE user_a = ? OR user_b = ?').run(userId, userId);
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
});

module.exports = {
    createServer,
    getServer,
    getServersForUser,
    updateServer,
    deleteServer,
    deleteServerAdmin,
    createChannel,
    getChannelsForServer,
    deleteChannel,
    getChannel,
    updateChannel,
    reorderChannels,
    channelCount,
    createMessage,
    getMessages,
    getMessagesAfter,
    editMessage,
    deleteMessage,
    deleteMessageAsOwner,
    getMessage,
    joinServer,
    leaveServer,
    getMembers,
    isMember,
    removeMember,
    createInvite,
    getInvite,
    getRawInvite,
    getInvitesForServer,
    deleteInvite,
    useInvite,
    upsertUser,
    getCachedUser,
    setUserKey,
    getUserKey,
    verifyUserKey,
    setChannelKey,
    getChannelKey,
    getChannelKeyVersion,
    rotateChannelKeys,
    deleteChannelKey,
    deleteExpiredMessages,
    burnMessage,
    claimBurn,
    claimBurnDm,
    markMessageViewed,
    createDm,
    getDm,
    getDms,
    getDmsAfter,
    getDmUnreadCounts,
    markDmRead,
    getChannelLastRead,
    markChannelRead,
    getChannelUnreadCounts,
    getDmConversations,
    pinMessage,
    unpinMessage,
    getPin,
    getPins,
    getDmSettings,
    setDmEncryptionMode,
    getDmKey,
    setDmKeys,
    markDmViewed,
    burnDm,
    deleteExpiredDms,
    touchLastActive,
    getUsersForDeletion,
    deleteUserAndData,
    createReport,
    getReportsForServer,
    getAllReports,
    getReport,
    deleteReport,
};

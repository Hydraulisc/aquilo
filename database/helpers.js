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
function createMessage(channelId, userId, content) {
    const id = crypto.randomUUID();
    const ts = coarseTimestamp();
    db.prepare(
        'INSERT INTO messages (id, channel_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, channelId, userId, content, ts);
    return { id, channel_id: channelId, user_id: userId, content, created_at: ts };
}

function getMessages(channelId, limit = 50, before = null) {
    limit = Math.min(Math.max(1, limit), 50);
    if (before) {
        return db.prepare(
            `SELECT * FROM messages
             WHERE channel_id = ? AND rowid < (SELECT rowid FROM messages WHERE id = ?)
             ORDER BY rowid DESC LIMIT ?`
        ).all(channelId, before, limit);
    }
    return db.prepare(
        'SELECT * FROM messages WHERE channel_id = ? ORDER BY rowid DESC LIMIT ?'
    ).all(channelId, limit);
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
function createReport(messageId, channelId, serverId, reporterId, content) {
    const id = crypto.randomUUID();
    db.prepare(
        'INSERT INTO reports (id, message_id, channel_id, server_id, reporter_id, content) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, messageId, channelId, serverId, reporterId, content);
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

// Server keys (AES-256-GCM)
function setServerKey(serverId, aesKey) {
    db.prepare(
        `INSERT OR REPLACE INTO server_keys (server_id, aes_key) VALUES (?, ?)`
    ).run(serverId, aesKey);
}

function getServerKey(serverId) {
    return db.prepare('SELECT * FROM server_keys WHERE server_id = ?').get(serverId);
}

function encryptMessage(plaintext, hexKey) {
    const key = Buffer.from(hexKey, 'hex');
    try {
        const iv = crypto.randomBytes(12);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
        const tag = cipher.getAuthTag();
        return Buffer.concat([iv, tag, encrypted]).toString('base64');
    } finally {
        key.fill(0);
    }
}

function decryptMessage(b64ciphertext, hexKey) {
    const key = Buffer.from(hexKey, 'hex');
    const buf = Buffer.from(b64ciphertext, 'base64');
    const iv = buf.slice(0, 12);
    const tag = buf.slice(12, 28);
    const encrypted = buf.slice(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    try {
        return decipher.update(encrypted, null, 'utf8') + decipher.final('utf8');
    } finally {
        key.fill(0);
    }
}

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
    setServerKey,
    getServerKey,
    encryptMessage,
    decryptMessage,
    createReport,
    getReportsForServer,
    getAllReports,
    getReport,
    deleteReport,
};

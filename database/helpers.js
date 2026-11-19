const crypto = require('crypto');
const db = require('./init');

const NOW = db.NOW;

// Explicit column lists: `seq` is an internal ordering column and shouldn't leak into API responses.
const MSG_COLS = 'id, channel_id, user_id, content, frank, created_at, edited_at, expires_at, burn_after_read, viewed, reply_to_id';
const DM_COLS = 'id, sender_id, recipient_id, content, encryption_mode, expires_at, burn_after_read, viewed, reply_to_id, created_at';

function coarseTimestamp() {
    const now = new Date();
    now.setSeconds(0, 0);
    now.setMinutes(Math.floor(now.getMinutes() / 5) * 5);
    return now.toISOString().replace('T', ' ').slice(0, 16);
}

// it is good practice to keep all db helper functions in here instead of doing this in api.js
// you can just import like this: const db = require('../database/helpers');
// and use the helper function like this: await db.createServer()
// every helper is async (PostgreSQL), so always await the result

// Servers
const createServer = db.transaction(async (t, name, ownerId, icon = null) => {
    const serverId = crypto.randomUUID();
    const channelId = crypto.randomUUID();
    const membershipId = crypto.randomUUID();

    await t.run(
        'INSERT INTO servers (id, name, icon, owner_id) VALUES ($1, $2, $3, $4)',
        [serverId, name, icon, ownerId]
    );

    await t.run(
        'INSERT INTO channels (id, server_id, name, position) VALUES ($1, $2, $3, 0)',
        [channelId, serverId, 'general']
    );

    await t.run(
        'INSERT INTO memberships (id, server_id, user_id) VALUES ($1, $2, $3)',
        [membershipId, serverId, ownerId]
    );

    return { serverId, channelId };
});

function getServer(id) {
    return db.get('SELECT * FROM servers WHERE id = $1', [id]);
}

function getServersForUser(userId) {
    return db.all(
        `SELECT s.* FROM servers s
         JOIN memberships m ON m.server_id = s.id
         WHERE m.user_id = $1
         ORDER BY s.created_at`,
        [userId]
    );
}

async function updateServer(id, userId, { name, icon }) {
    const sets = [];
    const params = [];
    if (name !== undefined) { params.push(name); sets.push(`name = $${params.length}`); }
    if (icon !== undefined) { params.push(icon); sets.push(`icon = $${params.length}`); }
    if (sets.length === 0) return false;
    params.push(id, userId);
    const changes = await db.run(
        `UPDATE servers SET ${sets.join(', ')} WHERE id = $${params.length - 1} AND owner_id = $${params.length}`,
        params
    );
    return changes > 0;
}

const deleteServer = db.transaction(async (t, id, userId) => {
    await t.run('DELETE FROM reports WHERE server_id = $1', [id]);
    return (await t.run('DELETE FROM servers WHERE id = $1 AND owner_id = $2', [id, userId])) > 0;
});

const deleteServerAdmin = db.transaction(async (t, id) => {
    await t.run('DELETE FROM reports WHERE server_id = $1', [id]);
    return (await t.run('DELETE FROM servers WHERE id = $1', [id])) > 0;
});

// Channels
async function createChannel(serverId, name) {
    const id = crypto.randomUUID();
    const row = await db.get(
        `INSERT INTO channels (id, server_id, name, position)
         VALUES ($1, $2, $3, (SELECT COALESCE(MAX(position), -1) + 1 FROM channels WHERE server_id = $2))
         RETURNING position`,
        [id, serverId, name]
    );
    return { id, server_id: serverId, name, position: row.position };
}

function getChannelsForServer(serverId) {
    return db.all('SELECT * FROM channels WHERE server_id = $1 ORDER BY position', [serverId]);
}

async function deleteChannel(id) {
    return (await db.run('DELETE FROM channels WHERE id = $1', [id])) > 0;
}

function getChannel(id) {
    return db.get('SELECT * FROM channels WHERE id = $1', [id]);
}

async function updateChannel(id, name) {
    return (await db.run('UPDATE channels SET name = $1 WHERE id = $2', [name, id])) > 0;
}

const reorderChannels = db.transaction(async (t, serverId, orderedIds) => {
    for (let i = 0; i < orderedIds.length; i++) {
        await t.run(
            'UPDATE channels SET position = $1 WHERE id = $2 AND server_id = $3',
            [i, orderedIds[i], serverId]
        );
    }
});

async function channelCount(serverId) {
    return (await db.get('SELECT COUNT(*) AS count FROM channels WHERE server_id = $1', [serverId])).count;
}

// Messages
async function createMessage(id, channelId, userId, content, opts = {}) {
    const ts = coarseTimestamp();
    await db.run(
        `INSERT INTO messages (id, channel_id, user_id, content, frank, expires_at, burn_after_read, reply_to_id, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [id, channelId, userId, content, opts.frank || null, opts.expiresAt || null,
         opts.burnAfterRead ? 1 : 0, opts.replyToId || null, ts]
    );
    return { id, channel_id: channelId, user_id: userId, content, frank: opts.frank || null,
             expires_at: opts.expiresAt || null, burn_after_read: opts.burnAfterRead ? 1 : 0,
             reply_to_id: opts.replyToId || null, created_at: ts };
}

function getMessages(channelId, limit = 50, before = null, after = null) {
    limit = Math.min(Math.max(1, limit), 50);
    if (before) {
        return db.all(
            `SELECT ${MSG_COLS} FROM messages
             WHERE channel_id = $1 AND seq < (SELECT seq FROM messages WHERE id = $2)
             ORDER BY seq DESC LIMIT $3`,
            [channelId, before, limit]
        );
    }
    if (after) {
        return db.all(
            `SELECT ${MSG_COLS} FROM messages
             WHERE channel_id = $1 AND seq > (SELECT seq FROM messages WHERE id = $2)
             ORDER BY seq ASC LIMIT $3`,
            [channelId, after, limit]
        );
    }
    return db.all(
        `SELECT ${MSG_COLS} FROM messages WHERE channel_id = $1 ORDER BY seq DESC LIMIT $2`,
        [channelId, limit]
    );
}

function getMessagesAfter(channelId, afterId, limit = 50) {
    limit = Math.min(Math.max(1, limit), 50);
    return db.all(
        `SELECT ${MSG_COLS} FROM messages
         WHERE channel_id = $1 AND created_at >= (SELECT created_at FROM messages WHERE id = $2)
           AND id != $2
         ORDER BY created_at ASC, seq ASC LIMIT $3`,
        [channelId, afterId, limit]
    );
}

async function editMessage(id, userId, content) {
    const changes = await db.run(
        'UPDATE messages SET content = $1, edited_at = $2 WHERE id = $3 AND user_id = $4',
        [content, coarseTimestamp(), id, userId]
    );
    return changes > 0;
}

async function deleteMessage(id, userId) {
    const changes = await db.run('DELETE FROM messages WHERE id = $1 AND user_id = $2', [id, userId]);
    return changes > 0;
}

async function deleteMessageAsOwner(id) {
    return (await db.run('DELETE FROM messages WHERE id = $1', [id])) > 0;
}

function getMessage(id) {
    return db.get(`SELECT ${MSG_COLS} FROM messages WHERE id = $1`, [id]);
}

// Memberships
async function joinServer(serverId, userId) {
    const id = crypto.randomUUID();
    const changes = await db.run(
        `INSERT INTO memberships (id, server_id, user_id) VALUES ($1, $2, $3)
         ON CONFLICT (server_id, user_id) DO NOTHING`,
        [id, serverId, userId]
    );
    return changes > 0; // false = already a member
}

async function leaveServer(serverId, userId) {
    const changes = await db.run(
        'DELETE FROM memberships WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    return changes > 0;
}

function getMembers(serverId) {
    return db.all('SELECT * FROM memberships WHERE server_id = $1 ORDER BY joined_at', [serverId]);
}

async function isMember(serverId, userId) {
    return !!(await db.get(
        'SELECT 1 FROM memberships WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    ));
}

async function removeMember(serverId, userId) {
    const changes = await db.run(
        'DELETE FROM memberships WHERE server_id = $1 AND user_id = $2',
        [serverId, userId]
    );
    return changes > 0;
}

// Invites
async function createInvite(serverId, userId, { maxUses = null, expiresAt = null } = {}) {
    const code = crypto.randomBytes(4).toString('hex'); // 8 hex chars
    await db.run(
        'INSERT INTO invites (code, server_id, created_by, max_uses, expires_at) VALUES ($1, $2, $3, $4, $5)',
        [code, serverId, userId, maxUses, expiresAt]
    );
    return code;
}

async function getInvite(code) {
    const invite = await db.get('SELECT * FROM invites WHERE code = $1', [code]);
    if (!invite) return null;
    if (invite.expires_at && new Date(invite.expires_at) < new Date()) return null;
    if (invite.max_uses !== null && invite.uses >= invite.max_uses) return null;
    return invite;
}

function getRawInvite(code) {
    return db.get('SELECT * FROM invites WHERE code = $1', [code]);
}

function getInvitesForServer(serverId) {
    return db.all('SELECT * FROM invites WHERE server_id = $1 ORDER BY created_at', [serverId]);
}

async function deleteInvite(code) {
    return (await db.run('DELETE FROM invites WHERE code = $1', [code])) > 0;
}

async function useInvite(code) {
    return (await db.run('UPDATE invites SET uses = uses + 1 WHERE code = $1', [code])) > 0;
}

// Reports
async function createReport(messageId, channelId, serverId, reporterId, content, frankVerified = null) {
    const id = crypto.randomUUID();
    await db.run(
        'INSERT INTO reports (id, message_id, channel_id, server_id, reporter_id, content, frank_verified) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [id, messageId, channelId, serverId, reporterId, content, frankVerified]
    );
    return id;
}

function getReportsForServer(serverId) {
    return db.all('SELECT * FROM reports WHERE server_id = $1 ORDER BY reported_at DESC', [serverId]);
}

function getAllReports() {
    return db.all(`
        SELECT r.*, s.name AS server_name, s.owner_id AS server_owner_id,
               c.name AS channel_name, m.user_id AS sender_id
        FROM reports r
        JOIN servers s ON s.id = r.server_id
        JOIN channels c ON c.id = r.channel_id
        LEFT JOIN messages m ON m.id = r.message_id
        ORDER BY r.reported_at DESC
    `);
}

function getReport(id) {
    return db.get('SELECT * FROM reports WHERE id = $1', [id]);
}

async function deleteReport(id) {
    return (await db.run('DELETE FROM reports WHERE id = $1', [id])) > 0;
}

// Users cache
async function upsertUser(id, username, pfp) {
    await db.run(
        `INSERT INTO users (id, username, pfp, updated_at) VALUES ($1, $2, $3, ${NOW})
         ON CONFLICT (id) DO UPDATE SET username = EXCLUDED.username, pfp = EXCLUDED.pfp, updated_at = EXCLUDED.updated_at`,
        [id, username, pfp || null]
    );
}

function getCachedUser(id) {
    return db.get('SELECT * FROM users WHERE id = $1', [id]);
}

// PGP Keys
async function setUserKey(userId, publicKey, fingerprint) {
    await db.run(
        `INSERT INTO user_keys (user_id, public_key, fingerprint, verified_at, created_at)
         VALUES ($1, $2, $3, NULL, ${NOW})
         ON CONFLICT (user_id) DO UPDATE SET public_key = EXCLUDED.public_key,
             fingerprint = EXCLUDED.fingerprint, verified_at = NULL, created_at = EXCLUDED.created_at`,
        [userId, publicKey, fingerprint]
    );
}

function getUserKey(userId) {
    return db.get('SELECT * FROM user_keys WHERE user_id = $1', [userId]);
}

async function verifyUserKey(userId) {
    await db.run(`UPDATE user_keys SET verified_at = ${NOW} WHERE user_id = $1`, [userId]);
}

// Channel keys (per-channel client-generated, PGP-wrapped)
async function setChannelKey(channelId, userId, wrappedKey, version = 1) {
    await db.run(
        `INSERT INTO channel_keys (channel_id, user_id, wrapped_key, key_version)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (channel_id, user_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key,
             key_version = EXCLUDED.key_version`,
        [channelId, userId, wrappedKey, version]
    );
}

function getChannelKey(channelId, userId) {
    return db.get(
        'SELECT * FROM channel_keys WHERE channel_id = $1 AND user_id = $2',
        [channelId, userId]
    );
}

async function getChannelKeyVersion(channelId) {
    const row = await db.get(
        'SELECT MAX(key_version) AS version FROM channel_keys WHERE channel_id = $1',
        [channelId]
    );
    return row?.version ?? 0;
}

const rotateChannelKeys = db.transaction(async (t, channelId, newVersion, entries) => {
    await t.run('DELETE FROM channel_keys WHERE channel_id = $1', [channelId]);
    for (const { userId, wrappedKey } of entries) {
        await t.run(
            'INSERT INTO channel_keys (channel_id, user_id, wrapped_key, key_version) VALUES ($1, $2, $3, $4)',
            [channelId, userId, wrappedKey, newVersion]
        );
    }
});

async function deleteChannelKey(channelId, userId) {
    await db.run('DELETE FROM channel_keys WHERE channel_id = $1 AND user_id = $2', [channelId, userId]);
}

// Message expiry & burn-after-read
async function deleteExpiredMessages() {
    await db.run(`DELETE FROM messages WHERE expires_at IS NOT NULL AND expires_at < ${NOW}`);
}

async function burnMessage(id) {
    await db.run("UPDATE messages SET content = '', viewed = 1 WHERE id = $1", [id]);
}

// Exactly one reader gets content, then content is destroyed
// a single UPDATE is atomic, so concurrent readers can't both win
async function claimBurn(id) {
    const changes = await db.run(
        "UPDATE messages SET viewed = 1, content = '' WHERE id = $1 AND burn_after_read = 1 AND viewed = 0",
        [id]
    );
    return changes > 0;
}

async function claimBurnDm(id) {
    const changes = await db.run(
        "UPDATE dms SET viewed = 1, content = '' WHERE id = $1 AND burn_after_read = 1 AND viewed = 0",
        [id]
    );
    return changes > 0;
}

async function markMessageViewed(id) {
    await db.run('UPDATE messages SET viewed = 1 WHERE id = $1', [id]);
}

// DMs
async function createDm(senderId, recipientId, content, encryptionMode = 'none', opts = {}) {
    const id = crypto.randomUUID();
    await db.run(
        `INSERT INTO dms (id, sender_id, recipient_id, content, encryption_mode, expires_at, burn_after_read, reply_to_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [id, senderId, recipientId, content, encryptionMode,
         opts.expiresAt || null, opts.burnAfterRead ? 1 : 0, opts.replyToId || null]
    );
    return { id, sender_id: senderId, recipient_id: recipientId, content,
             encryption_mode: encryptionMode, reply_to_id: opts.replyToId || null,
             created_at: new Date().toISOString() };
}

function getDm(id) {
    return db.get(`SELECT ${DM_COLS} FROM dms WHERE id = $1`, [id]);
}

function getDms(userId, withUserId, limit = 50, before = null) {
    limit = Math.min(Math.max(1, limit), 50);
    if (before) {
        return db.all(
            `SELECT ${DM_COLS} FROM dms
             WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
               AND created_at < (SELECT created_at FROM dms WHERE id = $3)
             ORDER BY created_at DESC, seq DESC LIMIT $4`,
            [userId, withUserId, before, limit]
        );
    }
    return db.all(
        `SELECT ${DM_COLS} FROM dms
         WHERE (sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1)
         ORDER BY created_at DESC, seq DESC LIMIT $3`,
        [userId, withUserId, limit]
    );
}

function getDmsAfter(userId, withUserId, afterId, limit = 50) {
    limit = Math.min(Math.max(1, limit), 50);
    return db.all(
        `SELECT ${DM_COLS} FROM dms
         WHERE ((sender_id = $1 AND recipient_id = $2) OR (sender_id = $2 AND recipient_id = $1))
           AND created_at >= (SELECT created_at FROM dms WHERE id = $3)
           AND id != $3
         ORDER BY created_at ASC, seq ASC LIMIT $4`,
        [userId, withUserId, afterId, limit]
    );
}

function getDmUnreadCounts(userId) {
    return db.all(
        `SELECT d.sender_id AS partner_id, COUNT(*) AS unread
         FROM dms d
         LEFT JOIN dm_reads r ON r.user_id = $1 AND r.partner_id = d.sender_id
         WHERE d.recipient_id = $1
           AND d.created_at > COALESCE(r.last_read_at, '1970-01-01')
         GROUP BY d.sender_id`,
        [userId]
    );
}

async function markDmRead(userId, partnerId) {
    await db.run(
        `INSERT INTO dm_reads (user_id, partner_id, last_read_at) VALUES ($1, $2, ${NOW})
         ON CONFLICT (user_id, partner_id) DO UPDATE SET last_read_at = ${NOW}`,
        [userId, partnerId]
    );
}

// Channel read tracking (mirrors dm_reads)
async function getChannelLastRead(userId, channelId) {
    const row = await db.get(
        'SELECT last_read_at FROM channel_reads WHERE user_id = $1 AND channel_id = $2',
        [userId, channelId]
    );
    return row?.last_read_at || '1970-01-01';
}

async function markChannelRead(userId, channelId) {
    await db.run(
        `INSERT INTO channel_reads (user_id, channel_id, last_read_at) VALUES ($1, $2, ${NOW})
         ON CONFLICT (user_id, channel_id) DO UPDATE SET last_read_at = ${NOW}`,
        [userId, channelId]
    );
}

function getChannelUnreadCounts(userId, serverId) {
    return db.all(
        `SELECT m.channel_id, COUNT(*) AS unread
         FROM messages m
         JOIN channels c ON c.id = m.channel_id
         LEFT JOIN channel_reads r ON r.user_id = $1 AND r.channel_id = m.channel_id
         WHERE c.server_id = $2
           AND m.user_id != $1
           AND m.created_at > COALESCE(r.last_read_at, '1970-01-01')
         GROUP BY m.channel_id`,
        [userId, serverId]
    );
}

function getDmConversations(userId) {
    return db.all(
        `SELECT DISTINCT CASE WHEN sender_id = $1 THEN recipient_id ELSE sender_id END AS partner_id
         FROM dms WHERE sender_id = $1 OR recipient_id = $1`,
        [userId]
    );
}

async function getDmSettings(userA, userB) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    return (await db.get('SELECT * FROM dm_settings WHERE user_a = $1 AND user_b = $2', [a, b]))
        || { user_a: a, user_b: b, encryption_mode: 'none' };
}

async function setDmEncryptionMode(userA, userB, mode) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    await db.run(
        `INSERT INTO dm_settings (user_a, user_b, encryption_mode) VALUES ($1, $2, $3)
         ON CONFLICT (user_a, user_b) DO UPDATE SET encryption_mode = EXCLUDED.encryption_mode`,
        [a, b, mode]
    );
}

// DM AES keys (client-generated, PGP-wrapped per participant)
function getDmKey(userA, userB, userId) {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    return db.get(
        'SELECT * FROM dm_keys WHERE user_a = $1 AND user_b = $2 AND user_id = $3',
        [a, b, userId]
    );
}

const setDmKeys = db.transaction(async (t, userA, userB, entries) => {
    const [a, b] = userA < userB ? [userA, userB] : [userB, userA];
    for (const { userId, wrappedKey } of entries) {
        await t.run(
            `INSERT INTO dm_keys (user_a, user_b, user_id, wrapped_key) VALUES ($1, $2, $3, $4)
             ON CONFLICT (user_a, user_b, user_id) DO UPDATE SET wrapped_key = EXCLUDED.wrapped_key,
                 created_at = ${NOW}`,
            [a, b, userId, wrappedKey]
        );
    }
});

async function markDmViewed(id) {
    await db.run('UPDATE dms SET viewed = 1 WHERE id = $1', [id]);
}

async function burnDm(id) {
    await db.run("UPDATE dms SET content = '', viewed = 1 WHERE id = $1", [id]);
}

async function deleteExpiredDms() {
    await db.run(`DELETE FROM dms WHERE expires_at IS NOT NULL AND expires_at < ${NOW}`);
}

// Pins
async function pinMessage(messageId, channelId, userId) {
    const changes = await db.run(
        `INSERT INTO pins (message_id, channel_id, pinned_by) VALUES ($1, $2, $3)
         ON CONFLICT (message_id) DO NOTHING`,
        [messageId, channelId, userId]
    );
    return changes > 0; // false = already pinned
}

async function unpinMessage(messageId) {
    return (await db.run('DELETE FROM pins WHERE message_id = $1', [messageId])) > 0;
}

function getPin(messageId) {
    return db.get('SELECT * FROM pins WHERE message_id = $1', [messageId]);
}

function getPins(channelId, limit = 50) {
    return db.all(
        `SELECT p.message_id, p.pinned_by, p.pinned_at, m.user_id, m.content, m.created_at
         FROM pins p JOIN messages m ON m.id = p.message_id
         WHERE p.channel_id = $1
         ORDER BY p.pinned_at DESC LIMIT $2`,
        [channelId, limit]
    );
}

// Dead man's switch
async function touchLastActive(userId) {
    await db.run(`UPDATE users SET last_active = ${NOW} WHERE id = $1`, [userId]);
}

function getUsersForDeletion() {
    return db.all(
        `SELECT id FROM users
         WHERE auto_delete_after_days IS NOT NULL
           AND last_active < to_char((now() AT TIME ZONE 'UTC') - make_interval(days => auto_delete_after_days),
                                     'YYYY-MM-DD HH24:MI:SS')`
    );
}

const deleteUserAndData = db.transaction(async (t, userId) => {
    await t.run('DELETE FROM dms WHERE sender_id = $1 OR recipient_id = $1', [userId]);
    await t.run('DELETE FROM messages WHERE user_id = $1', [userId]);
    await t.run('DELETE FROM memberships WHERE user_id = $1', [userId]);
    await t.run('DELETE FROM user_keys WHERE user_id = $1', [userId]);
    await t.run('DELETE FROM channel_keys WHERE user_id = $1', [userId]);
    await t.run('DELETE FROM dm_settings WHERE user_a = $1 OR user_b = $1', [userId]);
    await t.run('DELETE FROM dm_keys WHERE user_a = $1 OR user_b = $1', [userId]);
    await t.run('DELETE FROM users WHERE id = $1', [userId]);
});

module.exports = {
    ready: db.ready,
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

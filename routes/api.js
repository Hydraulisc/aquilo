const express = require('express');
const router = express.Router();
const { sanitize } = require('../middleware/sanitize');
const { timingJitter, requireInstanceAdmin } = require('../middleware/security');
const db = require('../database/helpers');
const { resolveUser } = require('../utils/resolveUser');
const openpgp = require('openpgp');
const crypto = require('crypto');
const limits = require('../middleware/rateLimit');
const { parseUserId } = require('../utils/parseId');
const typing = require('../utils/typing');
const { MESSAGE_LIMIT, MAX_MESSAGE_LEN, MAX_EDIT_LEN, MAX_DM_LEN, MAX_NAME_LEN, INVITE_MAX_USES_CAP } = require('../constants');

function requireAuth(req, res, next) {
    if (!req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

router.use(requireAuth);
router.use(limits.general);
router.use((req, res, next) => { if (req.body === undefined) req.body = {}; next(); });

// Servers
router.post('/servers', async (req, res) => {
    const name = sanitize((req.body.name || '').trim());
    if (!name || name.length > MAX_NAME_LEN) return res.status(400).json({ error: 'Invalid server name' });

    const icon = req.body.icon ? sanitize(req.body.icon.trim()) : null;
    const { serverId, channelId } = await db.createServer(name, req.session.user.id, icon);
    res.status(201).json({ id: serverId, channelId });
});

router.get('/servers', async (req, res) => {
    const servers = await db.getServersForUser(req.session.user.id);
    res.json(servers);
});

router.patch('/servers/:serverId', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const fields = {};
    if (req.body.name !== undefined) {
        const name = sanitize((req.body.name || '').trim());
        if (!name || name.length > MAX_NAME_LEN) return res.status(400).json({ error: 'Invalid server name' });
        fields.name = name;
    }
    if (req.body.icon !== undefined) {
        fields.icon = req.body.icon ? sanitize(req.body.icon.trim()) : null;
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const updated = await db.updateServer(req.params.serverId, req.session.user.id, fields);
    if (!updated) return res.status(500).json({ error: 'Update failed' });
    res.json({ success: true, ...fields });
});

router.delete('/servers/:serverId', async (req, res) => {
    const deleted = await db.deleteServer(req.params.serverId, req.session.user.id);
    if (!deleted) return res.status(403).json({ error: 'Forbidden or not found' });
    res.json({ success: true });
});

// Channels
router.post('/servers/:serverId/channels', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const name = sanitize((req.body.name || '').trim());
    if (!name || name.length > MAX_NAME_LEN) return res.status(400).json({ error: 'Invalid channel name' });

    const channel = await db.createChannel(req.params.serverId, name);
    res.status(201).json(channel);
});

router.get('/servers/:serverId/channels', async (req, res) => {
    if (!(await db.isMember(req.params.serverId, req.session.user.id))) {
        return res.status(403).json({ error: 'Not a member' });
    }
    const channels = await db.getChannelsForServer(req.params.serverId);
    const unreadMap = new Map(
        (await db.getChannelUnreadCounts(req.session.user.id, req.params.serverId))
            .map(r => [r.channel_id, r.unread])
    );
    res.json(channels.map(c => ({ ...c, unread: unreadMap.get(c.id) || 0 })));
});

router.patch('/channels/:channelId', async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const server = await db.getServer(channel.server_id);
    if (!server || server.owner_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const name = sanitize((req.body.name || '').trim());
    if (!name || name.length > MAX_NAME_LEN) return res.status(400).json({ error: 'Invalid channel name' });

    const updated = await db.updateChannel(req.params.channelId, name);
    if (!updated) return res.status(500).json({ error: 'Update failed' });
    res.json({ success: true, name });
});

router.delete('/channels/:channelId', async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const server = await db.getServer(channel.server_id);
    if (!server || server.owner_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (await db.channelCount(channel.server_id) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last channel' });
    }

    await db.deleteChannel(req.params.channelId);
    res.json({ success: true });
});

router.patch('/servers/:serverId/channels/reorder', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const orderedIds = req.body.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return res.status(400).json({ error: 'Invalid channel order' });
    }

    const existing = await db.getChannelsForServer(req.params.serverId);
    const existingIds = new Set(existing.map(c => c.id));
    if (orderedIds.length !== existingIds.size || !orderedIds.every(id => existingIds.has(id))) {
        return res.status(400).json({ error: 'Channel list mismatch' });
    }

    await db.reorderChannels(req.params.serverId, orderedIds);
    res.json({ success: true });
});

// Messages: client encrypts/decrypts, server stores ciphertext as-is
router.get('/channels/:channelId/messages', timingJitter, async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!(await db.isMember(channel.server_id, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const limit = parseInt(req.query.limit) || MESSAGE_LIMIT;
    const before = req.query.before || null;
    const after = req.query.after || null;
    const messages = after
        ? await db.getMessagesAfter(req.params.channelId, after, limit)
        : await db.getMessages(req.params.channelId, limit, before);

    const lastRead = await db.getChannelLastRead(req.session.user.id, req.params.channelId);
    await db.markChannelRead(req.session.user.id, req.params.channelId);

    const result = await Promise.all(messages.map(async (m) => {
        m = { ...m, unread: m.created_at > lastRead && m.user_id !== req.session.user.id };
        // Burn-after-read: exactly one non-sender gets the content
        if (m.burn_after_read && m.user_id !== req.session.user.id) {
            const won = await db.claimBurn(m.id);
            m = won ? { ...m, burned: true } : { ...m, content: '', burned: true };
        }
        const user = await resolveUser(m.user_id);
        return { ...m, user: { username: user.username, ownPfp: user.ownPfp } };
    }));

    if (after) {
        const typingIds = typing.getTyping(`chan:${req.params.channelId}`, req.session.user.id);
        const typingUsers = await Promise.all(typingIds.map(async id => {
            const u = await resolveUser(id);
            return { userId: id, username: u.username };
        }));
        return res.json({ messages: result, typing: typingUsers });
    }
    res.json(result);
});

router.post('/channels/:channelId/messages', limits.messages, timingJitter, async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!(await db.isMember(channel.server_id, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const content = sanitize((req.body.content || '').trim());
    if (!content || content.length > MAX_MESSAGE_LEN)
        return res.status(400).json({ error: 'Invalid message content' });

    let replyToId = null;
    if (req.body.replyToId) {
        const target = await db.getMessage(req.body.replyToId);
        if (!target || target.channel_id !== req.params.channelId)
            return res.status(400).json({ error: 'Reply target not found in this channel' });
        replyToId = target.id;
    }

    const expiresAt = req.body.expiresAt || null;
    const burnAfterRead = req.body.burnAfterRead ? 1 : 0;
    const messageId = crypto.randomUUID();
    const message = await db.createMessage(messageId, req.params.channelId, req.session.user.id, content, { expiresAt, burnAfterRead, replyToId });
    res.status(201).json(message);
});

router.post('/channels/:channelId/typing', async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!(await db.isMember(channel.server_id, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    typing.setTyping(`chan:${req.params.channelId}`, req.session.user.id);
    res.json({ success: true });
});

router.patch('/messages/:messageId', timingJitter, async (req, res) => {
    const content = sanitize((req.body.content || '').trim());
    if (!content || content.length > MAX_EDIT_LEN) {
        return res.status(400).json({ error: 'Invalid message content' });
    }

    const message = await db.getMessage(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.user_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    await db.editMessage(req.params.messageId, req.session.user.id, content);
    res.json({ success: true });
});

router.delete('/messages/:messageId', async (req, res) => {
    const message = await db.getMessage(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    if (message.user_id === req.session.user.id) {
        await db.deleteMessage(req.params.messageId, req.session.user.id);
        return res.json({ success: true });
    }

    const channel = await db.getChannel(message.channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const server = await db.getServer(channel.server_id);
    if (server && server.owner_id === req.session.user.id) {
        await db.deleteMessageAsOwner(req.params.messageId);
        return res.json({ success: true });
    }

    res.status(403).json({ error: 'Forbidden' });
});

// Pins
async function requirePinAccess(req, res) {
    const message = await db.getMessage(req.params.messageId);
    if (!message) { res.status(404).json({ error: 'Message not found' }); return null; }
    const channel = await db.getChannel(message.channel_id);
    if (!channel) { res.status(404).json({ error: 'Channel not found' }); return null; }
    if (!(await db.isMember(channel.server_id, req.session.user.id))) {
        res.status(403).json({ error: 'Not a member' }); return null;
    }
    return { message, channel, server: await db.getServer(channel.server_id) };
}

router.put('/messages/:messageId/pin', async (req, res) => {
    const ctx = await requirePinAccess(req, res);
    if (!ctx) return;
    const created = await db.pinMessage(ctx.message.id, ctx.channel.id, req.session.user.id);
    if (!created) return res.status(409).json({ error: 'Already pinned' });
    res.status(201).json({ success: true });
});

router.delete('/messages/:messageId/pin', async (req, res) => {
    const ctx = await requirePinAccess(req, res);
    if (!ctx) return;
    const pin = await db.getPin(ctx.message.id);
    if (!pin) return res.status(404).json({ error: 'Not pinned' });
    const isOwner = ctx.server && ctx.server.owner_id === req.session.user.id;
    if (pin.pinned_by !== req.session.user.id && !isOwner)
        return res.status(403).json({ error: 'Only the pinner or server owner can unpin' });
    await db.unpinMessage(ctx.message.id);
    res.json({ success: true });
});

router.get('/channels/:channelId/pins', async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!(await db.isMember(channel.server_id, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const pins = await db.getPins(req.params.channelId);
    const result = await Promise.all(pins.map(async (p) => {
        const user = await resolveUser(p.user_id);
        return { ...p, user: { username: user.username, ownPfp: user.ownPfp } };
    }));
    res.json(result);
});

// Members
router.get('/servers/:serverId/members', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!(await db.isMember(req.params.serverId, req.session.user.id))) {
        return res.status(403).json({ error: 'Not a member' });
    }

    const memberships = await db.getMembers(req.params.serverId);
    const members = await Promise.all(memberships.map(async (m) => {
        const user = await resolveUser(m.user_id);
        return {
            userId: m.user_id,
            username: user.username,
            ownPfp: user.ownPfp,
            joinedAt: m.joined_at,
            isOwner: m.user_id === server.owner_id
        };
    }));
    res.json(members);
});

router.delete('/servers/:serverId/members/:userId', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const targetUserId = parseUserId(req.params.userId);
    if (targetUserId === null) return res.status(400).json({ error: 'Invalid user id' });
    if (targetUserId === server.owner_id) {
        return res.status(400).json({ error: 'Cannot kick the server owner' });
    }

    const removed = await db.removeMember(req.params.serverId, targetUserId);
    if (!removed) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true });
});

router.post('/servers/:serverId/join', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const joined = await db.joinServer(req.params.serverId, req.session.user.id);
    if (!joined) return res.status(409).json({ error: 'Already a member' });
    res.status(201).json({ success: true });
});

router.post('/servers/:serverId/leave', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id === req.session.user.id) {
        return res.status(400).json({ error: 'Owner cannot leave — delete the server instead' });
    }

    const left = await db.leaveServer(req.params.serverId, req.session.user.id);
    if (!left) return res.status(404).json({ error: 'Not a member' });
    res.json({ success: true });
});

// Invites
router.post('/servers/:serverId/invites', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!(await db.isMember(req.params.serverId, req.session.user.id))) {
        return res.status(403).json({ error: 'Not a member' });
    }

    const body = req.body || {};
    let maxUses = null;
    if (body.maxUses !== undefined && body.maxUses !== null && body.maxUses !== '') {
        maxUses = parseInt(body.maxUses, 10);
        if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > INVITE_MAX_USES_CAP)
            return res.status(400).json({ error: 'maxUses must be between 1 and ' + INVITE_MAX_USES_CAP });
    }
    let expiresAt = null;
    if (body.expiresAt) {
        const d = new Date(body.expiresAt);
        if (Number.isNaN(d.getTime()) || d <= new Date())
            return res.status(400).json({ error: 'expiresAt must be a valid future date' });
        expiresAt = d.toISOString();
    }

    const code = await db.createInvite(req.params.serverId, req.session.user.id, { maxUses, expiresAt });
    res.status(201).json({ code });
});

router.get('/servers/:serverId/invites', async (req, res) => {
    const server = await db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const invites = await db.getInvitesForServer(req.params.serverId);
    res.json(invites);
});

router.delete('/invites/:code', async (req, res) => {
    // Use getInvitesForServer via server owner check — look up raw row first
    const rawInvite = await db.getRawInvite(req.params.code);
    if (!rawInvite) return res.status(404).json({ error: 'Invite not found' });

    const server = await db.getServer(rawInvite.server_id);
    if (!server || server.owner_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    await db.deleteInvite(req.params.code);
    res.json({ success: true });
});

router.post('/invites/:code/join', async (req, res) => {
    try {
        const invite = await db.getInvite(req.params.code);
        if (!invite) return res.status(404).json({ error: 'Invalid or expired invite' });

        const joined = await db.joinServer(invite.server_id, req.session.user.id);
        if (!joined) return res.status(409).json({ error: 'Already a member' });

        await db.useInvite(req.params.code);
        res.status(201).json({ success: true, serverId: invite.server_id });
    } catch (err) {
        console.error('Invite join error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PGP Keys
router.post('/keys/submit', limits.keySubmit, async (req, res) => {
    const armoredKey = (req.body.publicKey || '').trim();
    if (!armoredKey) return res.status(400).json({ error: 'Missing public key' });

    let key;
    try {
        key = await openpgp.readKey({ armoredKey });
    } catch {
        return res.status(400).json({ error: 'Invalid PGP public key' });
    }

    const fingerprint = key.getFingerprint();
    await db.setUserKey(req.session.user.id, armoredKey, fingerprint);

    const nonce = crypto.randomBytes(32).toString('hex');
    req.session.pgpChallenge = nonce;

    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: nonce }),
        encryptionKeys: key
    });

    res.json({ encryptedChallenge: encrypted });
});

router.post('/keys/verify', limits.keyVerify, async (req, res) => {
    if (!req.session.pgpChallenge) {
        return res.status(400).json({ error: 'No active challenge' });
    }
    const plaintext = (req.body.plaintext || '').trim();
    if (plaintext !== req.session.pgpChallenge) {
        return res.status(403).json({ error: 'Challenge mismatch' });
    }
    await db.verifyUserKey(req.session.user.id);
    delete req.session.pgpChallenge;
    res.json({ success: true });
});

router.get('/keys/me', async (req, res) => {
    const row = await db.getUserKey(req.session.user.id);
    res.json({ hasKey: !!row, verified: !!(row && row.verified_at) });
});

router.get('/servers/:serverId/challenge', limits.challenge, async (req, res) => {
    if (!(await db.isMember(req.params.serverId, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    const userKey = await db.getUserKey(req.session.user.id);
    if (!userKey?.verified_at) return res.status(403).json({ error: 'No verified key' });

    const nonce = crypto.randomBytes(32).toString('hex');
    req.session.serverChallenges = { ...(req.session.serverChallenges || {}), [req.params.serverId]: nonce };

    const pubKey = await openpgp.readKey({ armoredKey: userKey.public_key });
    const challenge = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: nonce }),
        encryptionKeys: pubKey
    });
    res.json({ challenge });
});

// Reports
router.post('/messages/:messageId/report', async (req, res) => {
    const message = await db.getMessage(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const channel = await db.getChannel(message.channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (!(await db.isMember(channel.server_id, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked — unlock before reporting' });

    const content = sanitize((req.body.content || '').trim());
    if (!content) return res.status(400).json({ error: 'Message content required for report' });

    await db.createReport(message.id, channel.id, channel.server_id, req.session.user.id, content);
    res.json({ success: true });
});

// Instance admin: all reports across every server
router.get('/reports', requireInstanceAdmin, async (req, res) => {
    const reports = await db.getAllReports();
    const result = await Promise.all(reports.map(async (r) => {
        const reporter = await resolveUser(r.reporter_id);
        const sender = r.sender_id ? await resolveUser(r.sender_id) : null;
        return {
            ...r,
            reporter_username: reporter.username,
            sender_username: sender?.username ?? null,
            is_server_owner: r.sender_id === r.server_owner_id
        };
    }));
    res.json(result);
});

// Dismiss report only
router.delete('/reports/:reportId', requireInstanceAdmin, async (req, res) => {
    const deleted = await db.deleteReport(req.params.reportId);
    if (!deleted) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true });
});

// Delete the reported message and dismiss the report
router.delete('/reports/:reportId/message', requireInstanceAdmin, async (req, res) => {
    const report = await db.getReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.message_id) await db.deleteMessageAsOwner(report.message_id);
    await db.deleteReport(report.id);
    res.json({ success: true });
});

// Kick the message sender from the server (cascade deletes server if sender is owner)
router.post('/reports/:reportId/kick', requireInstanceAdmin, async (req, res) => {
    const report = await db.getReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const message = await db.getMessage(report.message_id);
    if (!message) return res.status(404).json({ error: 'Message no longer exists' });
    const server = await db.getServer(report.server_id);
    if (server && message.user_id === server.owner_id) {
        await db.deleteServerAdmin(report.server_id); // cascades channels, messages, memberships, invites, reports
        return res.json({ success: true, serverDeleted: true });
    }
    await db.removeMember(report.server_id, message.user_id);
    await db.deleteReport(report.id);
    res.json({ success: true, serverDeleted: false });
});

router.post('/servers/:serverId/unlock', limits.challenge, async (req, res) => {
    const expected = req.session.serverChallenges?.[req.params.serverId];
    if (!expected) return res.status(400).json({ error: 'No active challenge' });
    if ((req.body.plaintext || '').trim() !== expected)
        return res.status(403).json({ error: 'Challenge mismatch' });
    req.session.unlockedServers = { ...(req.session.unlockedServers || {}), [req.params.serverId]: true };
    delete req.session.serverChallenges[req.params.serverId];
    res.json({ success: true });
});

// Channel keys
router.get('/channels/:channelId/key', async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!(await db.isMember(channel.server_id, req.session.user.id)))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const row = await db.getChannelKey(req.params.channelId, req.session.user.id);
    if (!row) return res.status(404).json({ error: 'No key distributed for this user' });
    res.json({ wrappedKey: row.wrapped_key, version: row.key_version });
});

router.post('/channels/:channelId/keys', async (req, res) => {
    const channel = await db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const server = await db.getServer(channel.server_id);
    if (!server || server.owner_id !== req.session.user.id)
        return res.status(403).json({ error: 'Only server owner can distribute channel keys' });

    const keys = req.body.keys;
    if (!Array.isArray(keys) || keys.length === 0)
        return res.status(400).json({ error: 'keys must be a non-empty array' });
    for (const k of keys) {
        if (!k.userId || !k.wrappedKey) return res.status(400).json({ error: 'Each key needs userId and wrappedKey' });
    }

    const rotate = req.body.rotate === true;
    if (rotate) {
        const newVersion = await db.getChannelKeyVersion(req.params.channelId) + 1;
        await db.rotateChannelKeys(req.params.channelId, newVersion, keys);
    } else {
        const version = await db.getChannelKeyVersion(req.params.channelId) || 1;
        for (const k of keys) await db.setChannelKey(req.params.channelId, k.userId, k.wrappedKey, version);
    }
    res.json({ success: true });
});

// Public key lookup (channel keys / DMs encryption)
router.get('/users/:userId/pubkey', async (req, res) => {
    const userId = parseUserId(req.params.userId);
    if (userId === null) return res.status(400).json({ error: 'Invalid user id' });
    const row = await db.getUserKey(userId);
    if (!row || !row.verified_at) return res.status(404).json({ error: 'No verified key for user' });
    res.json({ armoredKey: row.public_key, fingerprint: row.fingerprint });
});

// DM unlock (PGP challenge-response)
router.get('/dm/challenge', limits.challenge, async (req, res) => {
    const userKey = await db.getUserKey(req.session.user.id);
    if (!userKey?.verified_at) return res.status(403).json({ error: 'No verified key' });

    const nonce = crypto.randomBytes(32).toString('hex');
    req.session.dmChallenge = nonce;

    const pubKey = await openpgp.readKey({ armoredKey: userKey.public_key });
    const challenge = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: nonce }),
        encryptionKeys: pubKey
    });
    res.json({ challenge });
});

router.post('/dm/unlock', limits.challenge, async (req, res) => {
    const expected = req.session.dmChallenge;
    if (!expected) return res.status(400).json({ error: 'No active challenge' });
    if ((req.body.plaintext || '').trim() !== expected)
        return res.status(403).json({ error: 'Challenge mismatch' });
    req.session.dmUnlocked = true;
    delete req.session.dmChallenge;
    res.json({ success: true });
});

// DMs
router.get('/dms', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const conversations = await db.getDmConversations(req.session.user.id);
    const unreadMap = new Map((await db.getDmUnreadCounts(req.session.user.id)).map(r => [r.partner_id, r.unread]));
    const result = await Promise.all(conversations.map(async ({ partner_id }) => {
        const user = await resolveUser(partner_id);
        const settings = await db.getDmSettings(req.session.user.id, partner_id);
        const isSelf = partner_id === req.session.user.id;
        return { partnerId: partner_id,
                 username: isSelf ? 'Note to self' : user.username,
                 ownPfp: user.ownPfp,
                 encryptionMode: settings.encryption_mode,
                 unread: isSelf ? 0 : (unreadMap.get(partner_id) || 0) };
    }));
    res.json(result);
});

router.get('/dms/:userId/messages', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const partnerId = parseUserId(req.params.userId);
    if (partnerId === null) return res.status(400).json({ error: 'Invalid user id' });
    const limit = parseInt(req.query.limit) || MESSAGE_LIMIT;
    const before = req.query.before || null;
    const after = req.query.after || null;
    const messages = after
        ? await db.getDmsAfter(req.session.user.id, partnerId, after, limit)
        : await db.getDms(req.session.user.id, partnerId, limit, before);

    const result = await Promise.all(messages.map(async (m) => {
        if (m.burn_after_read && m.sender_id !== req.session.user.id) {
            const won = await db.claimBurnDm(m.id);
            return won ? { ...m, burned: true } : { ...m, content: '', burned: true };
        }
        return m;
    }));

    // Viewing the conversation marks it read
    await db.markDmRead(req.session.user.id, partnerId);

    if (after) {
        const typingIds = typing.getTyping(typing.dmScope(req.session.user.id, partnerId), req.session.user.id);
        const typingUsers = await Promise.all(typingIds.map(async id => {
            const u = await resolveUser(id);
            return { userId: id, username: u.username };
        }));
        return res.json({ messages: result, typing: typingUsers });
    }
    res.json(result);
});

router.post('/dms/:userId/typing', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const partnerId = parseUserId(req.params.userId);
    if (partnerId === null) return res.status(400).json({ error: 'Invalid user id' });
    typing.setTyping(typing.dmScope(req.session.user.id, partnerId), req.session.user.id);
    res.json({ success: true });
});

router.post('/dms/:userId', limits.messages, async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const recipientId = parseUserId(req.params.userId);
    if (recipientId === null) return res.status(400).json({ error: 'Invalid recipient' });

    const recipientKey = await db.getUserKey(recipientId);
    if (!recipientKey?.verified_at) return res.status(400).json({ error: 'Recipient has no verified key' });

    const content = (req.body.content || '').trim();
    if (!content || content.length > MAX_DM_LEN) return res.status(400).json({ error: 'Invalid content' });

    const encryptionMode = (await db.getDmSettings(req.session.user.id, recipientId)).encryption_mode;
    if (encryptionMode === 'pgp'
        && !(content.startsWith('-----BEGIN PGP MESSAGE-----') && content.includes('-----END PGP MESSAGE-----'))) {
        return res.status(400).json({ error: 'This conversation is PGP-only' });
    }
    let replyToId = null;
    if (req.body.replyToId) {
        const target = await db.getDm(req.body.replyToId);
        const pair = target && ((target.sender_id === req.session.user.id && target.recipient_id === recipientId)
            || (target.sender_id === recipientId && target.recipient_id === req.session.user.id));
        if (!pair) return res.status(400).json({ error: 'Reply target not found in this conversation' });
        replyToId = target.id;
    }

    const opts = {
        expiresAt: req.body.expiresAt || null,
        burnAfterRead: !!req.body.burnAfterRead,
        replyToId,
    };

    const dm = await db.createDm(req.session.user.id, recipientId, content, encryptionMode, opts);
    res.status(201).json(dm);
});

router.get('/dms/:userId/settings', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const partnerId = parseUserId(req.params.userId);
    if (partnerId === null) return res.status(400).json({ error: 'Invalid user id' });
    const settings = await db.getDmSettings(req.session.user.id, partnerId);
    res.json({ encryptionMode: settings.encryption_mode });
});

router.patch('/dms/:userId/settings', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const partnerId = parseUserId(req.params.userId);
    if (partnerId === null) return res.status(400).json({ error: 'Invalid user id' });
    const mode = req.body.encryptionMode;
    if (!['none', 'pgp', 'aes'].includes(mode)) return res.status(400).json({ error: 'Invalid encryption mode' });
    if (mode === 'aes' && !(await db.getDmKey(req.session.user.id, partnerId, req.session.user.id)))
        return res.status(409).json({ error: 'No AES key distributed for this conversation yet' });
    await db.setDmEncryptionMode(req.session.user.id, partnerId, mode);
    res.json({ success: true, encryptionMode: mode });
});

// DM AES keys
router.get('/dms/:userId/key', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const partnerId = parseUserId(req.params.userId);
    if (partnerId === null) return res.status(400).json({ error: 'Invalid user id' });

    const row = await db.getDmKey(req.session.user.id, partnerId, req.session.user.id);
    if (!row) return res.status(404).json({ error: 'No key distributed for this conversation' });
    res.json({ wrappedKey: row.wrapped_key });
});

router.post('/dms/:userId/keys', async (req, res) => {
    if (!req.session.dmUnlocked) return res.status(403).json({ error: 'DMs locked' });
    const partnerId = parseUserId(req.params.userId);
    if (partnerId === null) return res.status(400).json({ error: 'Invalid user id' });

    const keys = req.body.keys;
    if (!Array.isArray(keys) || keys.length === 0)
        return res.status(400).json({ error: 'keys must be a non-empty array' });

    const participants = new Set([req.session.user.id, partnerId]);
    for (const k of keys) {
        if (!k.userId || !k.wrappedKey || typeof k.wrappedKey !== 'string')
            return res.status(400).json({ error: 'Each key needs userId and wrappedKey' });
        if (!participants.has(k.userId))
            return res.status(400).json({ error: 'Keys can only be wrapped for conversation participants' });
    }
    if (await db.getDmKey(req.session.user.id, partnerId, req.session.user.id)
        || await db.getDmKey(req.session.user.id, partnerId, partnerId))
        return res.status(409).json({ error: 'Key already distributed for this conversation' });

    await db.setDmKeys(req.session.user.id, partnerId, keys);
    res.json({ success: true });
});

router.use((err, req, res, next) => {
    console.error('[api]', err);
    if (res.headersSent) return next(err);
    res.status(500).json({ error: 'Internal server error' });
});

module.exports = router;

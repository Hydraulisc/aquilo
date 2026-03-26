const express = require('express');
const router = express.Router();
const { sanitize } = require('../middleware/sanitize');
const { timingJitter, requireInstanceAdmin, computeFrankKey, computeFrank } = require('../middleware/security');
const db = require('../database/helpers');
const { resolveUser } = require('../utils/resolveUser');
const openpgp = require('openpgp');
const crypto = require('crypto');

function requireAuth(req, res, next) {
    if (!req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    next();
}

router.use(requireAuth);

// Servers
router.post('/servers', (req, res) => {
    const name = sanitize((req.body.name || '').trim());
    if (!name || name.length > 100) return res.status(400).json({ error: 'Invalid server name' });

    const icon = req.body.icon ? sanitize(req.body.icon.trim()) : null;
    const { serverId, channelId } = db.createServer(name, req.session.user.id, icon);

    const aesKey = crypto.randomBytes(32).toString('hex');
    db.setServerKey(serverId, aesKey);

    res.status(201).json({ id: serverId, channelId });
});

router.get('/servers', (req, res) => {
    const servers = db.getServersForUser(req.session.user.id);
    res.json(servers);
});

router.patch('/servers/:serverId', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const fields = {};
    if (req.body.name !== undefined) {
        const name = sanitize((req.body.name || '').trim());
        if (!name || name.length > 100) return res.status(400).json({ error: 'Invalid server name' });
        fields.name = name;
    }
    if (req.body.icon !== undefined) {
        fields.icon = req.body.icon ? sanitize(req.body.icon.trim()) : null;
    }
    if (Object.keys(fields).length === 0) return res.status(400).json({ error: 'No fields to update' });

    const updated = db.updateServer(req.params.serverId, req.session.user.id, fields);
    if (!updated) return res.status(500).json({ error: 'Update failed' });
    res.json({ success: true, ...fields });
});

router.delete('/servers/:serverId', (req, res) => {
    const deleted = db.deleteServer(req.params.serverId, req.session.user.id);
    if (!deleted) return res.status(403).json({ error: 'Forbidden or not found' });
    res.json({ success: true });
});

// Channels
router.post('/servers/:serverId/channels', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const name = sanitize((req.body.name || '').trim());
    if (!name || name.length > 100) return res.status(400).json({ error: 'Invalid channel name' });

    const channel = db.createChannel(req.params.serverId, name);
    res.status(201).json(channel);
});

router.get('/servers/:serverId/channels', (req, res) => {
    if (!db.isMember(req.params.serverId, req.session.user.id)) {
        return res.status(403).json({ error: 'Not a member' });
    }
    const channels = db.getChannelsForServer(req.params.serverId);
    res.json(channels);
});

router.patch('/channels/:channelId', (req, res) => {
    const channel = db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const server = db.getServer(channel.server_id);
    if (!server || server.owner_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    const name = sanitize((req.body.name || '').trim());
    if (!name || name.length > 100) return res.status(400).json({ error: 'Invalid channel name' });

    const updated = db.updateChannel(req.params.channelId, name);
    if (!updated) return res.status(500).json({ error: 'Update failed' });
    res.json({ success: true, name });
});

router.delete('/channels/:channelId', (req, res) => {
    const channel = db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    const server = db.getServer(channel.server_id);
    if (!server || server.owner_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    if (db.channelCount(channel.server_id) <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last channel' });
    }

    db.deleteChannel(req.params.channelId);
    res.json({ success: true });
});

router.patch('/servers/:serverId/channels/reorder', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const orderedIds = req.body.orderedIds;
    if (!Array.isArray(orderedIds) || orderedIds.length === 0) {
        return res.status(400).json({ error: 'Invalid channel order' });
    }

    const existing = db.getChannelsForServer(req.params.serverId);
    const existingIds = new Set(existing.map(c => c.id));
    if (orderedIds.length !== existingIds.size || !orderedIds.every(id => existingIds.has(id))) {
        return res.status(400).json({ error: 'Channel list mismatch' });
    }

    db.reorderChannels(req.params.serverId, orderedIds);
    res.json({ success: true });
});

// Messages
router.get('/channels/:channelId/messages', timingJitter, async (req, res) => {
    const channel = db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!db.isMember(channel.server_id, req.session.user.id))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const limit = parseInt(req.query.limit) || 50;
    const before = req.query.before || null;
    const messages = db.getMessages(req.params.channelId, limit, before);
    const serverKey = db.getServerKey(channel.server_id);

    const result = await Promise.all(messages.map(async (m) => {
        let content = m.content;
        if (serverKey) {
            try { content = db.decryptMessage(m.content, serverKey.aes_key); } catch {}
        }
        let frankKeyHex = null;
        if (serverKey && m.frank) {
            const frankKey = computeFrankKey(serverKey.aes_key, m.id);
            frankKeyHex = frankKey.toString('hex');
            frankKey.fill(0);
        }
        const user = await resolveUser(m.user_id);
        return { ...m, content, frank_key: frankKeyHex, user: { username: user.username, ownPfp: user.ownPfp } };
    }));
    res.json(result);
});

router.post('/channels/:channelId/messages', timingJitter, (req, res) => {
    const channel = db.getChannel(req.params.channelId);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!db.isMember(channel.server_id, req.session.user.id))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const plaintext = sanitize((req.body.content || '').trim());
    if (!plaintext || plaintext.length > 16000)
        return res.status(400).json({ error: 'Invalid message content' });

    const messageId = crypto.randomUUID();
    const serverKey = db.getServerKey(channel.server_id);
    const stored = serverKey ? db.encryptMessage(plaintext, serverKey.aes_key) : plaintext;

    let frank = null;
    let frankKeyHex = null;
    if (serverKey) {
        const frankKey = computeFrankKey(serverKey.aes_key, messageId);
        frank = computeFrank(frankKey, plaintext);
        frankKeyHex = frankKey.toString('hex');
        frankKey.fill(0);
    }

    const message = db.createMessage(messageId, req.params.channelId, req.session.user.id, stored, frank);
    res.status(201).json({ ...message, content: plaintext, frank_key: frankKeyHex });
});

router.patch('/messages/:messageId', timingJitter, (req, res) => {
    const message = db.getMessage(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });
    if (message.user_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const channel = db.getChannel(message.channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked' });

    const plaintext = sanitize((req.body.content || '').trim());
    if (!plaintext || plaintext.length > 16000)
        return res.status(400).json({ error: 'Invalid message content' });

    const serverKey = db.getServerKey(channel.server_id);
    const stored = serverKey ? db.encryptMessage(plaintext, serverKey.aes_key) : plaintext;

    const edited = db.editMessage(req.params.messageId, req.session.user.id, stored);
    if (!edited) return res.status(403).json({ error: 'Forbidden or not found' });
    res.json({ success: true, content: plaintext });
});

router.delete('/messages/:messageId', (req, res) => {
    const message = db.getMessage(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    if (message.user_id === req.session.user.id) {
        db.deleteMessage(req.params.messageId, req.session.user.id);
        return res.json({ success: true });
    }

    const channel = db.getChannel(message.channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });
    const server = db.getServer(channel.server_id);
    if (server && server.owner_id === req.session.user.id) {
        db.deleteMessageAsOwner(req.params.messageId);
        return res.json({ success: true });
    }

    res.status(403).json({ error: 'Forbidden' });
});

// Memberships
router.get('/servers/:serverId/members', async (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!db.isMember(req.params.serverId, req.session.user.id)) {
        return res.status(403).json({ error: 'Not a member' });
    }

    const memberships = db.getMembers(req.params.serverId);
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

router.delete('/servers/:serverId/members/:userId', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const targetUserId = parseInt(req.params.userId, 10);
    if (targetUserId === server.owner_id) {
        return res.status(400).json({ error: 'Cannot kick the server owner' });
    }

    const removed = db.removeMember(req.params.serverId, targetUserId);
    if (!removed) return res.status(404).json({ error: 'Member not found' });
    res.json({ success: true });
});

router.post('/servers/:serverId/join', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });

    const joined = db.joinServer(req.params.serverId, req.session.user.id);
    if (!joined) return res.status(409).json({ error: 'Already a member' });
    res.status(201).json({ success: true });
});

router.post('/servers/:serverId/leave', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id === req.session.user.id) {
        return res.status(400).json({ error: 'Owner cannot leave — delete the server instead' });
    }

    const left = db.leaveServer(req.params.serverId, req.session.user.id);
    if (!left) return res.status(404).json({ error: 'Not a member' });
    res.json({ success: true });
});

// Invites
router.post('/servers/:serverId/invites', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (!db.isMember(req.params.serverId, req.session.user.id)) {
        return res.status(403).json({ error: 'Not a member' });
    }

    const maxUses = req.body.maxUses ? parseInt(req.body.maxUses, 10) : null;
    const expiresAt = req.body.expiresAt || null;

    const code = db.createInvite(req.params.serverId, req.session.user.id, { maxUses, expiresAt });
    res.status(201).json({ code });
});

router.get('/servers/:serverId/invites', (req, res) => {
    const server = db.getServer(req.params.serverId);
    if (!server) return res.status(404).json({ error: 'Server not found' });
    if (server.owner_id !== req.session.user.id) return res.status(403).json({ error: 'Forbidden' });

    const invites = db.getInvitesForServer(req.params.serverId);
    res.json(invites);
});

router.delete('/invites/:code', (req, res) => {
    // Use getInvitesForServer via server owner check — look up raw row first
    const rawInvite = db.getRawInvite(req.params.code);
    if (!rawInvite) return res.status(404).json({ error: 'Invite not found' });

    const server = db.getServer(rawInvite.server_id);
    if (!server || server.owner_id !== req.session.user.id) {
        return res.status(403).json({ error: 'Forbidden' });
    }

    db.deleteInvite(req.params.code);
    res.json({ success: true });
});

router.post('/invites/:code/join', (req, res) => {
    try {
        const invite = db.getInvite(req.params.code);
        if (!invite) return res.status(404).json({ error: 'Invalid or expired invite' });

        const joined = db.joinServer(invite.server_id, req.session.user.id);
        if (!joined) return res.status(409).json({ error: 'Already a member' });

        db.useInvite(req.params.code);
        res.status(201).json({ success: true, serverId: invite.server_id });
    } catch (err) {
        console.error('Invite join error:', err);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// PGP Keys
router.post('/keys/submit', async (req, res) => {
    const armoredKey = (req.body.publicKey || '').trim();
    if (!armoredKey) return res.status(400).json({ error: 'Missing public key' });

    let key;
    try {
        key = await openpgp.readKey({ armoredKey });
    } catch {
        return res.status(400).json({ error: 'Invalid PGP public key' });
    }

    const fingerprint = key.getFingerprint();
    db.setUserKey(req.session.user.id, armoredKey, fingerprint);

    const nonce = crypto.randomBytes(32).toString('hex');
    req.session.pgpChallenge = nonce;

    const encrypted = await openpgp.encrypt({
        message: await openpgp.createMessage({ text: nonce }),
        encryptionKeys: key
    });

    res.json({ encryptedChallenge: encrypted });
});

router.post('/keys/verify', (req, res) => {
    if (!req.session.pgpChallenge) {
        return res.status(400).json({ error: 'No active challenge' });
    }
    const plaintext = (req.body.plaintext || '').trim();
    if (plaintext !== req.session.pgpChallenge) {
        return res.status(403).json({ error: 'Challenge mismatch' });
    }
    db.verifyUserKey(req.session.user.id);
    delete req.session.pgpChallenge;
    res.json({ success: true });
});

router.get('/keys/me', (req, res) => {
    const row = db.getUserKey(req.session.user.id);
    res.json({ hasKey: !!row, verified: !!(row && row.verified_at) });
});

router.get('/servers/:serverId/challenge', async (req, res) => {
    if (!db.isMember(req.params.serverId, req.session.user.id))
        return res.status(403).json({ error: 'Not a member' });
    const userKey = db.getUserKey(req.session.user.id);
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
router.post('/messages/:messageId/report', (req, res) => {
    const message = db.getMessage(req.params.messageId);
    if (!message) return res.status(404).json({ error: 'Message not found' });

    const channel = db.getChannel(message.channel_id);
    if (!channel) return res.status(404).json({ error: 'Channel not found' });

    if (!db.isMember(channel.server_id, req.session.user.id))
        return res.status(403).json({ error: 'Not a member' });
    if (!req.session.unlockedServers?.[channel.server_id])
        return res.status(403).json({ error: 'Server locked — unlock before reporting' });

    const content = sanitize((req.body.content || '').trim());
    if (!content) return res.status(400).json({ error: 'Message content required for report' });

    const submittedFrankKey = (req.body.frank_key || '').trim();
    let frankVerified = null;
    if (message.frank) {
        if (submittedFrankKey) {
            const serverKey = db.getServerKey(channel.server_id);
            if (serverKey) {
                const canonicalFrankKey = computeFrankKey(serverKey.aes_key, message.id);
                const expectedFrank = computeFrank(canonicalFrankKey, content);
                canonicalFrankKey.fill(0);
                frankVerified = expectedFrank === message.frank ? 1 : 0;
            }
        } else {
            frankVerified = 0; // message has frank but no key submitted
        }
    }

    db.createReport(message.id, channel.id, channel.server_id, req.session.user.id, content, frankVerified);
    res.json({ success: true });
});

// Instance admin: all reports across every server
router.get('/reports', requireInstanceAdmin, async (req, res) => {
    const reports = db.getAllReports();
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
router.delete('/reports/:reportId', requireInstanceAdmin, (req, res) => {
    const deleted = db.deleteReport(req.params.reportId);
    if (!deleted) return res.status(404).json({ error: 'Report not found' });
    res.json({ success: true });
});

// Delete the reported message and dismiss the report
router.delete('/reports/:reportId/message', requireInstanceAdmin, (req, res) => {
    const report = db.getReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    if (report.message_id) db.deleteMessageAsOwner(report.message_id);
    db.deleteReport(report.id);
    res.json({ success: true });
});

// Kick the message sender from the server (cascade deletes server if sender is owner)
router.post('/reports/:reportId/kick', requireInstanceAdmin, (req, res) => {
    const report = db.getReport(req.params.reportId);
    if (!report) return res.status(404).json({ error: 'Report not found' });
    const message = db.getMessage(report.message_id);
    if (!message) return res.status(404).json({ error: 'Message no longer exists' });
    const server = db.getServer(report.server_id);
    if (server && message.user_id === server.owner_id) {
        db.deleteServerAdmin(report.server_id); // cascades channels, messages, memberships, invites, reports
        return res.json({ success: true, serverDeleted: true });
    }
    db.removeMember(report.server_id, message.user_id);
    db.deleteReport(report.id);
    res.json({ success: true, serverDeleted: false });
});

router.post('/servers/:serverId/unlock', (req, res) => {
    const expected = req.session.serverChallenges?.[req.params.serverId];
    if (!expected) return res.status(400).json({ error: 'No active challenge' });
    if ((req.body.plaintext || '').trim() !== expected)
        return res.status(403).json({ error: 'Challenge mismatch' });
    req.session.unlockedServers = { ...(req.session.unlockedServers || {}), [req.params.serverId]: true };
    delete req.session.serverChallenges[req.params.serverId];
    res.json({ success: true });
});

module.exports = router;

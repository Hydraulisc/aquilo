const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const globals = JSON.parse(fs.readFileSync('globals.json', 'utf8'));
const { SESSION_MAX_AGE_MS } = require('./constants');
const { version } = require('./package.json');
const db = require('./database/helpers');
const { resolveUser } = require('./utils/resolveUser');
const { parseUserId } = require('./utils/parseId');
const apiRoutes = require('./routes/api');
const oauthRoutes = require('./routes/oauth');

require('./jobs/background');

const app = express();

// Session secret: env var, else globals, else generated
function loadSessionSecret() {
    if (process.env.SESSION_KEY) return process.env.SESSION_KEY;
    if (globals.sessionKey && globals.sessionKey !== 'test_session_key') return globals.sessionKey;
    const secretFile = path.join(__dirname, '.session-secret');
    try {
        return fs.readFileSync(secretFile, 'utf8').trim();
    } catch {
        const secret = crypto.randomBytes(32).toString('hex');
        fs.writeFileSync(secretFile, secret, { mode: 0o600 });
        console.warn('[session] no SESSION_KEY configured:  generated one in .session-secret');
        return secret;
    }
}

const isHttps = globals.protocol === 'https';
if (isHttps) app.set('trust proxy', 1);

// Middleware
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            // inline <script> blocks and onclick= handlers exist in several views
            scriptSrc: ["'self'", "'unsafe-inline'"],
            scriptSrcAttr: ["'unsafe-inline'"],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", 'https://hydraulisc.net', 'data:'],
            connectSrc: ["'self'"],
        }
    },
    hsts: isHttps,
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: loadSessionSecret(),
    resave: true,
    saveUninitialized: false,
    name: 'connect.sid',
    cookie: {
        // 'auto': Secure only for https
        // production behind an https proxy gets Secure cookies, local http dev still works
        secure: isHttps ? 'auto' : false,
        httpOnly: true,
        maxAge: SESSION_MAX_AGE_MS,
        path: '/',
        sameSite: 'lax'
    },
    rolling: true
}));

// Static files and views
app.use(express.static(path.join(__dirname, 'public')));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.get('/js/openpgp.min.js', (req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules/openpgp/dist/openpgp.min.js'));
});

// API routes
app.use('/api', apiRoutes);
app.use('/oauth', oauthRoutes);

function requireKey(req, res, next) {
    if (!req.session.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    const keyRow = db.getUserKey(req.session.user.id);
    if (!keyRow || !keyRow.verified_at) return res.redirect('/setup');
    db.touchLastActive(req.session.user.id);
    next();
}

// Onboarding
app.get('/', async (req, res) => {
    try {
        const user = req.session.user;
        if (user) {
            const keyRow = db.getUserKey(user.id);
            if (!keyRow || !keyRow.verified_at) return res.redirect('/setup');
            const resolvedUser = await resolveUser(user.id);
            const servers = db.getServersForUser(user.id);
            return res.render('pages/app', {
                username: resolvedUser.username,
                uid: resolvedUser.uid,
                ownPfp: resolvedUser.ownPfp,
                title: globals.title,
                bannerURL: globals.bannerURL,
                shortDescription: globals.shortDescription,
                kofiURL: globals.kofiURL,
                serverId: null,
                serverName: null,
                channelId: null,
                channelName: null,
                servers: servers.map(s => ({ id: s.id, icon: s.icon, name: s.name, unread: false })),
                channels: [],
                channelMessages: [],
                isOwner: false,
                isUnlocked: false
            });
        }
        res.render('pages/welcome', {
            username: null,
            uid: null,
            title: globals.title,
            bannerURL: globals.bannerURL,
            shortDescription: globals.shortDescription,
            kofiURL: globals.kofiURL,
            aquiloURL: globals.aquilo_invite || null
        })
    } catch(err) {
        res.render('pages/404')
    }
})

// Settings
app.get('/settings', async (req, res) => {
    try {
        res.render('pages/settings', {
            username: null,
            uid: null,
            title: globals.title,
            bannerURL: globals.bannerURL,
            shortDescription: globals.shortDescription,
            kofiURL: globals.kofiURL,
            version
        })
    } catch(err) {
        res.render('pages/404')
    }
})

app.get('/login', async (req, res) => {
    const redirectTo = req.query.next && req.query.next.startsWith('/')
    ? req.query.next
    : '/';
    res.render('pages/login', {
        title: globals.title,
        next: redirectTo
    })
})

app.get('/setup', (req, res) => {
    if (!req.session.user) return res.redirect('/login?next=/setup');
    if (req.query.next && req.query.next.startsWith('/')) {
        req.session.postSetupRedirect = req.query.next;
    }
    const keyRow = db.getUserKey(req.session.user.id);
    if (keyRow && keyRow.verified_at) {
        const servers = db.getServersForUser(req.session.user.id);
        if (servers.length) {
            const channels = db.getChannelsForServer(servers[0].id);
            return res.redirect(channels.length
                ? `/server/${servers[0].id}/channel/${channels[0].id}`
                : `/server/${servers[0].id}`);
        }
        return res.redirect('/');
    }
    res.render('pages/setup', { title: globals.title });
});

// Invite landing page
app.get('/invite/:code', async (req, res) => {
    try {
        const invite = db.getInvite(req.params.code);
        if (!invite) return res.render('pages/404');

        const server = db.getServer(invite.server_id);
        if (!server) return res.render('pages/404');

        if (!req.session.user) {
            return res.redirect('/login?next=/invite/' + req.params.code);
        }

        const memberCount = db.getMembers(invite.server_id).length;
        const alreadyMember = db.isMember(invite.server_id, req.session.user.id);

        res.render('pages/invite', {
            title: globals.title,
            server,
            memberCount,
            code: req.params.code,
            alreadyMember
        });
    } catch (err) {
        res.render('pages/404');
    }
});

// Server view — real data
app.get('/server/:serverId', requireKey, async (req, res) => {
    try {
        const user = req.session.user;

        const server = db.getServer(req.params.serverId);
        if (!server) return res.render('pages/404');
        if (!db.isMember(server.id, user.id)) return res.render('pages/404');

        const channels = db.getChannelsForServer(server.id);
        const firstChannel = channels[0];
        if (firstChannel) {
            return res.redirect(`/server/${server.id}/channel/${firstChannel.id}`);
        }

        // Server with no channels — render empty
        const userServers = db.getServersForUser(user.id);
        const resolvedUser = await resolveUser(user.id);

        res.render('pages/app', {
            username: resolvedUser.username,
            uid: resolvedUser.uid,
            ownPfp: resolvedUser.ownPfp,
            title: globals.title,
            bannerURL: globals.bannerURL,
            shortDescription: globals.shortDescription,
            kofiURL: globals.kofiURL,
            serverId: server.id,
            serverName: server.name,
            channelId: null,
            channelName: null,
            servers: userServers.map(s => ({ id: s.id, icon: s.icon, name: s.name, unread: false })),
            channels: channels.map(c => ({ id: c.id, name: c.name, unread: false })),
            channelMessages: [],
            isOwner: server.owner_id === user.id,
            isUnlocked: false
        });
    } catch (err) {
        res.render('pages/404');
    }
});

app.get('/server/:serverId/channel/:channelId', requireKey, async (req, res) => {
    try {
        const user = req.session.user;

        const server = db.getServer(req.params.serverId);
        if (!server) return res.render('pages/404');
        if (!db.isMember(server.id, user.id)) return res.render('pages/404');

        const channel = db.getChannel(req.params.channelId);
        if (!channel || channel.server_id !== server.id) return res.render('pages/404');

        const channels = db.getChannelsForServer(server.id);
        const unreadMap = new Map(
            db.getChannelUnreadCounts(user.id, server.id).map(r => [r.channel_id, r.unread])
        );
        const userServers = db.getServersForUser(user.id);
        const resolvedUser = await resolveUser(user.id);

        const isUnlocked = req.session.unlockedServers?.[server.id] === true;

        // Messages are client-side E2E encrypted 
        // page renders empty,
        // chat.js fetches and decrypts after unlock
        const channelMessages = [];

        res.render('pages/app', {
            username: resolvedUser.username,
            uid: resolvedUser.uid,
            ownPfp: resolvedUser.ownPfp,
            title: globals.title,
            bannerURL: globals.bannerURL,
            shortDescription: globals.shortDescription,
            kofiURL: globals.kofiURL,
            serverId: server.id,
            serverName: server.name,
            channelId: channel.id,
            channelName: channel.name,
            servers: userServers.map(s => ({ id: s.id, icon: s.icon, name: s.name, unread: false })),
            channels: channels.map(c => ({
                id: c.id,
                name: c.name,
                unread: c.id !== channel.id && (unreadMap.get(c.id) || 0) > 0
            })),
            channelMessages,
            isOwner: server.owner_id === user.id,
            isUnlocked
        });
    } catch (err) {
        res.render('pages/404');
    }
});

// DM routes
app.get('/dm', requireKey, async (req, res) => {
    try {
        const user = req.session.user;
        const resolvedUser = await resolveUser(user.id);
        const servers = db.getServersForUser(user.id);
        const isUnlocked = req.session.dmUnlocked === true;

        let conversations = [];
        if (isUnlocked) {
            const rawConvos = db.getDmConversations(user.id);
            const unreadMap = new Map(db.getDmUnreadCounts(user.id).map(r => [r.partner_id, r.unread]));
            conversations = await Promise.all(rawConvos.map(async ({ partner_id }) => {
                const u = await resolveUser(partner_id);
                const settings = db.getDmSettings(user.id, partner_id);
                const isSelf = partner_id === user.id;
                return { partnerId: partner_id,
                         username: isSelf ? 'Note to self' : u.username,
                         ownPfp: u.ownPfp,
                         encryptionMode: settings.encryption_mode,
                         unread: isSelf ? 0 : (unreadMap.get(partner_id) || 0) };
            }));
        }

        res.render('pages/dm', {
            title: globals.title,
            username: resolvedUser.username,
            uid: resolvedUser.uid,
            ownPfp: resolvedUser.ownPfp,
            servers: servers.map(s => ({ id: s.id, icon: s.icon, name: s.name })),
            conversations,
            partnerId: null,
            partnerUsername: null,
            partnerPfp: null,
            partnerFingerprint: null,
            encryptionMode: 'none',
            isUnlocked,
        });
    } catch (err) {
        console.error(err);
        res.render('pages/404');
    }
});

app.get('/dm/:userId', requireKey, async (req, res) => {
    try {
        const user = req.session.user;
        const partnerId = parseUserId(req.params.userId);
        if (partnerId === null) return res.redirect('/dm');
        const isSelfChat = partnerId === user.id; // "Note to self"

        const resolvedUser = await resolveUser(user.id);
        const partner = await resolveUser(partnerId);
        const servers = db.getServersForUser(user.id);
        const isUnlocked = req.session.dmUnlocked === true;
        const settings = db.getDmSettings(user.id, partnerId);
        const partnerKey = db.getUserKey(partnerId);

        let conversations = [];
        if (isUnlocked) {
            const rawConvos = db.getDmConversations(user.id);
            const unreadMap = new Map(db.getDmUnreadCounts(user.id).map(r => [r.partner_id, r.unread]));
            conversations = await Promise.all(rawConvos.map(async ({ partner_id }) => {
                const u = await resolveUser(partner_id);
                const s = db.getDmSettings(user.id, partner_id);
                const isSelf = partner_id === user.id;
                return { partnerId: partner_id,
                         username: isSelf ? 'Note to self' : u.username,
                         ownPfp: u.ownPfp,
                         encryptionMode: s.encryption_mode,
                         unread: (isSelf || partner_id === partnerId) ? 0 : (unreadMap.get(partner_id) || 0) };
            }));
            if (!conversations.find(c => c.partnerId === partnerId)) {
                conversations.unshift({ partnerId,
                                        username: isSelfChat ? 'Note to self' : partner.username,
                                        ownPfp: partner.ownPfp, encryptionMode: settings.encryption_mode,
                                        unread: 0 });
            }
        }

        res.render('pages/dm', {
            title: globals.title,
            username: resolvedUser.username,
            uid: resolvedUser.uid,
            ownPfp: resolvedUser.ownPfp,
            servers: servers.map(s => ({ id: s.id, icon: s.icon, name: s.name })),
            conversations,
            partnerId,
            partnerUsername: isSelfChat ? 'Note to self' : partner.username,
            partnerPfp: partner.ownPfp,
            partnerFingerprint: partnerKey?.fingerprint || null,
            encryptionMode: settings.encryption_mode,
            isUnlocked,
        });
    } catch (err) {
        console.error(err);
        res.render('pages/404');
    }
});

// Start server
const PORT = globals.hostPort || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

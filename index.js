const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const globals = JSON.parse(fs.readFileSync('globals.json', 'utf8'));
const { version } = require('./package.json');
const db = require('./database/helpers');
const { resolveUser } = require('./utils/resolveUser');
const { cspNonce, stripIp, getInstanceAdmins } = require('./middleware/security');
const apiRoutes = require('./routes/api');
const oauthRoutes = require('./routes/oauth');

const app = express();

// Strip real IPs before anything else
app.use(stripIp);

// Generate per-request CSP nonce (must run before helmet)
app.use(cspNonce);

// Security headers
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'", (req, res) => `'nonce-${res.locals.cspNonce}'`],
            styleSrc: ["'self'", "'unsafe-inline'"],
            imgSrc: ["'self'", "data:", "https:"],
            connectSrc: ["'self'"],
            fontSrc: ["'self'"],
            objectSrc: ["'none'"],
            frameAncestors: ["'none'"],
        }
    },
    crossOriginEmbedderPolicy: false,
}));

// CORS — restrict to configured origin
const appOrigin = globals.protocol && globals.siteDomain
    ? `${globals.protocol}://${globals.siteDomain}`
    : false;
app.use(cors({ origin: appOrigin, credentials: true }));

// Rate limiters
const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    skipSuccessfulRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many login attempts, try again later' }
});

const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' }
});

const messageLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Sending messages too fast' }
});

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: globals.sessionKey,
    resave: true,
    saveUninitialized: false,
    name: 'connect.sid',
    cookie: {
        secure: false,
        httpOnly: true,
        maxAge: 24 * 60 * 60 * 1000,
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
app.use('/api', apiLimiter, apiRoutes);
app.use('/api/channels', messageLimiter);
app.use('/oauth', oauthRoutes);
app.use('/oauth/login', loginLimiter);
app.use('/oauth/callback', loginLimiter);

function requireKey(req, res, next) {
    if (!req.session.user) return res.redirect('/login?next=' + encodeURIComponent(req.originalUrl));
    const keyRow = db.getUserKey(req.session.user.id);
    if (!keyRow || !keyRow.verified_at) return res.redirect('/setup');
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
        const rawMessages = db.getMessages(channel.id, 50);
        const userServers = db.getServersForUser(user.id);
        const resolvedUser = await resolveUser(user.id);

        const isUnlocked = req.session.unlockedServers?.[server.id] === true;
        let decryptedMessages = [];
        if (isUnlocked) {
            const serverKey = db.getServerKey(server.id);
            decryptedMessages = rawMessages.map(m => {
                if (!serverKey) return m;
                try { return { ...m, content: db.decryptMessage(m.content, serverKey.aes_key) }; }
                catch { return m; }
            });
        }

        // Resolve user info for each message
        const channelMessages = await Promise.all(
            decryptedMessages.reverse().map(async (m) => {
                const msgUser = await resolveUser(m.user_id);
                return {
                    id: m.id,
                    user: { uid: msgUser.uid, username: msgUser.username, ownPfp: msgUser.ownPfp },
                    content: m.content,
                    unread: false
                };
            })
        );

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
            channels: channels.map(c => ({ id: c.id, name: c.name, unread: false })),
            channelMessages,
            isOwner: server.owner_id === user.id,
            isUnlocked
        });
    } catch (err) {
        res.render('pages/404');
    }
});

// Instance admin: reports dashboard
app.get('/admin/reports', async (req, res) => {
    if (!req.session.user) return res.redirect('/login?next=/admin/reports');
    if (!getInstanceAdmins().includes(req.session.user.id)) return res.render('pages/404');

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

    res.render('pages/reports', { title: globals.title, reports: result });
});

// Warrant canary
app.get('/canary.txt', (req, res) => {
    const canaryPath = path.join(__dirname, 'canary.txt');
    try {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
        res.sendFile(canaryPath);
    } catch {
        res.status(404).send('Not found');
    }
});

app.get('/canary', (req, res) => {
    const canaryPath = path.join(__dirname, 'canary.txt');
    let canaryText = null;
    try { canaryText = fs.readFileSync(canaryPath, 'utf8').trim(); } catch {}
    res.render('pages/canary', { title: globals.title, canaryText });
});

// Start server
const PORT = globals.hostPort || 3000;
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

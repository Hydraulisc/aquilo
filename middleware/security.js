const crypto = require('crypto');
const fs = require('fs');

const path = require('path');

function getInstanceAdmins() {
    try {
        const globals = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'globals.json'), 'utf8'));
        return Array.isArray(globals.instanceAdmins) ? globals.instanceAdmins : [];
    } catch {
        return [];
    }
}

function requireInstanceAdmin(req, res, next) {
    if (!req.session.user?.id) return res.status(401).json({ error: 'Unauthorized' });
    if (!getInstanceAdmins().includes(req.session.user.id)) return res.status(403).json({ error: 'Forbidden' });
    next();
}

function cspNonce(req, res, next) {
    res.locals.cspNonce = crypto.randomBytes(16).toString('base64');
    next();
}

function stripIp(req, res, next) {
    delete req.headers['x-forwarded-for'];
    delete req.headers['x-real-ip'];
    next();
}

// Random 50–200ms delay to message endpoints 
// there are some timing correlation attacks governments could use to identify users idk might be overkill
// overkill is what we want i guess
function timingJitter(req, res, next) {
    const delay = 50 + Math.floor(Math.random() * 151);
    setTimeout(next, delay);
}

// frank_key = HMAC-SHA256(serverAesKey, messageId) — deterministic, never stored
function computeFrankKey(serverAesKeyHex, messageId) {
    return crypto.createHmac('sha256', Buffer.from(serverAesKeyHex, 'hex'))
        .update(messageId)
        .digest(); // Buffer
}

// frank = HMAC-SHA256(frankKey, plaintext) — stored with the message as a commitment
function computeFrank(frankKey, plaintext) {
    return crypto.createHmac('sha256', frankKey)
        .update(plaintext, 'utf8')
        .digest('hex');
}

module.exports = { cspNonce, stripIp, timingJitter, requireInstanceAdmin, getInstanceAdmins, computeFrankKey, computeFrank };

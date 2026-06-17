const rateLimit = require('express-rate-limit');
const {
    RATE_GENERAL_WINDOW_MS, RATE_GENERAL_MAX,
    RATE_MESSAGES_WINDOW_MS, RATE_MESSAGES_MAX,
    RATE_KEY_WINDOW_MS, RATE_KEY_MAX, RATE_CHALLENGE_MAX,
} = require('../constants');

const general = rateLimit({
    windowMs: RATE_GENERAL_WINDOW_MS,
    max: RATE_GENERAL_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests' },
});

// Write limiter for message/DM sends — keeps spam in check without
// starving the poll loop, which shares the general bucket
const messages = rateLimit({
    windowMs: RATE_MESSAGES_WINDOW_MS,
    max: RATE_MESSAGES_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Sending too fast' },
});

const keySubmit = rateLimit({
    windowMs: RATE_KEY_WINDOW_MS,
    max: RATE_KEY_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many key submission attempts' },
});

const keyVerify = rateLimit({
    windowMs: RATE_KEY_WINDOW_MS,
    max: RATE_KEY_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many verification attempts' },
});

const challenge = rateLimit({
    windowMs: RATE_KEY_WINDOW_MS,
    max: RATE_CHALLENGE_MAX,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many challenge requests' },
});

module.exports = { general, messages, keySubmit, keyVerify, challenge };

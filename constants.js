// Shared limits and tuning knobs
module.exports = {
    MESSAGE_LIMIT: 50,            // max messages per page fetch
    MAX_MESSAGE_LEN: 32000,       // channel message ciphertext cap (~22KB plaintext after padding)
    MAX_EDIT_LEN: 16000,
    MAX_DM_LEN: 64000,
    MAX_NAME_LEN: 100,            // server/channel names
    PAD_BLOCK: 256,               // client-side padding block size (bytes)

    POLL_INTERVAL_MS: 3000,
    TYPING_TTL_MS: 8000,

    INVITE_MAX_USES_CAP: 1000,

    RATE_GENERAL_WINDOW_MS: 15 * 60 * 1000,
    RATE_GENERAL_MAX: 1200,      // generous: clients poll every POLL_INTERVAL_MS
    RATE_MESSAGES_WINDOW_MS: 60 * 1000,
    RATE_MESSAGES_MAX: 30,
    RATE_KEY_WINDOW_MS: 15 * 60 * 1000,
    RATE_KEY_MAX: 5,
    RATE_CHALLENGE_MAX: 10,

    USER_CACHE_TTL_MS: 5 * 60 * 1000,
    USER_CACHE_MAX: 500,

    SESSION_MAX_AGE_MS: 24 * 60 * 60 * 1000,
};

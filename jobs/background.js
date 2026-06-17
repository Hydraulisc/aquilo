const db = require('../database/helpers');
const typing = require('../utils/typing');

// Runs every 60 seconds: delete expired messages and DMs, sweep stale typing state
setInterval(() => {
    try {
        db.deleteExpiredMessages();
        db.deleteExpiredDms();
        typing.sweep();
    } catch (err) {
        console.error('[expiry job]', err.message);
    }
}, 60 * 1000);

// Runs every 24 hours: dead man's switch
const DAY_MS = 24 * 60 * 60 * 1000;
function runDeadMansSwitch() {
    try {
        const targets = db.getUsersForDeletion();
        for (const { id } of targets) {
            db.deleteUserAndData(id);
            console.log(`[dead man's switch] deleted user ${id}`);
        }
    } catch (err) {
        console.error('[dead man\'s switch]', err.message);
    }
}
runDeadMansSwitch(); // run once on startup to catch any overdue accounts
setInterval(runDeadMansSwitch, DAY_MS);

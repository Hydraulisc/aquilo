// Strict numeric user-id parsing — returns int >= 0 or null.
// Avoids the `!parseInt(x)` trap where id 0 is falsy and NaN slips through comparisons.
function parseUserId(value) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    if (typeof value === 'string' && !/^\d+$/.test(value.trim())) return null;
    const n = Number.parseInt(value, 10);
    return Number.isInteger(n) && n >= 0 ? n : null;
}

module.exports = { parseUserId };

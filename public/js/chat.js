// Client-side AES-256-GCM helpers using WebCrypto
// this was such a fucking pain

const Crypto = {
    async importKey(hexKey) {
        const raw = hexKey.match(/.{2}/g).map(b => parseInt(b, 16));
        return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
    async encrypt(plaintext, cryptoKey) {
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const encoded = padMessage(plaintext);
        const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, encoded);
        const out = new Uint8Array(12 + ciphertext.byteLength);
        out.set(iv, 0);
        out.set(new Uint8Array(ciphertext), 12);
        return btoa(String.fromCharCode(...out));
    },
    async decrypt(b64, cryptoKey) {
        const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
        const iv = buf.slice(0, 12);
        const data = buf.slice(12);
        const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, cryptoKey, data);
        return unpadMessage(new Uint8Array(plain));
    }
};

const PIN_ICON = '<svg viewBox="0 0 16 16" width="13" height="13" fill="currentColor" style="vertical-align:-2px;"><path d="M9.828.722a.5.5 0 0 1 .354.146l4.95 4.95a.5.5 0 0 1 0 .707c-.48.48-1.072.588-1.503.588-.177 0-.335-.018-.46-.039l-3.134 3.134a5.927 5.927 0 0 1 .16 1.013c.046.702-.032 1.687-.72 2.375a.5.5 0 0 1-.707 0l-2.829-2.828-3.182 3.182c-.195.195-1.219.902-1.414.707-.195-.195.512-1.22.707-1.414l3.182-3.182-2.828-2.829a.5.5 0 0 1 0-.707c.688-.688 1.673-.767 2.375-.72a5.922 5.922 0 0 1 1.013.16l3.134-3.133a2.772 2.772 0 0 1-.04-.461c0-.43.108-1.022.589-1.503a.5.5 0 0 1 .353-.146z"/></svg>';

const PAD_BLOCK = 256;
const POLL_INTERVAL_MS = 3000;
const TYPING_PING_MS = 4000;

function padMessage(text, block = PAD_BLOCK) {
    const bytes = new TextEncoder().encode(text);
    const padLen = block - (bytes.length % block);
    const out = new Uint8Array(bytes.length + padLen);
    out.set(bytes);
    return out;
}

function unpadMessage(bytes) {
    let end = bytes.length;
    while (end > 0 && bytes[end - 1] === 0) end--;
    return new TextDecoder().decode(bytes.slice(0, end));
}

// Per-channel key cache (in-memory, cleared on page unload)
const channelKeyCache = new Map();

const chatContainer = document.getElementById('chat-context');
if (chatContainer) {
    const channelId = chatContainer.dataset.channelId;
    const serverId = chatContainer.dataset.serverId;
    const ownUid = chatContainer.dataset.uid;
    const username = chatContainer.dataset.username;
    const ownPfp = chatContainer.dataset.ownPfp;
    const textarea = document.getElementById('userprompt');
    const messageArea = document.querySelector('.messageArea');
    const scrollContainer = document.querySelector('.messageAreaPadding');

    const unlockModal = document.getElementById('unlock-modal');
    const unlockStep1 = document.getElementById('unlock-step-1');
    const unlockStep2 = document.getElementById('unlock-step-2');
    const unlockStep3 = document.getElementById('unlock-step-3');
    const getChallengeBtn = document.getElementById('unlock-get-challenge-btn');
    const challengeOutput = document.getElementById('unlock-challenge-output');
    const plaintextInput = document.getElementById('unlock-plaintext-input');
    const unlockBtn = document.getElementById('unlock-btn');
    const unlockError = document.getElementById('unlock-error');
    const channelKeyOutput = document.getElementById('unlock-channel-key-output');
    const channelKeyInput = document.getElementById('unlock-channel-key-input');
    const channelKeyBtn = document.getElementById('unlock-channel-key-btn');

    const typingIndicator = document.getElementById('typing-indicator');
    const searchInput = document.getElementById('chat-search');
    const pinsBtn = document.getElementById('pins-btn');
    const replyBar = document.getElementById('reply-bar');
    const replyBarUser = document.getElementById('reply-bar-user');
    const replyBarCancel = document.getElementById('reply-bar-cancel');

    let isUnlocked = chatContainer.dataset.unlocked === 'true';
    let lastMessageId = null;
    let pollTimer = null;
    let lastTypingPing = 0;
    let replyTarget = null; // { id, username }

    // messageId -> { plaintext, username, createdAt } for search and reply quotes
    const decryptedCache = new Map();

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    async function decryptContent(content) {
        if (!content) return '[message destroyed]';
        const ck = channelKeyCache.get(channelId);
        if (!ck) return content;
        try {
            return await Crypto.decrypt(content, ck);
        } catch {
            return '[decryption failed]';
        }
    }

    async function buildMessageEl(msg) {
        const pfpSrc = msg.user.ownPfp && msg.user.ownPfp !== 'null'
            ? msg.user.ownPfp
            : '/assets/1759430838.png';

        const displayContent = await decryptContent(msg.content);
        if (msg.content) {
            decryptedCache.set(msg.id, {
                plaintext: displayContent,
                username: msg.user.username,
                createdAt: msg.created_at
            });
        }

        const div = document.createElement('div');
        div.id = msg.id;

        const contentDiv = document.createElement('div');
        contentDiv.id = 'message-content';

        if (msg.reply_to_id) {
            const quoted = decryptedCache.get(msg.reply_to_id);
            const quote = document.createElement('p');
            quote.className = 'textContent';
            quote.style.cssText = 'font-size:12px; opacity:0.6; border-left:2px solid var(--accent-color,#5865f2); padding-left:6px; margin:0 0 2px; cursor:pointer;';
            quote.textContent = quoted
                ? `↩ ${quoted.username}: ${quoted.plaintext.slice(0, 100)}`
                : '↩ replied to a message';
            quote.addEventListener('click', () => {
                const target = document.getElementById(msg.reply_to_id);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            contentDiv.appendChild(quote);
        }

        const p = document.createElement('p');
        p.className = 'textContent';
        p.textContent = displayContent;
        contentDiv.appendChild(p);

        div.innerHTML =
            '<div class="jCxwsP">' +
                '<div class="csvICB" data-profile-user-id="' + escapeHtml(String(msg.user_id || '')) + '" data-profile-username="' + escapeHtml(msg.user.username) + '" data-profile-pfp="' + escapeHtml(pfpSrc) + '" style="cursor:pointer;">' +
                    '<svg width="36" height="36" viewBox="0 0 32 32">' +
                        '<foreignObject x="0" y="0" width="32" height="32">' +
                            '<img src="' + escapeHtml(pfpSrc) + '" alt="' + escapeHtml(msg.user.username) + '\'s pfp" style="width: 100%; height: 100%; object-fit: cover; border-radius: 50%;">' +
                        '</foreignObject>' +
                    '</svg>' +
                '</div>' +
                '<div class="jkmmZm">' +
                    '<span>' +
                        '<span class="author">' + escapeHtml(msg.user.username) + '</span>' +
                        '<span class="date-time" style="display: none;"></span>' +
                        '<a href="#" class="msg-reply-btn" title="Reply" style="margin-left:8px; font-size:11px; opacity:0.5; text-decoration:none;">↩ reply</a>' +
                        '<a href="#" class="msg-pin-btn" title="Pin" style="margin-left:6px; font-size:11px; opacity:0.5; text-decoration:none; color:var(--text-color,#fff);">' + PIN_ICON + '</a>' +
                    '</span>' +
                '</div>' +
            '</div>';

        div.querySelector('.jkmmZm').appendChild(contentDiv);

        div.querySelector('.msg-reply-btn').addEventListener('click', (e) => {
            e.preventDefault();
            replyTarget = { id: msg.id, username: msg.user.username };
            replyBarUser.textContent = msg.user.username;
            replyBar.style.display = '';
            textarea.focus();
        });
        div.querySelector('.msg-pin-btn').addEventListener('click', async (e) => {
            e.preventDefault();
            const res = await fetch(`/api/messages/${msg.id}/pin`, { method: 'PUT' });
            if (res.status === 409) {
                await fetch(`/api/messages/${msg.id}/pin`, { method: 'DELETE' });
            }
        });
        return div;
    }

    if (replyBarCancel) {
        replyBarCancel.addEventListener('click', (e) => {
            e.preventDefault();
            replyTarget = null;
            replyBar.style.display = 'none';
        });
    }

    function showModal() {
        unlockStep1.style.display = '';
        unlockStep2.style.display = 'none';
        if (unlockStep3) unlockStep3.style.display = 'none';
        unlockError.textContent = '';
        if (plaintextInput) plaintextInput.value = '';
        challengeOutput.value = '';
        unlockModal.style.display = 'flex';
    }

    async function fetchAndRenderMessages() {
        const res = await fetch(`/api/channels/${channelId}/messages`);
        if (!res.ok) return;
        const messages = await res.json();
        messageArea.innerHTML = '';
        decryptedCache.clear();
        const ordered = messages.reverse();
        // Sequential so reply quotes can resolve already-rendered parents
        let unreadShown = false;
        for (const m of ordered) {
            if (m.unread && !unreadShown) {
                const divider = document.createElement('div');
                divider.className = 'unread-divider';
                divider.innerHTML = '<span class="unread-text">Unread Messages</span>';
                messageArea.appendChild(divider);
                unreadShown = true;
            }
            messageArea.appendChild(await buildMessageEl(m));
            lastMessageId = m.id;
        }
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        startPolling();
    }

    function renderTyping(users) {
        if (!typingIndicator) return;
        if (!users || users.length === 0) { typingIndicator.textContent = ''; return; }
        const names = users.map(u => u.username).join(', ');
        typingIndicator.textContent = `${names} ${users.length === 1 ? 'is' : 'are'} typing…`;
    }

    async function poll() {
        if (document.visibilityState === 'hidden') return;
        if (!lastMessageId) { await fetchAndRenderMessages(); return; }
        try {
            const res = await fetch(`/api/channels/${channelId}/messages?after=${encodeURIComponent(lastMessageId)}`);
            if (!res.ok) return;
            const { messages, typing } = await res.json();
            renderTyping(typing);
            for (const m of messages) {
                if (document.getElementById(m.id)) { lastMessageId = m.id; continue; }
                const nearBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 80;
                messageArea.appendChild(await buildMessageEl(m));
                lastMessageId = m.id;
                if (nearBottom) scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
        } catch { /* network errors -> retries */ }
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }

    // Search (client-side: server only has ciphertext)
    let searchPanel = null;
    function ensureSearchPanel() {
        if (searchPanel) return searchPanel;
        searchPanel = document.createElement('div');
        searchPanel.style.cssText = 'position:absolute; top:48px; right:12px; width:340px; max-height:50vh; overflow-y:auto; background:var(--bg-secondary,#2b2d31); border:1px solid var(--border-color,#444); border-radius:8px; z-index:500; padding:8px; display:none;';
        document.querySelector('.hpNYLK').style.position = 'relative';
        document.querySelector('.hpNYLK').appendChild(searchPanel);
        return searchPanel;
    }

    if (searchInput) {
        searchInput.addEventListener('input', () => {
            const q = searchInput.value.trim().toLowerCase();
            const panel = ensureSearchPanel();
            if (!q) { panel.style.display = 'none'; return; }
            const hits = [];
            for (const [id, entry] of decryptedCache) {
                if (entry.plaintext.toLowerCase().includes(q)) hits.push({ id, ...entry });
            }
            panel.innerHTML = '';
            if (hits.length === 0) {
                panel.innerHTML = '<div style="padding:8px; font-size:12px; opacity:0.6;">No results in loaded messages.</div>';
            }
            for (const hit of hits.slice(-50).reverse()) {
                const row = document.createElement('div');
                row.style.cssText = 'padding:6px 8px; font-size:13px; cursor:pointer; border-radius:4px;';
                row.innerHTML = '<strong>' + escapeHtml(hit.username) + ':</strong> ' + escapeHtml(hit.plaintext.slice(0, 120));
                row.addEventListener('mouseenter', () => row.style.background = 'var(--bg-tertiary,#1e1f22)');
                row.addEventListener('mouseleave', () => row.style.background = '');
                row.addEventListener('click', () => {
                    const el = document.getElementById(hit.id);
                    if (el) {
                        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        el.style.background = 'rgba(88,101,242,0.25)';
                        setTimeout(() => el.style.background = '', 1500);
                    }
                    panel.style.display = 'none';
                });
                panel.appendChild(row);
            }
            panel.style.display = '';
        });
        searchInput.addEventListener('blur', () => {
            setTimeout(() => { if (searchPanel) searchPanel.style.display = 'none'; }, 200);
        });
    }

    // Pins panel
    let pinsPanel = null;
    if (pinsBtn) {
        pinsBtn.addEventListener('click', async (e) => {
            e.preventDefault();
            if (pinsPanel) { pinsPanel.remove(); pinsPanel = null; return; }
            const res = await fetch(`/api/channels/${channelId}/pins`);
            if (!res.ok) return;
            const pins = await res.json();
            pinsPanel = document.createElement('div');
            pinsPanel.style.cssText = 'position:absolute; top:48px; right:12px; width:340px; max-height:50vh; overflow-y:auto; background:var(--bg-secondary,#2b2d31); border:1px solid var(--border-color,#444); border-radius:8px; z-index:501; padding:8px;';
            document.querySelector('.hpNYLK').style.position = 'relative';
            if (pins.length === 0) {
                pinsPanel.innerHTML = '<div style="padding:8px; font-size:12px; opacity:0.6;">No pinned messages.</div>';
            }
            for (const pin of pins) {
                const text = await decryptContent(pin.content);
                const row = document.createElement('div');
                row.style.cssText = 'padding:6px 8px; font-size:13px; cursor:pointer; border-radius:4px;';
                row.innerHTML = '<strong>' + escapeHtml(pin.user.username) + ':</strong> ' + escapeHtml(text.slice(0, 120));
                row.addEventListener('click', () => {
                    const el = document.getElementById(pin.message_id);
                    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    pinsPanel.remove(); pinsPanel = null;
                });
                pinsPanel.appendChild(row);
            }
            document.querySelector('.hpNYLK').appendChild(pinsPanel);
        });
    }

    getChallengeBtn.addEventListener('click', async () => {
        getChallengeBtn.disabled = true;
        unlockError.textContent = '';
        try {
            const res = await fetch(`/api/servers/${serverId}/challenge`);
            if (!res.ok) {
                const err = await res.json();
                unlockError.textContent = err.error || 'Failed to get challenge';
                return;
            }
            const { challenge } = await res.json();
            challengeOutput.value = challenge;
            unlockStep1.style.display = 'none';
            unlockStep2.style.display = '';
            plaintextInput.focus();
        } catch {
            unlockError.textContent = 'Failed to get challenge';
        } finally {
            getChallengeBtn.disabled = false;
        }
    });

    unlockBtn.addEventListener('click', async () => {
        const plaintext = plaintextInput.value.trim();
        if (!plaintext) return;
        unlockBtn.disabled = true;
        unlockError.textContent = '';
        try {
            const res = await fetch(`/api/servers/${serverId}/unlock`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plaintext })
            });
            if (!res.ok) {
                const err = await res.json();
                unlockError.textContent = err.error || 'Verification failed';
                return;
            }
            isUnlocked = true;

            // Fetch channel key (PGP-wrapped) for E2E decrypt
            const keyRes = await fetch(`/api/channels/${channelId}/key`);
            if (keyRes.ok && unlockStep3 && channelKeyOutput) {
                const { wrappedKey } = await keyRes.json();
                unlockStep2.style.display = 'none';
                channelKeyOutput.value = wrappedKey;
                unlockStep3.style.display = '';
                return;
            }
            unlockModal.style.display = 'none';
            await fetchAndRenderMessages();
        } catch {
            unlockError.textContent = 'Verification failed';
        } finally {
            unlockBtn.disabled = false;
        }
    });

    if (channelKeyBtn) {
        channelKeyBtn.addEventListener('click', async () => {
            const hexKey = channelKeyInput.value.trim();
            if (!hexKey || !/^[0-9a-fA-F]{64}$/.test(hexKey)) {
                unlockError.textContent = 'Channel key must be 64 hex characters (32 bytes)';
                return;
            }
            try {
                const cryptoKey = await Crypto.importKey(hexKey);
                channelKeyCache.set(channelId, cryptoKey);
                unlockModal.style.display = 'none';
                await fetchAndRenderMessages();
            } catch {
                unlockError.textContent = 'Invalid channel key';
            }
        });
    }

    textarea.addEventListener('input', () => {
        if (!isUnlocked) return;
        const now = Date.now();
        if (now - lastTypingPing < TYPING_PING_MS) return;
        lastTypingPing = now;
        fetch(`/api/channels/${channelId}/typing`, { method: 'POST' }).catch(() => {});
    });

    textarea.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isUnlocked) { showModal(); return; }
            const plaintext = textarea.value.trim();
            if (!plaintext) return;

            textarea.disabled = true;
            try {
                const ck = channelKeyCache.get(channelId);
                const content = ck ? await Crypto.encrypt(plaintext, ck) : plaintext;

                const body = { content };
                if (replyTarget) body.replyToId = replyTarget.id;

                const res = await fetch('/api/channels/' + channelId + '/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) {
                    const err = await res.json();
                    if (res.status === 403 && err.error === 'Server locked') {
                        isUnlocked = false;
                        showModal();
                    }
                    return;
                }
                const msg = await res.json();
                msg.user = { uid: msg.user_id, username, ownPfp };

                textarea.value = '';
                replyTarget = null;
                replyBar.style.display = 'none';
                messageArea.appendChild(await buildMessageEl(msg));
                lastMessageId = msg.id;
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            } catch (err) {
                console.error(err);
            } finally {
                textarea.disabled = false;
                textarea.focus();
            }
        }
    });

    if (!isUnlocked) {
        showModal();
    } else {
        fetchAndRenderMessages();
    }
}

(() => {
    const POLL_INTERVAL_MS = 3000;
    const TYPING_PING_MS = 4000;
    const LOCK_ICON = '<svg viewBox="0 0 16 16" width="11" height="11" fill="currentColor" style="vertical-align:-1px;"><path d="M8 1a2 2 0 0 1 2 2v4H6V3a2 2 0 0 1 2-2zm3 6V3a3 3 0 0 0-6 0v4a2 2 0 0 0-2 2v5a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z"/></svg>';

    // AES-256-GCM via WebCrypto — same scheme as channel messages (12B IV prefix, zero-padded blocks)
    const PAD_BLOCK = 256;
    const AesCrypto = {
        async importKey(hexKey) {
            const raw = hexKey.match(/.{2}/g).map(b => parseInt(b, 16));
            return crypto.subtle.importKey('raw', new Uint8Array(raw), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
        },
        async encrypt(plaintext, cryptoKey) {
            const bytes = new TextEncoder().encode(plaintext);
            const padded = new Uint8Array(bytes.length + (PAD_BLOCK - (bytes.length % PAD_BLOCK)));
            padded.set(bytes);
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, cryptoKey, padded);
            const out = new Uint8Array(12 + ciphertext.byteLength);
            out.set(iv, 0);
            out.set(new Uint8Array(ciphertext), 12);
            return btoa(String.fromCharCode(...out));
        },
        async decrypt(b64, cryptoKey) {
            const buf = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
            const plain = new Uint8Array(await crypto.subtle.decrypt(
                { name: 'AES-GCM', iv: buf.slice(0, 12) }, cryptoKey, buf.slice(12)));
            let end = plain.length;
            while (end > 0 && plain[end - 1] === 0) end--;
            return new TextDecoder().decode(plain.slice(0, end));
        }
    };

    const unlockModal = document.getElementById('dm-unlock-modal');
    const step1 = document.getElementById('dm-unlock-step-1');
    const step2 = document.getElementById('dm-unlock-step-2');
    const getChallengeBtn = document.getElementById('dm-get-challenge-btn');
    const challengeOutput = document.getElementById('dm-challenge-output');
    const plaintextInput = document.getElementById('dm-plaintext-input');
    const unlockBtn = document.getElementById('dm-unlock-btn');
    const errorEl = document.getElementById('dm-unlock-error');

    const ctx = document.getElementById('dm-context');
    if (!ctx) return;

    const partnerId = ctx.dataset.partnerId || null;
    const partnerUsername = ctx.dataset.partnerUsername;
    const partnerPfp = ctx.dataset.partnerPfp || '/assets/1759430838.png';
    const ownUid = parseInt(ctx.dataset.ownUid, 10);
    const ownUsername = ctx.dataset.ownUsername;
    const ownPfp = ctx.dataset.ownPfp || '/assets/1759430838.png';
    let encryptionMode = ctx.dataset.encryptionMode;
    const isSelfChat = partnerId !== null && parseInt(partnerId, 10) === ownUid;
    let isUnlocked = ctx.dataset.unlocked === 'true';

    const dmList = document.getElementById('dm-list');
    const messageArea = document.getElementById('dm-message-area');
    const scrollContainer = document.querySelector('.messageAreaPadding');
    const input = document.getElementById('dm-input');
    const typingIndicator = document.getElementById('dm-typing-indicator');

    let lastMessageId = null;
    let pollTimer = null;
    let listTimer = null;
    let lastTypingPing = 0;
    let lastListJson = '';
    let replyTarget = null; // { id, username }
    let dmAesKey = null; // CryptoKey, memory only

    const replyBar = document.getElementById('dm-reply-bar');
    const replyBarUser = document.getElementById('dm-reply-bar-user');
    const replyBarCancel = document.getElementById('dm-reply-bar-cancel');

    // messageId -> { plaintext, username } — feeds reply quotes (plaintext DMs only)
    const messageCache = new Map();

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    // --- Conversation list (runs on every DM page so new DMs show up) ---
    function renderConvoList(convos) {
        if (!dmList) return;
        dmList.innerHTML = '';
        if (convos.length === 0) {
            dmList.innerHTML = '<div style="padding:12px; font-size:12px; color:var(--text-muted,#aaa); opacity:0.7;">No conversations yet.<br>Click a user\'s profile to start one.</div>';
            return;
        }
        for (const c of convos) {
            const active = partnerId !== null && String(c.partnerId) === String(partnerId);
            const a = document.createElement('a');
            a.href = '/dm/' + c.partnerId;
            const item = document.createElement('div');
            item.className = '_item_1avxi_1 _compact_1avxi_19';
            item.style.cssText = 'display:flex; align-items:center; gap:8px;' + (active ? ' background: var(--accent-color) !important;' : '');
            item.innerHTML =
                '<svg width="28" height="28" viewBox="0 0 32 32" style="flex-shrink:0;">' +
                    '<foreignObject x="0" y="0" width="32" height="32">' +
                        '<img src="' + escapeHtml(c.ownPfp || '/assets/1759430838.png') + '" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' +
                    '</foreignObject>' +
                '</svg>' +
                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHtml(c.username) + '</span>' +
                '<span class="dm-unread-badge" data-partner-id="' + escapeHtml(String(c.partnerId)) + '" style="margin-left:auto; background:var(--accent-color,#5865f2); color:#fff; border-radius:10px; font-size:10px; padding:1px 6px;' + (c.unread && !active ? '' : ' display:none;') + '">' + (c.unread || '') + '</span>' +
                (c.encryptionMode !== 'none' ? '<span style="opacity:0.6; color:var(--text-color,#fff);" title="' + (c.encryptionMode === 'pgp' ? 'PGP' : 'AES') + ' encrypted">' + LOCK_ICON + '</span>' : '');
            a.appendChild(item);
            dmList.appendChild(a);
        }
    }

    async function refreshConvoList() {
        if (!isUnlocked || document.visibilityState === 'hidden') return;
        try {
            const res = await fetch('/api/dms');
            if (!res.ok) return;
            const convos = await res.json();
            const json = JSON.stringify(convos);
            if (json === lastListJson) return;
            lastListJson = json;
            renderConvoList(convos);
        } catch { /* transient */ }
    }

    function startListPolling() {
        if (listTimer) return;
        listTimer = setInterval(refreshConvoList, POLL_INTERVAL_MS);
        refreshConvoList();
    }

    // --- Per-conversation chat ---
    const ARMOR_START = '-----BEGIN PGP MESSAGE-----';
    const ARMOR_END = '-----END PGP MESSAGE-----';

    function isArmored(text) {
        return typeof text === 'string'
            && text.trim().startsWith(ARMOR_START)
            && text.includes(ARMOR_END);
    }

    // Pasted-back plaintext per message id — memory only, never sent anywhere
    const decryptedLocal = new Map();

    function buildPgpCard(msg) {
        const card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-tertiary,#1e1f22); border:1px solid var(--border-color,#444); border-radius:6px; padding:8px 10px; max-width:520px;';

        const sizeKb = (msg.content.length / 1024).toFixed(1);
        const head = document.createElement('div');
        head.style.cssText = 'display:flex; align-items:center; gap:8px; font-size:12px; color:var(--text-muted,#aaa);';
        head.innerHTML = '<span>' + LOCK_ICON + ' PGP message · ' + sizeKb + ' KB</span>';

        const btn = (label) => {
            const b = document.createElement('button');
            b.textContent = label;
            b.style.cssText = 'padding:2px 8px; font-size:11px; cursor:pointer; background:transparent; color:var(--text-color,#fff); border:1px solid var(--border-color,#444); border-radius:4px;';
            return b;
        };

        const copyBtn = btn('Copy');
        copyBtn.addEventListener('click', () => {
            navigator.clipboard.writeText(msg.content).then(() => {
                copyBtn.textContent = 'Copied!';
                setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
            });
        });

        const expandBtn = btn('Show armor');
        const decryptBtn = btn('Paste decrypted');

        head.appendChild(copyBtn);
        head.appendChild(expandBtn);
        head.appendChild(decryptBtn);
        card.appendChild(head);

        const body = document.createElement('div');
        card.appendChild(body);

        const armorPre = document.createElement('pre');
        armorPre.textContent = msg.content;
        armorPre.style.cssText = 'display:none; font-family:monospace; font-size:10px; color:var(--text-muted,#aaa); white-space:pre-wrap; word-break:break-all; max-height:200px; overflow-y:auto; margin:8px 0 0;';
        body.appendChild(armorPre);

        expandBtn.addEventListener('click', () => {
            const open = armorPre.style.display !== 'none';
            armorPre.style.display = open ? 'none' : '';
            expandBtn.textContent = open ? 'Show armor' : 'Hide armor';
        });

        const plainWrap = document.createElement('div');
        body.appendChild(plainWrap);

        function showPlaintext(text) {
            plainWrap.innerHTML = '';
            const tag = document.createElement('div');
            tag.textContent = 'decrypted locally';
            tag.style.cssText = 'font-size:10px; color:var(--text-muted,#aaa); opacity:0.7; margin-top:6px;';
            const p = document.createElement('p');
            p.className = 'textContent';
            p.textContent = text;
            p.style.marginTop = '2px';
            plainWrap.appendChild(tag);
            plainWrap.appendChild(p);
            decryptBtn.style.display = 'none';
        }

        if (decryptedLocal.has(msg.id)) showPlaintext(decryptedLocal.get(msg.id));

        decryptBtn.addEventListener('click', () => {
            if (plainWrap.querySelector('textarea')) return;
            const ta = document.createElement('textarea');
            ta.rows = 3;
            ta.placeholder = 'Paste decrypted plaintext here (stays in this browser tab only)';
            ta.style.cssText = 'width:100%; box-sizing:border-box; margin-top:6px; font-size:12px; background:var(--input-bg,#383a40); color:var(--text-color,#fff); border:1px solid var(--border-color,#444); border-radius:4px; padding:6px; resize:vertical;';
            const show = btn('Show');
            show.style.marginTop = '4px';
            show.addEventListener('click', () => {
                const text = ta.value.trim();
                if (!text) return;
                decryptedLocal.set(msg.id, text);
                showPlaintext(text);
            });
            plainWrap.appendChild(ta);
            plainWrap.appendChild(show);
            ta.focus();
        });

        return card;
    }

    async function buildMessageEl(msg) {
        const isMine = msg.sender_id === ownUid;
        const pfpSrc = isMine ? ownPfp : partnerPfp;
        const uname = isMine ? ownUsername : partnerUsername;

        const isPgp = msg.content && (msg.encryption_mode === 'pgp' || isArmored(msg.content));
        const isAes = msg.content && !isPgp && msg.encryption_mode === 'aes';

        let content = msg.content || '[message destroyed]';
        if (isAes) {
            if (dmAesKey) {
                try { content = await AesCrypto.decrypt(msg.content, dmAesKey); }
                catch { content = '[decryption failed]'; }
            } else {
                content = '[encrypted, unlock AES first]';
            }
        }
        if (msg.content && !isPgp && content !== '[decryption failed]' && content !== '[encrypted, unlock AES first]') {
            messageCache.set(msg.id, { plaintext: content, username: uname });
        }

        const div = document.createElement('div');
        div.id = msg.id;
        div.innerHTML =
            '<div class="jCxwsP">' +
                '<div class="csvICB" data-profile-user-id="' + escapeHtml(String(msg.sender_id || '')) + '" data-profile-username="' + escapeHtml(uname) + '" data-profile-pfp="' + escapeHtml(pfpSrc) + '" style="cursor:pointer;">' +
                    '<svg width="36" height="36" viewBox="0 0 32 32">' +
                        '<foreignObject x="0" y="0" width="32" height="32">' +
                            '<img src="' + escapeHtml(pfpSrc) + '" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">' +
                        '</foreignObject>' +
                    '</svg>' +
                '</div>' +
                '<div class="jkmmZm">' +
                    '<span>' +
                        '<span class="author">' + escapeHtml(uname) + '</span>' +
                        '<a href="#" class="dm-reply-btn" title="Reply" style="margin-left:8px; font-size:11px; opacity:0.5; text-decoration:none;">↩ reply</a>' +
                    '</span>' +
                '</div>' +
            '</div>';

        const slot = div.querySelector('.jkmmZm');

        if (msg.reply_to_id) {
            const quoted = messageCache.get(msg.reply_to_id);
            const quote = document.createElement('p');
            quote.className = 'textContent';
            quote.style.cssText = 'font-size:12px; opacity:0.6; border-left:2px solid var(--accent-color,#5865f2); padding-left:6px; margin:0 0 2px; cursor:pointer;';
            quote.textContent = quoted
                ? `↩ ${quoted.username}: ${quoted.plaintext.slice(0, 100)}`
                : '↩ encrypted message';
            quote.addEventListener('click', () => {
                const target = document.getElementById(msg.reply_to_id);
                if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
            });
            slot.appendChild(quote);
        }

        div.querySelector('.dm-reply-btn').addEventListener('click', (e) => {
            e.preventDefault();
            replyTarget = { id: msg.id, username: uname };
            replyBarUser.textContent = uname;
            replyBar.style.display = '';
            input.focus();
        });
        if (isPgp) {
            slot.appendChild(buildPgpCard(msg));
        } else {
            const wrap = document.createElement('div');
            wrap.id = 'message-content';
            const p = document.createElement('p');
            p.className = 'textContent';
            p.textContent = content;
            wrap.appendChild(p);
            slot.appendChild(wrap);
        }
        return div;
    }

    if (replyBarCancel) {
        replyBarCancel.addEventListener('click', (e) => {
            e.preventDefault();
            replyTarget = null;
            replyBar.style.display = 'none';
        });
    }

    async function fetchAndRender() {
        const res = await fetch(`/api/dms/${partnerId}/messages`);
        if (!res.ok) return;
        const messages = await res.json();
        messageArea.innerHTML = '';
        // Sequential so reply quotes can resolve already-rendered parents
        for (const m of messages.slice().reverse()) {
            messageArea.appendChild(await buildMessageEl(m));
            lastMessageId = m.id;
        }
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        startPolling();
    }

    function renderTyping(users) {
        if (!typingIndicator) return;
        typingIndicator.textContent = users && users.length
            ? `${partnerUsername} is typing…` : '';
    }

    async function poll() {
        if (document.visibilityState === 'hidden') return;
        if (!lastMessageId) { await fetchAndRender(); return; }
        try {
            const res = await fetch(`/api/dms/${partnerId}/messages?after=${encodeURIComponent(lastMessageId)}`);
            if (!res.ok) return;
            const { messages, typing } = await res.json();
            renderTyping(typing);
            for (const m of messages) {
                if (document.getElementById(m.id)) { lastMessageId = m.id; continue; }
                messageArea.appendChild(await buildMessageEl(m));
                lastMessageId = m.id;
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            }
        } catch { /* transient */ }
    }

    function startPolling() {
        if (pollTimer) return;
        pollTimer = setInterval(poll, POLL_INTERVAL_MS);
    }

    function showUnlockModal() {
        step1.style.display = '';
        step2.style.display = 'none';
        errorEl.textContent = '';
        plaintextInput.value = '';
        challengeOutput.value = '';
        unlockModal.style.display = 'flex';
    }

    getChallengeBtn.addEventListener('click', async () => {
        getChallengeBtn.disabled = true;
        errorEl.textContent = '';
        try {
            const res = await fetch('/api/dm/challenge');
            if (!res.ok) { errorEl.textContent = (await res.json()).error || 'Failed'; return; }
            const { challenge } = await res.json();
            challengeOutput.value = challenge;
            step1.style.display = 'none';
            step2.style.display = '';
            plaintextInput.focus();
        } catch { errorEl.textContent = 'Failed to get challenge'; }
        finally { getChallengeBtn.disabled = false; }
    });

    unlockBtn.addEventListener('click', async () => {
        const plaintext = plaintextInput.value.trim();
        if (!plaintext) return;
        unlockBtn.disabled = true;
        errorEl.textContent = '';
        try {
            const res = await fetch('/api/dm/unlock', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plaintext })
            });
            if (!res.ok) { errorEl.textContent = (await res.json()).error || 'Verification failed'; return; }
            isUnlocked = true;
            unlockModal.style.display = 'none';
            startListPolling();
            if (partnerId) await openConversation();
        } catch { errorEl.textContent = 'Verification failed'; }
        finally { unlockBtn.disabled = false; }
    });

    // --- AES conversation key ---
    const aesModal = document.getElementById('dm-aes-modal');
    const aesWrapped = document.getElementById('dm-aes-wrapped');
    const aesHexInput = document.getElementById('dm-aes-hex-input');
    const aesUnlockBtn = document.getElementById('dm-aes-unlock-btn');
    const aesCancelBtn = document.getElementById('dm-aes-cancel-btn');
    const aesError = document.getElementById('dm-aes-error');

    // Shows the unwrap modal; resolves true once a valid key is imported, false on cancel
    function promptAesUnlock(wrappedKey) {
        return new Promise((resolve) => {
            aesWrapped.value = wrappedKey;
            aesHexInput.value = '';
            aesError.textContent = '';
            aesModal.style.display = 'flex';
            aesHexInput.focus();

            aesUnlockBtn.onclick = async () => {
                const hex = aesHexInput.value.trim();
                if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
                    aesError.textContent = 'Key must be 64 hex characters (32 bytes)';
                    return;
                }
                try {
                    dmAesKey = await AesCrypto.importKey(hex);
                    aesModal.style.display = 'none';
                    resolve(true);
                } catch {
                    aesError.textContent = 'Invalid key';
                }
            };
            aesCancelBtn.onclick = () => {
                aesModal.style.display = 'none';
                resolve(false);
            };
        });
    }

    async function fetchPubkey(userId) {
        const res = await fetch(`/api/users/${userId}/pubkey`);
        if (!res.ok) return null;
        return (await res.json()).armoredKey;
    }

    // First use of AES mode: generate key in-browser, wrap to both parties' PGP keys, distribute
    async function setupAesKey() {
        const ownArmor = await fetchPubkey(ownUid);
        const partnerArmor = isSelfChat ? ownArmor : await fetchPubkey(partnerId);
        if (!ownArmor || !partnerArmor) {
            alert('Both participants need a verified PGP key for AES mode.');
            return false;
        }

        const raw = crypto.getRandomValues(new Uint8Array(32));
        const hex = Array.from(raw).map(b => b.toString(16).padStart(2, '0')).join('');

        const wrapFor = async (armoredKey) => openpgp.encrypt({
            message: await openpgp.createMessage({ text: hex }),
            encryptionKeys: await openpgp.readKey({ armoredKey })
        });

        const keys = [{ userId: ownUid, wrappedKey: await wrapFor(ownArmor) }];
        if (!isSelfChat) keys.push({ userId: parseInt(partnerId, 10), wrappedKey: await wrapFor(partnerArmor) });

        const res = await fetch(`/api/dms/${partnerId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ keys })
        });
        if (!res.ok) {
            alert((await res.json()).error || 'Failed to distribute key');
            return false;
        }
        dmAesKey = await AesCrypto.importKey(hex); // creator already knows the key — no unwrap needed
        return true;
    }

    // Returns true once dmAesKey is loaded (existing key unwrapped, or new key generated)
    async function ensureAesKey() {
        if (dmAesKey) return true;
        const res = await fetch(`/api/dms/${partnerId}/key`);
        if (res.ok) {
            const { wrappedKey } = await res.json();
            return promptAesUnlock(wrappedKey);
        }
        if (res.status === 404) return setupAesKey();
        return false;
    }

    // --- Encryption mode select ---
    const modeSelect = document.getElementById('dm-mode-select');
    if (modeSelect && partnerId) {
        modeSelect.addEventListener('change', async () => {
            if (!isUnlocked) { modeSelect.value = encryptionMode; showUnlockModal(); return; }
            const next = modeSelect.value;
            modeSelect.disabled = true;
            try {
                if (next === 'aes' && !(await ensureAesKey())) {
                    modeSelect.value = encryptionMode;
                    return;
                }
                const res = await fetch(`/api/dms/${partnerId}/settings`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ encryptionMode: next })
                });
                if (!res.ok) { modeSelect.value = encryptionMode; return; }
                if (next === 'aes') {
                    // Stay on the page — reloading would lose the freshly generated in-memory key
                    encryptionMode = 'aes';
                    await fetchAndRender();
                } else {
                    location.reload();
                }
            } finally { modeSelect.disabled = false; }
        });
    }

    const armorStatus = document.getElementById('dm-armor-status');
    function updateArmorStatus() {
        if (!armorStatus || encryptionMode !== 'pgp') return;
        const v = input.value.trim();
        if (!v) { armorStatus.textContent = ''; return; }
        if (isArmored(v)) {
            armorStatus.textContent = '✓ valid PGP message';
            armorStatus.style.color = '#43b581';
        } else {
            armorStatus.textContent = '✗ not an armored PGP message';
            armorStatus.style.color = '#f04747';
        }
    }

    if (input) {
        input.addEventListener('input', () => {
            updateArmorStatus();
            if (!isUnlocked || isSelfChat) return;
            const now = Date.now();
            if (now - lastTypingPing < TYPING_PING_MS) return;
            lastTypingPing = now;
            fetch(`/api/dms/${partnerId}/typing`, { method: 'POST' }).catch(() => {});
        });

        input.addEventListener('keydown', async (e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            e.preventDefault();
            if (!isUnlocked) { showUnlockModal(); return; }
            let content = input.value.trim();
            if (!content) return;
            if (encryptionMode === 'pgp' && !isArmored(content)) {
                updateArmorStatus();
                return; // server would reject it anyway
            }
            if (encryptionMode === 'aes') {
                if (!dmAesKey && !(await ensureAesKey())) return;
                content = await AesCrypto.encrypt(content, dmAesKey);
            }
            input.disabled = true;
            try {
                const body = { content };
                if (replyTarget) body.replyToId = replyTarget.id;
                const res = await fetch(`/api/dms/${partnerId}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body)
                });
                if (!res.ok) {
                    if (res.status === 403) { isUnlocked = false; showUnlockModal(); }
                    return;
                }
                const msg = await res.json();
                input.value = '';
                replyTarget = null;
                if (replyBar) replyBar.style.display = 'none';
                if (armorStatus) armorStatus.textContent = '';
                messageArea.appendChild(await buildMessageEl(msg));
                lastMessageId = msg.id;
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            } catch (err) { console.error(err); }
            finally { input.disabled = false; input.focus(); }
        });
    }

    // Init
    async function openConversation() {
        if (encryptionMode === 'aes') await ensureAesKey(); // cancel still renders, with locked placeholders
        await fetchAndRender();
    }

    if (!isUnlocked) {
        showUnlockModal();
    } else {
        startListPolling();
        if (partnerId) openConversation();
    }
})();

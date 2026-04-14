const chatContainer = document.getElementById('chat-context');
if (chatContainer) {
    const channelId = chatContainer.dataset.channelId;
    const serverId = chatContainer.dataset.serverId;
    const username = chatContainer.dataset.username;
    const ownPfp = chatContainer.dataset.ownPfp;
    const textarea = document.getElementById('userprompt');
    const messageArea = document.querySelector('.messageArea');
    const scrollContainer = document.querySelector('.messageAreaPadding');

    const unlockModal = document.getElementById('unlock-modal');
    const unlockStep1 = document.getElementById('unlock-step-1');
    const unlockStep2 = document.getElementById('unlock-step-2');
    const getChallengeBtn = document.getElementById('unlock-get-challenge-btn');
    const challengeOutput = document.getElementById('unlock-challenge-output');
    const plaintextInput = document.getElementById('unlock-plaintext-input');
    const unlockBtn = document.getElementById('unlock-btn');
    const unlockError = document.getElementById('unlock-error');

    let isUnlocked = chatContainer.dataset.unlocked === 'true';

    function escapeHtml(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function buildMessageEl(msg) {
        const pfpSrc = msg.user.ownPfp && msg.user.ownPfp !== 'null'
            ? msg.user.ownPfp
            : '/assets/1759430838.png';

        const div = document.createElement('div');
        div.id = msg.id;
        div.className = 'msg-row';
        if (msg.frank_key) div.dataset.frankKey = msg.frank_key;

        const contentDiv = document.createElement('div');
        contentDiv.id = 'message-content';
        const p = document.createElement('p');
        p.className = 'textContent';
        p.textContent = msg.content;
        contentDiv.appendChild(p);

        const isOwn = msg.user.username === username;
        div.innerHTML =
            '<div class="jCxwsP">' +
                '<div class="csvICB">' +
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
                    '</span>' +
                '</div>' +
            '</div>' +
            (isOwn ? '<button class="msg-edit-btn" data-message-id="' + escapeHtml(msg.id) + '" title="Edit message">&#9998;</button>' : '') +
            '<button class="msg-report-btn" data-message-id="' + escapeHtml(msg.id) + '" title="Report message">&#9888;</button>';

        div.querySelector('.jkmmZm').appendChild(contentDiv);
        return div;
    }

    function showModal() {
        // Reset to step 1
        unlockStep1.style.display = '';
        unlockStep2.style.display = 'none';
        unlockError.textContent = '';
        plaintextInput.value = '';
        challengeOutput.value = '';
        unlockModal.style.display = 'flex';
    }

    async function fetchAndRenderMessages() {
        const res = await fetch(`/api/channels/${channelId}/messages`);
        if (!res.ok) return;
        const messages = await res.json();
        messageArea.innerHTML = '';
        messages.reverse().forEach(m => {
            messageArea.appendChild(buildMessageEl(m));
        });
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
    }

    // Step 1: request challenge from server
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

    // Step 2: submit decrypted plaintext
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
            unlockModal.style.display = 'none';
            await fetchAndRenderMessages();
            setInterval(pollNewMessages, 2000);
        } catch {
            unlockError.textContent = 'Verification failed';
        } finally {
            unlockBtn.disabled = false;
        }
    });

    textarea.addEventListener('keydown', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (!isUnlocked) { showModal(); return; }
            const plaintext = textarea.value.trim();
            if (!plaintext) return;

            textarea.disabled = true;
            try {
                const res = await fetch('/api/channels/' + channelId + '/messages', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: plaintext })
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
                messageArea.appendChild(buildMessageEl(msg));
                scrollContainer.scrollTop = scrollContainer.scrollHeight;
            } catch (err) {
                console.error(err);
            } finally {
                textarea.disabled = false;
                textarea.focus();
            }
        }
    });

    // Message actions (edit + report)
    messageArea.addEventListener('click', async (e) => {
        if (!e.target.classList.contains('msg-edit-btn')) return;

        const btn = e.target;
        const messageId = btn.dataset.messageId;
        const msgRow = document.getElementById(messageId);
        if (!msgRow) return;

        const contentEl = msgRow.querySelector('p.textContent');
        if (!contentEl) return;
        const originalText = contentEl.textContent;

        const editArea = document.createElement('div');
        editArea.className = 'msg-edit-area';

        const ta = document.createElement('textarea');
        ta.className = 'msg-edit-textarea';
        ta.value = originalText;

        const saveBtn = document.createElement('button');
        saveBtn.className = 'msg-edit-save';
        saveBtn.textContent = 'Save';

        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'msg-edit-cancel';
        cancelBtn.textContent = 'Cancel';

        const errorEl = document.createElement('span');
        errorEl.className = 'msg-edit-error';

        editArea.appendChild(ta);
        editArea.appendChild(saveBtn);
        editArea.appendChild(cancelBtn);
        editArea.appendChild(errorEl);
        contentEl.replaceWith(editArea);
        ta.focus();

        cancelBtn.addEventListener('click', () => {
            editArea.replaceWith(contentEl);
        });

        const doSave = async () => {
            const newText = ta.value.trim();
            if (!newText) return;
            saveBtn.disabled = true;
            errorEl.textContent = '';
            try {
                const res = await fetch(`/api/messages/${messageId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ content: newText })
                });
                if (!res.ok) {
                    const err = await res.json();
                    if (res.status === 403 && err.error === 'Server locked') {
                        isUnlocked = false;
                        editArea.replaceWith(contentEl);
                        showModal();
                    } else {
                        errorEl.textContent = err.error || 'Edit failed';
                        saveBtn.disabled = false;
                    }
                    return;
                }
                const data = await res.json();
                const newP = document.createElement('p');
                newP.className = 'textContent';
                newP.textContent = data.content;
                const editedLabel = document.createElement('span');
                editedLabel.className = 'msg-edited-label';
                editedLabel.textContent = ' (edited)';
                newP.appendChild(editedLabel);
                editArea.replaceWith(newP);
            } catch {
                errorEl.textContent = 'Edit failed';
                saveBtn.disabled = false;
            }
        };

        saveBtn.addEventListener('click', doSave);
        ta.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSave(); }
            if (e.key === 'Escape') { cancelBtn.click(); }
        });
    });

    async function pollNewMessages() {
        if (!isUnlocked) return;
        const last = messageArea.lastElementChild;
        if (!last?.id) return;
        try {
            const res = await fetch(`/api/channels/${channelId}/messages?after=${last.id}`);
            if (!res.ok) return;
            const messages = await res.json();
            if (!messages.length) return;
            const atBottom = scrollContainer.scrollHeight - scrollContainer.scrollTop - scrollContainer.clientHeight < 80;
            messages.forEach(m => {
                if (!document.getElementById(m.id)) {
                    messageArea.appendChild(buildMessageEl(m));
                }
            });
            if (atBottom) scrollContainer.scrollTop = scrollContainer.scrollHeight;
        } catch {}
    }

    // Init
    if (!isUnlocked) {
        showModal();
    } else {
        fetchAndRenderMessages();
        setInterval(pollNewMessages, 2000);
    }
}

(function () {
    const overlay = document.getElementById('server-settings-overlay');
    if (!overlay) return;

    const serverId = overlay.dataset.serverId;
    const isOwner = overlay.dataset.isOwner === 'true';

    // Open / close
    const gearBtn = document.querySelector('a[href="#server-settings"]');
    if (gearBtn) {
        gearBtn.addEventListener('click', (e) => {
            e.preventDefault();
            overlay.style.display = 'grid';
            loadChannels();
        });
    }

    overlay.addEventListener('click', (e) => {
        if (e.target === overlay) closeSettings();
    });

    function closeSettings() {
        overlay.style.display = 'none';
    }

    // Section nav
    document.querySelectorAll('.ss-nav a[data-section]').forEach(link => {
        link.addEventListener('click', (e) => {
            e.preventDefault();
            document.querySelectorAll('.ss-nav a[data-section]').forEach(l => l.classList.remove('active'));
            link.classList.add('active');

            document.querySelectorAll('.ss-section').forEach(sec => sec.classList.remove('active'));
            const target = document.getElementById(link.dataset.section);
            if (target) target.classList.add('active');

            // Lazy load section data
            if (link.dataset.section === 'ss-channels') loadChannels();
            if (link.dataset.section === 'ss-members') loadMembers();
        });
    });

    // Escape key to close
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && overlay.style.display === 'grid') closeSettings();
    });

    // ── Sync channel sidebar ──
    const channelSidebar = document.querySelector('.channelsSidebar');
    const chatCtx = document.getElementById('chat-context');
    const activeChannelId = chatCtx ? chatCtx.dataset.channelId : null;

    async function refreshChannelSidebar() {
        if (!channelSidebar) return;
        try {
            const res = await fetch(`/api/servers/${serverId}/channels`);
            if (!res.ok) return;
            const channels = await res.json();

            channelSidebar.innerHTML = '';
            channels.forEach(ch => {
                const a = document.createElement('a');
                a.href = `/server/${serverId}/channel/${ch.id}`;

                const div = document.createElement('div');
                div.className = '_item_1avxi_1 _compact_1avxi_19';
                if (ch.id === activeChannelId) {
                    div.style.background = 'var(--accent-color)';
                }
                div.textContent = ch.name;

                a.appendChild(div);
                channelSidebar.appendChild(a);
            });
        } catch (_) {}
    }

    // Helper: HTML escape
    function esc(str) {
        const d = document.createElement('div');
        d.textContent = str;
        return d.innerHTML;
    }

    function setStatus(id, msg, isError) {
        const el = document.getElementById(id);
        if (!el) return;
        el.textContent = msg;
        el.className = isError ? 'ss-status error' : 'ss-status';
    }

    // ── Overview ──
    if (isOwner) {
        const saveBtn = document.getElementById('ss-save-overview');
        if (saveBtn) {
            saveBtn.addEventListener('click', async () => {
                const nameInput = document.getElementById('ss-server-name');
                const iconInput = document.getElementById('ss-server-icon');
                const name = nameInput.value.trim();

                if (!name) {
                    setStatus('ss-overview-status', 'Name cannot be empty', true);
                    return;
                }

                saveBtn.disabled = true;
                try {
                    const body = { name };
                    const iconVal = iconInput.value.trim();
                    if (iconVal !== '') body.icon = iconVal;

                    const res = await fetch(`/api/servers/${serverId}`, {
                        method: 'PATCH',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(body)
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Update failed');

                    setStatus('ss-overview-status', 'Saved!', false);

                    // Update page elements
                    const headerTitle = document.querySelector('.channelsHeader .title');
                    if (headerTitle && data.name) headerTitle.textContent = data.name;

                    // Update delete confirmation placeholder
                    const confirmInput = document.getElementById('ss-confirm-delete');
                    if (confirmInput && data.name) confirmInput.placeholder = data.name;
                } catch (err) {
                    setStatus('ss-overview-status', err.message, true);
                } finally {
                    saveBtn.disabled = false;
                }
            });
        }
    }

    // ── Channels ──
    let sortableInstance = null;

    async function loadChannels() {
        const list = document.getElementById('ss-channel-list');
        if (!list) return;
        list.innerHTML = '';

        try {
            const res = await fetch(`/api/servers/${serverId}/channels`);
            if (!res.ok) throw new Error('Failed to load channels');
            const channels = await res.json();

            channels.forEach(ch => {
                list.appendChild(createChannelItem(ch));
            });

            // Init SortableJS for owner
            if (isOwner && typeof Sortable !== 'undefined') {
                if (sortableInstance) sortableInstance.destroy();
                sortableInstance = new Sortable(list, {
                    handle: '.ss-drag-handle',
                    ghostClass: 'sortable-ghost',
                    chosenClass: 'sortable-chosen',
                    animation: 150,
                    onEnd: async () => {
                        const orderedIds = Array.from(list.querySelectorAll('.ss-channel-item'))
                            .map(el => el.dataset.channelId);
                        try {
                            const r = await fetch(`/api/servers/${serverId}/channels/reorder`, {
                                method: 'PATCH',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ orderedIds })
                            });
                            if (!r.ok) {
                                const d = await r.json();
                                throw new Error(d.error || 'Reorder failed');
                            }
                            setStatus('ss-channels-status', 'Order saved', false);
                            refreshChannelSidebar();
                        } catch (err) {
                            setStatus('ss-channels-status', err.message, true);
                        }
                    }
                });
            }
        } catch (err) {
            setStatus('ss-channels-status', err.message, true);
        }
    }

    function createChannelItem(ch) {
        const div = document.createElement('div');
        div.className = 'ss-channel-item';
        div.dataset.channelId = ch.id;

        if (isOwner) {
            const drag = document.createElement('span');
            drag.className = 'ss-drag-handle';
            drag.textContent = '⠿';
            div.appendChild(drag);
        }

        const nameSpan = document.createElement('span');
        nameSpan.className = 'ss-channel-name';
        nameSpan.textContent = ch.name;
        div.appendChild(nameSpan);

        if (isOwner) {
            const actions = document.createElement('span');
            actions.className = 'ss-channel-actions';

            // Rename
            const renameBtn = document.createElement('button');
            renameBtn.className = 'ss-btn ss-btn-secondary ss-btn-small';
            renameBtn.textContent = 'Rename';
            renameBtn.addEventListener('click', () => startRename(div, ch));
            actions.appendChild(renameBtn);

            // Delete
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'ss-btn ss-btn-danger ss-btn-small';
            deleteBtn.textContent = 'Delete';
            deleteBtn.addEventListener('click', () => deleteChannel(div, ch.id));
            actions.appendChild(deleteBtn);

            div.appendChild(actions);
        }

        return div;
    }

    function startRename(itemEl, ch) {
        const nameSpan = itemEl.querySelector('.ss-channel-name');
        const current = nameSpan.textContent;

        const input = document.createElement('input');
        input.type = 'text';
        input.value = current;
        input.maxLength = 100;

        nameSpan.textContent = '';
        nameSpan.appendChild(input);
        input.focus();
        input.select();

        async function commitRename() {
            const newName = input.value.trim();
            if (!newName || newName === current) {
                nameSpan.textContent = current;
                return;
            }

            try {
                const res = await fetch(`/api/channels/${ch.id}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name: newName })
                });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Rename failed');
                nameSpan.textContent = data.name;
                ch.name = data.name;
                setStatus('ss-channels-status', 'Renamed', false);
                refreshChannelSidebar();
            } catch (err) {
                nameSpan.textContent = current;
                setStatus('ss-channels-status', err.message, true);
            }
        }

        input.addEventListener('blur', commitRename);
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
            if (e.key === 'Escape') { nameSpan.textContent = current; }
        });
    }

    async function deleteChannel(itemEl, channelId) {
        if (!confirm('Delete this channel? Messages will be lost.')) return;

        try {
            const res = await fetch(`/api/channels/${channelId}`, { method: 'DELETE' });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Delete failed');
            itemEl.remove();
            setStatus('ss-channels-status', 'Channel deleted', false);
            refreshChannelSidebar();
        } catch (err) {
            setStatus('ss-channels-status', err.message, true);
        }
    }

    // Create channel
    if (isOwner) {
        const createBtn = document.getElementById('ss-create-channel');
        const nameInput = document.getElementById('ss-new-channel-name');
        if (createBtn && nameInput) {
            async function doCreate() {
                const name = nameInput.value.trim();
                if (!name) return;

                createBtn.disabled = true;
                try {
                    const res = await fetch(`/api/servers/${serverId}/channels`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name })
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Create failed');

                    const list = document.getElementById('ss-channel-list');
                    list.appendChild(createChannelItem(data));
                    nameInput.value = '';
                    setStatus('ss-channels-status', 'Channel created', false);
                    refreshChannelSidebar();
                } catch (err) {
                    setStatus('ss-channels-status', err.message, true);
                } finally {
                    createBtn.disabled = false;
                }
            }

            createBtn.addEventListener('click', doCreate);
            nameInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') { e.preventDefault(); doCreate(); }
            });
        }
    }

    // ── Members ──
    async function loadMembers() {
        const list = document.getElementById('ss-member-list');
        if (!list) return;
        list.innerHTML = '';

        try {
            const res = await fetch(`/api/servers/${serverId}/members`);
            if (!res.ok) throw new Error('Failed to load members');
            const members = await res.json();

            members.forEach(m => {
                const div = document.createElement('div');
                div.className = 'ss-member-item';
                div.dataset.userId = m.userId;

                const img = document.createElement('img');
                img.src = m.ownPfp || '/assets/1759430838.png';
                img.alt = m.username;
                div.appendChild(img);

                const info = document.createElement('div');
                info.className = 'ss-member-info';
                const name = document.createElement('span');
                name.className = 'ss-member-name';
                name.textContent = m.username;
                info.appendChild(name);

                if (m.isOwner) {
                    const badge = document.createElement('span');
                    badge.className = 'ss-member-badge';
                    badge.textContent = ' Owner';
                    info.appendChild(badge);
                }
                div.appendChild(info);

                if (isOwner && !m.isOwner) {
                    const kickBtn = document.createElement('button');
                    kickBtn.className = 'ss-btn ss-btn-danger ss-btn-small';
                    kickBtn.textContent = 'Kick';
                    kickBtn.addEventListener('click', async () => {
                        if (!confirm(`Kick ${m.username}?`)) return;
                        kickBtn.disabled = true;
                        try {
                            const r = await fetch(`/api/servers/${serverId}/members/${m.userId}`, {
                                method: 'DELETE'
                            });
                            const d = await r.json();
                            if (!r.ok) throw new Error(d.error || 'Kick failed');
                            div.remove();
                            setStatus('ss-members-status', 'Member kicked', false);
                        } catch (err) {
                            setStatus('ss-members-status', err.message, true);
                            kickBtn.disabled = false;
                        }
                    });
                    div.appendChild(kickBtn);
                }

                list.appendChild(div);
            });
        } catch (err) {
            setStatus('ss-members-status', err.message, true);
        }
    }

    // ── Invites ──
    const createInviteBtn = document.getElementById('ss-create-invite');
    const inviteResult = document.getElementById('ss-invite-result');
    const inviteLink = document.getElementById('ss-invite-link');
    const copyInviteBtn = document.getElementById('ss-copy-invite');

    if (createInviteBtn) {
        createInviteBtn.addEventListener('click', async () => {
            createInviteBtn.disabled = true;
            try {
                const res = await fetch(`/api/servers/${serverId}/invites`, { method: 'POST' });
                const data = await res.json();
                if (!res.ok) throw new Error(data.error || 'Failed to create invite');

                const url = `${location.origin}/invite/${data.code}`;
                inviteLink.value = url;
                inviteResult.style.display = '';
                setStatus('ss-invite-status', '', false);
            } catch (err) {
                setStatus('ss-invite-status', err.message, true);
            } finally {
                createInviteBtn.disabled = false;
            }
        });
    }

    if (copyInviteBtn) {
        copyInviteBtn.addEventListener('click', () => {
            inviteLink.select();
            navigator.clipboard.writeText(inviteLink.value).then(() => {
                setStatus('ss-invite-status', 'Copied!', false);
            }).catch(() => {
                setStatus('ss-invite-status', 'Copy failed', true);
            });
        });
    }

    // ── Danger Zone ──
    if (isOwner) {
        const confirmInput = document.getElementById('ss-confirm-delete');
        const deleteBtn = document.getElementById('ss-delete-server');

        if (confirmInput && deleteBtn) {
            confirmInput.addEventListener('input', () => {
                deleteBtn.disabled = confirmInput.value !== confirmInput.placeholder;
            });

            deleteBtn.addEventListener('click', async () => {
                if (confirmInput.value !== confirmInput.placeholder) return;

                deleteBtn.disabled = true;
                try {
                    const res = await fetch(`/api/servers/${serverId}`, { method: 'DELETE' });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.error || 'Delete failed');
                    window.location.href = '/';
                } catch (err) {
                    deleteBtn.disabled = false;
                    alert(err.message);
                }
            });
        }
    }
})();

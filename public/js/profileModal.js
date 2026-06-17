(() => {
    const modal = document.getElementById('profile-modal');
    if (!modal) return;

    const pfpEl = document.getElementById('profile-modal-pfp');
    const usernameEl = document.getElementById('profile-modal-username');
    const fingerprintEl = document.getElementById('profile-modal-fingerprint');
    const copyBtn = document.getElementById('profile-modal-copy');
    const dmBtn = document.getElementById('profile-modal-dm');
    const closeBtn = document.getElementById('profile-modal-close');
    const errorEl = document.getElementById('profile-modal-error');

    // Own uid, if available on this page, to hide "Send DM" on own profile
    const ownUid = document.getElementById('chat-context')?.dataset.uid
        || document.getElementById('dm-context')?.dataset.ownUid
        || null;

    let loadedKey = '';

    async function openProfile(userId, username, pfp) {
        errorEl.textContent = '';
        loadedKey = '';
        fingerprintEl.textContent = 'Loading…';
        usernameEl.textContent = username || 'Unknown';
        pfpEl.src = pfp && pfp !== 'null' ? pfp : '/assets/1759430838.png';
        pfpEl.alt = username ? username + "'s profile picture" : 'Profile picture';
        const isSelf = ownUid !== null && String(userId) === String(ownUid);
        dmBtn.style.display = userId ? '' : 'none';
        dmBtn.textContent = isSelf ? 'Note to self' : 'Send DM';
        dmBtn.href = '/dm/' + encodeURIComponent(userId);
        modal.style.display = 'flex';

        try {
            const res = await fetch(`/api/users/${userId}/pubkey`);
            if (!res.ok) {
                fingerprintEl.textContent = 'No verified key';
                errorEl.textContent = 'This user has no verified PGP key.';
                return;
            }
            const { armoredKey, fingerprint } = await res.json();
            fingerprintEl.textContent = fingerprint.toUpperCase().match(/.{4}/g).join(' ');
            loadedKey = armoredKey;
        } catch {
            fingerprintEl.textContent = '';
            errorEl.textContent = 'Failed to load key.';
        }
    }

    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', (e) => { if (e.target === modal) modal.style.display = 'none'; });

    copyBtn.addEventListener('click', () => {
        if (!loadedKey) return;
        navigator.clipboard.writeText(loadedKey).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy public key'; }, 1500);
        });
    });

    // Attach to all profile picture clicks via delegation
    document.addEventListener('click', (e) => {
        const pfpTarget = e.target.closest('[data-profile-user-id]');
        if (!pfpTarget) return;
        openProfile(
            pfpTarget.dataset.profileUserId,
            pfpTarget.dataset.profileUsername,
            pfpTarget.dataset.profilePfp
        );
    });

    window.openUserProfile = openProfile;
})();

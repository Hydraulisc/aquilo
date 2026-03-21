(() => {
    const submitKeyBtn = document.getElementById('submitKeyBtn');
    const verifyBtn = document.getElementById('verifyBtn');
    const copyBtn = document.getElementById('copyBtn');
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step1Status = document.getElementById('step1Status');
    const step2Status = document.getElementById('step2Status');
    const challengeDisplay = document.getElementById('challengeDisplay');

    let encryptedChallenge = null;

    submitKeyBtn.addEventListener('click', async () => {
        const publicKey = document.getElementById('pubkeyInput').value.trim();
        if (!publicKey) return;
        submitKeyBtn.disabled = true;
        step1Status.textContent = 'Submitting…';
        step1Status.className = 'status-msg';

        try {
            const res = await fetch('/api/keys/submit', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ publicKey })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Submission failed');

            encryptedChallenge = data.encryptedChallenge;
            challengeDisplay.textContent = encryptedChallenge;
            step1Status.textContent = 'Public key accepted.';
            step1Status.className = 'status-msg success';
            step1.classList.add('dimmed');
            step2.style.display = '';
        } catch (err) {
            step1Status.textContent = err.message;
            step1Status.className = 'status-msg error';
            submitKeyBtn.disabled = false;
        }
    });

    copyBtn.addEventListener('click', () => {
        if (!encryptedChallenge) return;
        navigator.clipboard.writeText(encryptedChallenge).then(() => {
            copyBtn.textContent = 'Copied!';
            setTimeout(() => { copyBtn.textContent = 'Copy'; }, 1500);
        });
    });

    verifyBtn.addEventListener('click', async () => {
        const plaintext = document.getElementById('plaintextInput').value.trim();
        if (!plaintext) return;
        verifyBtn.disabled = true;
        step2Status.textContent = 'Verifying…';
        step2Status.className = 'status-msg';

        try {
            const res = await fetch('/api/keys/verify', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ plaintext })
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || 'Verification failed');

            step2Status.textContent = 'Key verified! Redirecting…';
            step2Status.className = 'status-msg success';
            setTimeout(() => { window.location.href = '/setup'; }, 1200);
        } catch (err) {
            step2Status.textContent = err.message;
            step2Status.className = 'status-msg error';
            verifyBtn.disabled = false;
        }
    });
})();

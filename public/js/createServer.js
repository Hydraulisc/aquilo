const bgExit = document.getElementById("create-server-modal");

// Only close when clicking the backdrop itself, not children
bgExit.addEventListener("click", (e) => {
    if (e.target === bgExit) {
        bgExit.style.display = 'none';
    }
});

document.getElementById('open-create-modal')?.addEventListener('click', (e) => {
    e.preventDefault();
    bgExit.style.display = 'grid';
});

document.getElementById('cancel-create-modal')?.addEventListener('click', () => {
    bgExit.style.display = 'none';
});

// Report buttons
document.addEventListener('click', async (e) => {
    const btn = e.target.closest('.msg-report-btn');
    if (!btn) return;
    const messageId = btn.dataset.messageId;
    const msgEl = document.getElementById(messageId);
    const content = msgEl?.querySelector('.textContent')?.textContent?.trim();
    if (!content) return;
    if (!confirm('Report this message to the server owner?')) return;
    const frankKey = msgEl?.dataset?.frankKey || null;
    try {
        const res = await fetch(`/api/messages/${messageId}/report`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, frank_key: frankKey })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to report');
        btn.textContent = '✓';
        btn.disabled = true;
    } catch (err) {
        alert(err.message);
    }
});

// Submit via fetch, then redirect to the new server
const createForm = bgExit.querySelector('form');
createForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = createForm.querySelector('input[name="name"]').value.trim();
    if (!name) return;

    try {
        const res = await fetch('/api/servers', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name })
        });
        if (!res.ok) throw new Error('Failed to create server');
        const data = await res.json();
        window.location.href = '/server/' + data.id;
    } catch (err) {
        console.error(err);
    }
});

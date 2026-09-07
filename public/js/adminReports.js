document.querySelectorAll('.report-card').forEach(card => {
    const reportId = card.dataset.reportId;
    const errorEl = card.querySelector('.report-action-error');
    const buttons = card.querySelectorAll('button');

    function setLoading(loading) {
        buttons.forEach(b => b.disabled = loading);
    }

    function dismiss() {
        card.classList.add('dismissed');
        setTimeout(() => card.remove(), 300);
    }

    async function doAction(url, method) {
        errorEl.textContent = '';
        setLoading(true);
        try {
            const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json' } });
            if (!res.ok) {
                const data = await res.json();
                errorEl.textContent = data.error || 'Action failed';
                setLoading(false);
                return;
            }
            dismiss();
        } catch {
            errorEl.textContent = 'Request failed';
            setLoading(false);
        }
    }

    card.querySelector('.action-dismiss').addEventListener('click', () => {
        doAction(`/api/reports/${reportId}`, 'DELETE');
    });

    card.querySelector('.action-delete-msg').addEventListener('click', () => {
        doAction(`/api/reports/${reportId}/message`, 'DELETE');
    });

    card.querySelector('.action-kick').addEventListener('click', () => {
        doAction(`/api/reports/${reportId}/kick`, 'POST');
    });
});

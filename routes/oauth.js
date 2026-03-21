const express = require('express');
const axios = require('axios');
const qs = require('querystring');
const fs = require('fs');
const crypto = require('crypto');
const globals = JSON.parse(fs.readFileSync('globals.json', 'utf8'));
const db = require('../database/helpers');


const router = express.Router();

// TODO: Prevent clickjacking and CSRF by adding state parameter
router.get('/login', (req, res) => {
    if (req.query.next && req.query.next.startsWith('/')) {
        req.session.postLoginRedirect = req.query.next;
    }
    res.redirect(`${globals.hydrauliscAuthUrl}/authorize?client_id=${globals.hydrauliscAuthClient}&redirect_uri=${globals.hydrauliscCallback}&response_type=code`)
})

router.get('/callback', async (req, res) => {
    const { code } = req.query;
    try {
    const tokenRes = await axios.post(`${globals.hydrauliscAuthUrl}/token`, qs.stringify({
      code,
      client_id: globals.hydrauliscAuthClient,
      client_secret: globals.hydrauliscAuthToken,
      redirect_uri: globals.hydrauliscCallback
    }), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
    });

    const accessToken = tokenRes.data.access_token;
    

    // Store the token in session or cookie
    req.session.accessToken = accessToken;

    // Redirect to profile or homepage
    res.redirect('/oauth/me');
  } catch (err) {
    console.error('Token exchange failed:', err.response?.data || err.message);
    res.status(500).send('Failed to exchange code for token.');
  }
});

router.get('/me', async (req, res) => {
    const accessToken = req.session.accessToken;
if (!accessToken) return res.redirect('/login/?utm=oautherror');

try {
  const userRes = await axios.get(`${globals.hydrauliscAuthUrl}/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`
    }
  });

  const user = userRes.data;

  req.session.user = { id: user.id };
  const pfp = user.pfp || user.avatar || user.avatar_url || user.profilePicture || null;
  db.upsertUser(user.id, user.username, pfp);

  const next = req.session.postLoginRedirect;
  delete req.session.postLoginRedirect;

  // Require verified PGP key before going anywhere in the app
  const keyRow = db.getUserKey(user.id);
  if (!keyRow || !keyRow.verified_at) {
    return res.redirect(next && next.startsWith('/') && next !== '/setup' ? `/setup?next=${encodeURIComponent(next)}` : '/setup');
  }

  if (next && next.startsWith('/')) return res.redirect(next);

  // Smart default: go to first server/channel, or welcome
  const servers = db.getServersForUser(user.id);
  if (servers.length) {
    const channels = db.getChannelsForServer(servers[0].id);
    return res.redirect(channels.length
      ? `/server/${servers[0].id}/channel/${channels[0].id}`
      : `/server/${servers[0].id}`);
  }
  res.redirect('/');
} catch (err) {
  console.error('User info fetch failed:', err.response?.data || err.message);
  res.status(500).send('Failed to fetch user info.');
}

})

module.exports = router;

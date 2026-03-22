const express = require('express');
const { ExpressPeerServer } = require('peer');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 8080;

// Serve BLADE.html as index.html at root
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/status', (req, res) => {
  res.json({ status: 'BLADE SERVER ONLINE' });
});

const server = require('http').createServer(app);

// PeerJS signaling at /peerjs
const peerServer = ExpressPeerServer(server, {
  debug: true,
  path: '/',
  allow_discovery: false,
});

app.use('/peerjs', peerServer);

peerServer.on('connection', (client) => {
  console.log('[BLADE] Peer connected:', client.getId());
});
peerServer.on('disconnect', (client) => {
  console.log('[BLADE] Peer disconnected:', client.getId());
});

server.listen(PORT, () => {
  console.log('');
  console.log('  ╔══════════════════════════════════╗');
  console.log('  ║   ⚔  BLADE COMMS SERVER  ⚔       ║');
  console.log('  ║   PeerJS signaling ready         ║');
  console.log(`  ║   Port: ${PORT}                     ║`);
  console.log('  ╚══════════════════════════════════╝');
});

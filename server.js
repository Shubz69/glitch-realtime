const express = require('express');
const http = require('http');
const cors = require('cors');
const { WebSocketServer } = require('ws');

const app = express();
const server = http.createServer(app);

app.use(cors());
app.get('/', (_req, res) => res.send('Realtime server running'));

const channels = new Map();
const wss = new WebSocketServer({ server, path: '/ws' });

wss.on('connection', (socket, req) => {
  const params = new URLSearchParams(req.url.split('?')[1]);
  const channelId = params.get('channel') || 'general';

  if (!channels.has(channelId)) channels.set(channelId, new Set());
  channels.get(channelId).add(socket);

  socket.on('message', (raw) => {
    const msgString = raw.toString();
    let payload;

    try {
      payload = JSON.parse(msgString);
    } catch (err) {
      console.error('Invalid message JSON:', err);
      return;
    }

    const enriched = JSON.stringify({
      ...payload,
      timestamp: Date.now(),
      channelId,
    });

    for (const client of channels.get(channelId)) {
      if (client.readyState === client.OPEN) {
        client.send(enriched);
      }
    }
  });

  socket.on('close', () => {
    channels.get(channelId)?.delete(socket);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`Realtime server listening on ${PORT}`);
});

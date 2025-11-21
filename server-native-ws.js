// Railway WebSocket Server - Native WebSocket version (better for Railway)
// This version uses native WebSocket instead of SockJS for better Railway compatibility

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGIN = process.env.CORS_ALLOW_ORIGIN || '*';
const ALLOWED_METHODS = 'GET,POST,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization, Upgrade, Connection, Sec-WebSocket-Key, Sec-WebSocket-Version, Sec-WebSocket-Protocol';

const applyCors = (_req, res) => {
  res.setHeader('Access-Control-Allow-Origin', ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', ALLOWED_METHODS);
  res.setHeader('Access-Control-Allow-Headers', ALLOWED_HEADERS);
  res.setHeader('Access-Control-Allow-Credentials', 'false');
};

app.use((req, res, next) => {
  applyCors(req, res);
  
  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.get('/', (_req, res) => res.send('Realtime server running'));

// Create native WebSocket server (better for Railway)
const wss = new WebSocket.Server({ 
  server,
  path: '/ws',
  verifyClient: (info) => {
    // Allow all origins for Railway
    return true;
  }
});

const subscriptionsByConn = new Map();
const subscribersByDestination = new Map();

const ensureDestinationEntry = (destination) => {
  if (!subscribersByDestination.has(destination)) {
    subscribersByDestination.set(destination, new Map());
  }
  return subscribersByDestination.get(destination);
};

const sendFrame = (ws, command, headers = {}, body = '') => {
  let frame = `${command}\n`;
  for (const [key, value] of Object.entries(headers)) {
    frame += `${key}:${value}\n`;
  }
  frame += '\n';
  frame += body || '';
  frame += '\0';
  
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(frame);
  }
};

const addSubscription = (ws, subId, destination) => {
  if (!subscriptionsByConn.has(ws)) {
    subscriptionsByConn.set(ws, new Map());
  }
  subscriptionsByConn.get(ws).set(subId, destination);

  const destinationSubscribers = ensureDestinationEntry(destination);
  if (!destinationSubscribers.has(ws)) {
    destinationSubscribers.set(ws, new Set());
  }
  destinationSubscribers.get(ws).add(subId);
};

const removeSubscription = (ws, subId) => {
  const connSubs = subscriptionsByConn.get(ws);
  if (!connSubs) return;

  const destination = connSubs.get(subId);
  if (!destination) return;

  connSubs.delete(subId);
  if (connSubs.size === 0) {
    subscriptionsByConn.delete(ws);
  }

  const destinationSubscribers = subscribersByDestination.get(destination);
  if (!destinationSubscribers) return;

  const subSet = destinationSubscribers.get(ws);
  if (!subSet) return;

  subSet.delete(subId);
  if (subSet.size === 0) {
    destinationSubscribers.delete(ws);
  }
  if (destinationSubscribers.size === 0) {
    subscribersByDestination.delete(destination);
  }
};

const cleanupConnection = (ws) => {
  const connSubs = subscriptionsByConn.get(ws);
  if (!connSubs) return;

  for (const [subId, destination] of connSubs.entries()) {
    const destinationSubscribers = subscribersByDestination.get(destination);
    if (!destinationSubscribers) continue;

    const subSet = destinationSubscribers.get(ws);
    if (subSet) {
      subSet.delete(subId);
      if (subSet.size === 0) {
        destinationSubscribers.delete(ws);
      }
    }

    if (destinationSubscribers.size === 0) {
      subscribersByDestination.delete(destination);
    }
  }

  subscriptionsByConn.delete(ws);
};

const broadcast = (destination, body) => {
  const destinationSubscribers = subscribersByDestination.get(destination);
  if (!destinationSubscribers) return;

  for (const [ws, subIds] of destinationSubscribers.entries()) {
    if (ws.readyState === WebSocket.OPEN) {
      for (const subId of subIds) {
        sendFrame(ws, 'MESSAGE', {
          subscription: subId,
          destination,
          'message-id': randomUUID()
        }, body);
      }
    }
  }
};

const parseFrames = (chunk) => {
  if (!chunk) return [];

  const rawFrames = chunk.split('\0');
  const frames = [];

  for (const raw of rawFrames) {
    if (!raw) continue;
    if (raw === '\n') continue;

    const parts = raw.split('\n\n');
    const headerLines = parts.shift().split('\n').filter(Boolean);
    if (headerLines.length === 0) continue;

    const command = headerLines.shift().trim();
    if (!command) continue;

    const headers = {};
    for (const line of headerLines) {
      const separatorIndex = line.indexOf(':');
      if (separatorIndex === -1) continue;
      const key = line.slice(0, separatorIndex).trim();
      const value = line.slice(separatorIndex + 1).trim();
      headers[key] = value;
    }

    const body = parts.join('\n\n');
    frames.push({ command, headers, body });
  }

  return frames;
};

const handleFrame = (ws, frame) => {
  const { command, headers, body } = frame;

  switch (command) {
    case 'CONNECT':
    case 'STOMP':
      sendFrame(ws, 'CONNECTED', {
        version: '1.2'
      });
      break;

    case 'SUBSCRIBE': {
      const { id, destination } = headers;
      if (!id || !destination) {
        sendFrame(ws, 'ERROR', {
          message: 'Subscription requires id and destination'
        }, 'Missing id or destination header');
        return;
      }
      addSubscription(ws, id, destination);
      break;
    }

    case 'UNSUBSCRIBE': {
      const { id } = headers;
      if (id) {
        removeSubscription(ws, id);
      }
      break;
    }

    case 'SEND': {
      const { destination } = headers;
      if (!destination) return;
      broadcast(destination, body);
      break;
    }

    case 'DISCONNECT': {
      cleanupConnection(ws);
      ws.close();
      break;
    }

    default:
      break;
  }
};

// Handle WebSocket connections
wss.on('connection', (ws, req) => {
  console.log('WebSocket connection established from:', req.headers.origin || 'unknown');
  
  // Set CORS headers in response
  ws.on('message', (message) => {
    const frames = parseFrames(message.toString());
    for (const frame of frames) {
      handleFrame(ws, frame);
    }
  });

  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('WebSocket connection closed');
    cleanupConnection(ws);
  });
});

// Health check endpoint
const PORT = process.env.PORT || 4000;
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'glitch-realtime',
    port: PORT,
    websocket: 'active',
    type: 'native-websocket'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Realtime server listening on ${PORT}`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
  console.log('Using native WebSocket (better Railway compatibility)');
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  wss.close(() => {
    server.close(() => {
      console.log('Server closed');
      process.exit(0);
    });
  });
});


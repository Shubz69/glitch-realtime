const express = require('express');
const http = require('http');
const sockjs = require('sockjs');
const { randomUUID } = require('crypto');

const app = express();
const server = http.createServer(app);

const ALLOWED_ORIGIN = process.env.CORS_ALLOW_ORIGIN || 'https://www.theglitch.world';
const ALLOWED_METHODS = 'GET,POST,OPTIONS';
const ALLOWED_HEADERS = 'Content-Type, Authorization';

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

const sockServer = sockjs.createServer({
  prefix: '/ws',
  log: (severity, entry) => {
    // Log errors and warnings for debugging
    if (severity === 'error' || severity === 'warning') {
      console.log(`SockJS ${severity}:`, entry);
    }
  },
  heartbeat_delay: 25000,
  // Ensure WebSocket transport is preferred
  transports: ['websocket', 'xhr-streaming', 'xhr-polling']
});

const subscriptionsByConn = new Map();
const subscribersByDestination = new Map();

const ensureDestinationEntry = (destination) => {
  if (!subscribersByDestination.has(destination)) {
    subscribersByDestination.set(destination, new Map());
  }
  return subscribersByDestination.get(destination);
};

const sendFrame = (conn, command, headers = {}, body = '') => {
  let frame = `${command}\n`;
  for (const [key, value] of Object.entries(headers)) {
    frame += `${key}:${value}\n`;
  }
  frame += '\n';
  frame += body || '';
  frame += '\0';
  conn.send(frame);
};

const addSubscription = (conn, subId, destination) => {
  if (!subscriptionsByConn.has(conn)) {
    subscriptionsByConn.set(conn, new Map());
  }
  subscriptionsByConn.get(conn).set(subId, destination);

  const destinationSubscribers = ensureDestinationEntry(destination);
  if (!destinationSubscribers.has(conn)) {
    destinationSubscribers.set(conn, new Set());
  }
  destinationSubscribers.get(conn).add(subId);
};

const removeSubscription = (conn, subId) => {
  const connSubs = subscriptionsByConn.get(conn);
  if (!connSubs) return;

  const destination = connSubs.get(subId);
  if (!destination) return;

  connSubs.delete(subId);
  if (connSubs.size === 0) {
    subscriptionsByConn.delete(conn);
  }

  const destinationSubscribers = subscribersByDestination.get(destination);
  if (!destinationSubscribers) return;

  const subSet = destinationSubscribers.get(conn);
  if (!subSet) return;

  subSet.delete(subId);
  if (subSet.size === 0) {
    destinationSubscribers.delete(conn);
  }
  if (destinationSubscribers.size === 0) {
    subscribersByDestination.delete(destination);
  }
};

const cleanupConnection = (conn) => {
  const connSubs = subscriptionsByConn.get(conn);
  if (!connSubs) return;

  for (const [subId, destination] of connSubs.entries()) {
    const destinationSubscribers = subscribersByDestination.get(destination);
    if (!destinationSubscribers) continue;

    const subSet = destinationSubscribers.get(conn);
    if (subSet) {
      subSet.delete(subId);
      if (subSet.size === 0) {
        destinationSubscribers.delete(conn);
      }
    }

    if (destinationSubscribers.size === 0) {
      subscribersByDestination.delete(destination);
    }
  }

  subscriptionsByConn.delete(conn);
};

const broadcast = (destination, body) => {
  const destinationSubscribers = subscribersByDestination.get(destination);
  if (!destinationSubscribers) return;

  for (const [conn, subIds] of destinationSubscribers.entries()) {
    for (const subId of subIds) {
      sendFrame(conn, 'MESSAGE', {
        subscription: subId,
        destination,
        'message-id': randomUUID()
      }, body);
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

const handleFrame = (conn, frame) => {
  const { command, headers, body } = frame;

  switch (command) {
    case 'CONNECT':
    case 'STOMP':
      sendFrame(conn, 'CONNECTED', {
        version: '1.2'
      });
      break;

    case 'SUBSCRIBE': {
      const { id, destination } = headers;
      if (!id || !destination) {
        sendFrame(conn, 'ERROR', {
          message: 'Subscription requires id and destination'
        }, 'Missing id or destination header');
        return;
      }
      addSubscription(conn, id, destination);
      break;
    }

    case 'UNSUBSCRIBE': {
      const { id } = headers;
      if (id) {
        removeSubscription(conn, id);
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
      cleanupConnection(conn);
      conn.close();
      break;
    }

    default:
      break;
  }
};

const registerConnection = (transport) => {
  const conn = {
    send: transport.send,
    close: transport.close
  };

  subscriptionsByConn.set(conn, new Map());

  transport.onData((chunk) => {
    const frames = parseFrames(typeof chunk === 'string' ? chunk : chunk.toString());
    for (const frame of frames) {
      handleFrame(conn, frame);
    }
  });

  transport.onClose(() => {
    cleanupConnection(conn);
  });
};

sockServer.on('connection', (conn) => {
  if (conn && conn.response && typeof conn.response.writeHead === 'function') {
    const originalWriteHead = conn.response.writeHead;
    conn.response.writeHead = function patchedWriteHead(statusCode, statusMessage, headers) {
      if (typeof statusMessage === 'object' && !headers) {
        headers = statusMessage;
        statusMessage = undefined;
      }
      headers = headers || {};
      headers['Access-Control-Allow-Origin'] = ALLOWED_ORIGIN;
      headers['Access-Control-Allow-Credentials'] = 'false';
      headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
      headers['Access-Control-Allow-Headers'] = ALLOWED_HEADERS;
      if (statusMessage) {
        return originalWriteHead.call(this, statusCode, statusMessage, headers);
      }
      return originalWriteHead.call(this, statusCode, headers);
    };
  }

  registerConnection({
    send: (data) => conn.write(data),
    close: () => conn.close(),
    onData: (handler) => conn.on('data', handler),
    onClose: (handler) => conn.on('close', handler)
  });
});

sockServer.installHandlers(server, { prefix: '/ws' });

// Health check endpoint for Railway (after PORT is defined)
const PORT = process.env.PORT || 4000;
app.get('/health', (_req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'glitch-realtime',
    port: PORT,
    websocket: 'active'
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Realtime server listening on ${PORT}`);
  console.log(`WebSocket endpoint: ws://0.0.0.0:${PORT}/ws`);
});

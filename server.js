यह तुम्हारा पूरा अपडेटेड server.js है, इसमें secret chat के लिए अलग इवेंट्स जोड़े हैं — secret-message भेजने के लिए और secret-history पुराने secret मैसेज लोड करने के लिए। secret chat सिर्फ उसी को मिलता है जिसने सही पासवर्ड से history unlock किया हो:

js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');
const crypto = require('crypto');
const admin = require('firebase-admin');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// ---------- Firebase setup ----------
let db = null;
if (
  process.env.FIREBASE_PROJECT_ID &&
  process.env.FIREBASE_CLIENT_EMAIL &&
  process.env.FIREBASE_PRIVATE_KEY
) {
  try {
    admin.initializeApp({
      credential: admin.credential.cert({
        projectId: process.env.FIREBASE_PROJECT_ID,
        clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
        privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n')
      })
    });
    db = admin.firestore();
    db.settings({ ignoreUndefinedProperties: true });
    console.log('Firebase connected');
  } catch (err) {
    console.error('Firebase setup failed:', err.message);
  }
} else {
  console.log('Firebase env variables missing - permanent rooms disabled');
}

// ---------- Upload setup ----------
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const upload = multer({ dest: uploadDir, limits: { fileSize: 100 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({
    url: '/uploads/' + req.file.filename,
    type: req.file.mimetype
  });
});

// ---------- Helpers ----------
function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function roomRef(roomCode) {
  return db.collection('rooms').doc(encodeURIComponent(roomCode));
}

function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function checkPassword(password, salt, savedHash) {
  const a = Buffer.from(hashPassword(password, salt), 'hex');
  const b = Buffer.from(savedHash, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Kaun si rooms permanent hain (baar baar database na dekhna pade)
const permanentRooms = new Map();

async function isPermanent(roomCode) {
  if (!db) return false;
  if (permanentRooms.has(roomCode)) return permanentRooms.get(roomCode);
  const snap = await roomRef(roomCode).get();
  const value = snap.exists && snap.data().permanent === true;
  permanentRooms.set(roomCode, value);
  return value;
}

async function saveSecretMessage(roomCode, msg) {
  if (!db) return;
  try {
    await roomRef(roomCode).collection('secretMessages').doc(msg.id).set(msg);
  } catch (err) {
    console.error('Secret message save failed:', err.message);
  }
}

// ---------- Sockets ----------
io.on('connection', (socket) => {
  socket.data.failedAttempts = 0;
  socket.data.lockUntil = 0;
  socket.data.unlocked = false; // secret chat ka access mila hai ya nahi

  socket.on('join-room', async ({ name, roomCode }) => {
    socket.join(roomCode);
    socket.data.name = name;
    socket.data.roomCode = roomCode;
    socket.data.unlocked = false;
    io.to(roomCode).emit('system-message', `${name} joined the room`);

    try {
      socket.emit('room-info', { permanent: await isPermanent(roomCode) });
    } catch (err) {
      console.error('Room check failed:', err.message);
      socket.emit('room-info', { permanent: false });
    }
  });

  // Room ko permanent banana (password ke saath)
  socket.on('make-permanent', async ({ password }) => {
    const { roomCode } = socket.data;
    if (!roomCode) return;
    if (!db) return socket.emit('permanent-error', 'Permanent room abhi available nahi hai');
    if (typeof password !== 'string' || password.length < 4) {
      return socket.emit('permanent-error', 'Password kam se kam 4 characters ka rakho');
    }
    try {
      if (await isPermanent(roomCode)) {
        return socket.emit('permanent-error', 'Ye room pehle se permanent hai');
      }
      const salt = crypto.randomBytes(16).toString('hex');
      await roomRef(roomCode).set({
        permanent: true,
        salt,
        passwordHash: hashPassword(password, salt),
        createdAt: Date.now()
      });
      permanentRooms.set(roomCode, true);
      io.to(roomCode).emit('room-info', { permanent: true });
      io.to(roomCode).emit('system-message', 'Ye room ab permanent hai');
    } catch (err) {
      console.error('Make permanent failed:', err.message);
      socket.emit('permanent-error', 'Kuch gadbad hui, dobara try karo');
    }
  });

  // Secret chat unlock karne ke liye password
  socket.on('unlock-history', async ({ password }) => {
    const { roomCode } = socket.data;
    if (!roomCode || !db) return;

    if (Date.now() < socket.data.lockUntil) {
      return socket.emit('history-error', 'Bahut galat try ho gaye, thodi der baad try karo');
    }

    try {
      const snap = await roomRef(roomCode).get();
      if (!snap.exists || snap.data().permanent !== true) {
        return socket.emit('history-error', 'Ye room permanent nahi hai');
      }
      const { salt, passwordHash } = snap.data();

      if (typeof password !== 'string' || !checkPassword(password, salt, passwordHash)) {
        socket.data.failedAttempts += 1;
        if (socket.data.failedAttempts >= 5) {
          socket.data.lockUntil = Date.now() + 60 * 1000;
          socket.data.failedAttempts = 0;
        }
        return socket.emit('history-error', 'Galat password');
      }

      socket.data.failedAttempts = 0;
      socket.data.unlocked = true;

      const msgs = await roomRef(roomCode)
        .collection('secretMessages')
        .orderBy('ts', 'desc')
        .limit(200)
        .get();
      const history = msgs.docs.map((d) => d.data()).reverse();
      socket.emit('history', history);
    } catch (err) {
      console.error('History load failed:', err.message);
      socket.emit('history-error', 'History load nahi ho payi');
    }
  });

  // Typing indicator (normal chat)
  socket.on('typing', () => {
    const { name, roomCode } = socket.data;
    if (roomCode) socket.to(roomCode).emit('typing', { name });
  });

  socket.on('stop-typing', () => {
    const { name, roomCode } = socket.data;
    if (roomCode) socket.to(roomCode).emit('stop-typing', { name });
  });

  // Normal text message (kabhi save nahi hoti)
  socket.on('chat-message', (data) => {
    const { name, roomCode } = socket.data;
    if (!roomCode) return;

    const isObj = typeof data === 'object' && data !== null;
    const message = isObj ? data.message : data;
    const replyTo = isObj ? (data.replyTo || null) : null;

    io.to(roomCode).emit('chat-message', { id: makeId(), name, message, replyTo });
  });

  // Normal media message (kabhi save nahi hoti)
  socket.on('media-message', ({ url, type, replyTo }) => {
    const { name, roomCode } = socket.data;
    if (!roomCode) return;

    io.to(roomCode).emit('media-message', {
      id: makeId(),
      name,
      url,
      type,
      replyTo: replyTo || null
    });
  });

  // Secret chat ka text message - sirf unlocked logon ko dikhta hai, hamesha save hota hai
  socket.on('secret-message', (data) => {
    const { name, roomCode, unlocked } = socket.data;
    if (!roomCode || !unlocked) return;

    const isObj = typeof data === 'object' && data !== null;
    const message = isObj ? data.message : data;
    const replyTo = isObj ? (data.replyTo || null) : null;

    const msg = { id: makeId(), name, message, replyTo, kind: 'text', ts: Date.now() };

    // Sirf un sockets ko bhejo jo isi room mein unlocked hain
    for (const [, s] of io.sockets.sockets) {
      if (s.data.roomCode === roomCode && s.data.unlocked) {
        s.emit('secret-message', msg);
      }
    }
    saveSecretMessage(roomCode, msg);
  });

  // Secret chat ka media message
  socket.on('secret-media-message', ({ url, type, replyTo }) => {
    const { name, roomCode, unlocked } = socket.data;
    if (!roomCode || !unlocked) return;

    const msg = { id: makeId(), name, url, type, replyTo: replyTo || null, kind: 'media', ts: Date.now() };

    for (const [, s] of io.sockets.sockets) {
      if (s.data.roomCode === roomCode && s.data.unlocked) {
        s.emit('secret-message', msg);
      }
    }
    saveSecretMessage(roomCode, msg);
  });

  socket.on('disconnect', () => {
    const { name, roomCode } = socket.data;
    if (roomCode) {
      socket.to(roomCode).emit('stop-typing', { name });
      io.to(roomCode).emit('system-message', `${name} left the room`);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

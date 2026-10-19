const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const multer = require('multer');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

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

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

io.on('connection', (socket) => {
  socket.on('join-room', ({ name, roomCode }) => {
    socket.join(roomCode);
    socket.data.name = name;
    socket.data.roomCode = roomCode;
    io.to(roomCode).emit('system-message', `${name} joined the room`);
  });

  // Typing indicator
  socket.on('typing', () => {
    const { name, roomCode } = socket.data;
    if (roomCode) socket.to(roomCode).emit('typing', { name });
  });

  socket.on('stop-typing', () => {
    const { name, roomCode } = socket.data;
    if (roomCode) socket.to(roomCode).emit('stop-typing', { name });
  });

  // Text message (reply support ke saath)
  socket.on('chat-message', (data) => {
    const { name, roomCode } = socket.data;
    if (!roomCode) return;

    const isObj = typeof data === 'object' && data !== null;
    const message = isObj ? data.message : data;
    const replyTo = isObj ? (data.replyTo || null) : null;

    io.to(roomCode).emit('chat-message', {
      id: makeId(),
      name,
      message,
      replyTo
    });
  });

  // Media message (reply support ke saath)
  socket.on('media-message', ({ url, type, replyTo }) => {
    const { name, roomCode } = socket.data;
    if (roomCode) {
      io.to(roomCode).emit('media-message', {
        id: makeId(),
        name,
        url,
        type,
        replyTo: replyTo || null
      });
    }
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

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

const upload = multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } });

app.use(express.static(path.join(__dirname, 'public')));

app.post('/upload', upload.single('file'), (req, res) => {
if (!req.file) return res.status(400).json({ error: 'No file' });
res.json({
url: '/uploads/' + req.file.filename,
type: req.file.mimetype
});
});

io.on('connection', (socket) => {
socket.on('join-room', ({ name, roomCode }) => {
socket.join(roomCode);
socket.data.name = name;
socket.data.roomCode = roomCode;
io.to(roomCode).emit('system-message', `${name} joined the room`);
});

socket.on('chat-message', (message) => {
const { name, roomCode } = socket.data;
if (roomCode) {
io.to(roomCode).emit('chat-message', { name, message });
}
});

socket.on('media-message', ({ url, type }) => {
const { name, roomCode } = socket.data;
if (roomCode) {
io.to(roomCode).emit('media-message', { name, url, type });
}
});

socket.on('disconnect', () => {
const { name, roomCode } = socket.data;
if (roomCode) {
io.to(roomCode).emit('system-message', `${name} left the room`);
}
});
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
console.log(`Server running on port ${PORT}`);
});
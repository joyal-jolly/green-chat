// GreenChat client logic
// - Connects to the Flask-SocketIO server over WebSocket
// - No local storage of chat history is used (matches "temporary sessions" design)

const loginScreen = document.getElementById("login-screen");
const chatScreen = document.getElementById("chat-screen");
const usernameInput = document.getElementById("username-input");
const joinBtn = document.getElementById("join-btn");
const loginError = document.getElementById("login-error");

const connectionStatus = document.getElementById("connection-status");
const messagesEl = document.getElementById("messages");
const userListEl = document.getElementById("user-list");
const messageForm = document.getElementById("message-form");
const messageInput = document.getElementById("message-input");
const typingIndicator = document.getElementById("typing-indicator");

const attachBtn = document.getElementById("attach-btn");
const fileInput = document.getElementById("file-input");
const attachmentPreview = document.getElementById("attachment-preview");
const attachmentIcon = document.getElementById("attachment-icon");
const attachmentName = document.getElementById("attachment-name");
const attachmentSize = document.getElementById("attachment-size");
const attachmentRemove = document.getElementById("attachment-remove");

let socket = null;
let myUsername = null;
let typingTimeout = null;
let pendingFile = null; // { filename, mimetype, size, dataBase64 }

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10 MB, matches server limit

function setStatus(connected) {
  connectionStatus.classList.toggle("connected", connected);
  connectionStatus.classList.toggle("disconnected", !connected);
  connectionStatus.innerHTML = connected
    ? '<span class="dot"></span> CONNECTED'
    : '<span class="dot"></span> DISCONNECTED';
}

function addMessage({ username, text, time }, isSystem = false) {
  const div = document.createElement("div");
  if (isSystem) {
    div.className = "msg system";
    div.textContent = `[${time}] * ${text}`;
  } else {
    const isOwn = username === myUsername;
    div.className = "msg" + (isOwn ? " own" : "");
    div.innerHTML =
      `<span class="time">[${time}]</span>` +
      `<span class="username">${escapeHtml(username)}:</span>` +
      `<span class="text">${escapeHtml(text)}</span>`;
  }
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatBytes(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let value = bytes;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

function iconForMime(mimetype, filename) {
  if (mimetype && mimetype.startsWith("image/")) return "🖼️";
  const ext = (filename.split(".").pop() || "").toLowerCase();
  if (["pdf"].includes(ext)) return "📕";
  if (["doc", "docx"].includes(ext)) return "📄";
  if (["xls", "xlsx", "csv"].includes(ext)) return "📊";
  if (["ppt", "pptx"].includes(ext)) return "📽️";
  if (["zip", "rar", "7z"].includes(ext)) return "🗜️";
  if (["mp3", "wav", "ogg"].includes(ext)) return "🎵";
  if (["mp4", "mov", "avi", "mkv"].includes(ext)) return "🎬";
  return "📎";
}

function base64ToBlob(base64, mimetype) {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) {
    byteNumbers[i] = byteChars.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: mimetype });
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function addFileMessage({ username, filename, mimetype, data, size, caption, time }) {
  const isOwn = username === myUsername;
  const wrapper = document.createElement("div");
  wrapper.className = "msg" + (isOwn ? " own" : "");

  const header = document.createElement("div");
  header.innerHTML =
    `<span class="time">[${time}]</span>` +
    `<span class="username">${escapeHtml(username)}:</span>` +
    (caption ? `<span class="text">${escapeHtml(caption)}</span>` : `<span class="text">sent a file</span>`);
  wrapper.appendChild(header);

  const isImage = mimetype && mimetype.startsWith("image/");

  if (isImage) {
    const img = document.createElement("img");
    img.className = "image-preview";
    img.src = `data:${mimetype};base64,${data}`;
    img.alt = filename;
    img.title = `Click to open ${filename}`;
    img.addEventListener("click", () => {
      const blob = base64ToBlob(data, mimetype);
      const url = URL.createObjectURL(blob);
      window.open(url, "_blank");
    });
    wrapper.appendChild(img);
  }

  const card = document.createElement("div");
  card.className = "file-card";
  card.innerHTML =
    `<span class="file-icon">${iconForMime(mimetype, filename)}</span>` +
    `<div class="file-meta">` +
    `<span class="file-name">${escapeHtml(filename)}</span>` +
    `<span class="file-size">${formatBytes(size)}</span>` +
    `</div>`;

  const downloadLink = document.createElement("a");
  downloadLink.className = "download-link";
  downloadLink.textContent = "DOWNLOAD";
  downloadLink.href = "#";
  downloadLink.addEventListener("click", (e) => {
    e.preventDefault();
    const blob = base64ToBlob(data, mimetype);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  });
  card.appendChild(downloadLink);

  wrapper.appendChild(card);
  messagesEl.appendChild(wrapper);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function updateUserList(users) {
  userListEl.innerHTML = "";
  users.forEach((u) => {
    const li = document.createElement("li");
    li.textContent = u;
    userListEl.appendChild(li);
  });
}

function connectAndJoin(username) {
  socket = io({ transports: ["websocket", "polling"] });

  socket.on("connect", () => {
    setStatus(true);
    socket.emit("join", { username });
  });

  socket.on("disconnect", () => {
    setStatus(false);
  });

  socket.on("joined", (data) => {
    myUsername = data.username;
    loginScreen.classList.add("hidden");
    chatScreen.classList.remove("hidden");
    messageInput.focus();
  });

  socket.on("receive_message", (data) => {
    addMessage(data, false);
  });

  socket.on("receive_file", (data) => {
    addFileMessage(data);
  });

  socket.on("system_message", (data) => {
    addMessage(data, true);
  });

  socket.on("user_list", (data) => {
    updateUserList(data.users || []);
  });

  socket.on("typing_status", (data) => {
    if (data.typing) {
      typingIndicator.textContent = `${data.username} is typing...`;
    } else {
      typingIndicator.textContent = "";
    }
  });

  socket.on("connect_error", () => {
    setStatus(false);
    loginError.textContent = "Could not reach the server. Is it running?";
  });
}

// ---------------- Login screen handlers ----------------
joinBtn.addEventListener("click", attemptJoin);
usernameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") attemptJoin();
});

function attemptJoin() {
  const name = usernameInput.value.trim();
  if (!name) {
    loginError.textContent = "Please enter a username.";
    return;
  }
  loginError.textContent = "";
  connectAndJoin(name);
}

// ---------------- Chat screen handlers ----------------

attachBtn.addEventListener("click", () => {
  fileInput.click();
});

fileInput.addEventListener("change", () => {
  const file = fileInput.files[0];
  fileInput.value = ""; // allow re-selecting the same file later
  if (!file) return;

  if (file.size > MAX_FILE_SIZE) {
    loginError.textContent = ""; // n/a on this screen
    alert(`"${file.name}" is too large. Max file size is 10 MB.`);
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    // result looks like "data:<mime>;base64,AAAA..." — strip the prefix
    const base64 = reader.result.split(",")[1];
    pendingFile = {
      filename: file.name,
      mimetype: file.type || "application/octet-stream",
      size: file.size,
      dataBase64: base64,
    };
    showAttachmentPreview(pendingFile);
  };
  reader.readAsDataURL(file);
});

attachmentRemove.addEventListener("click", () => {
  clearAttachmentPreview();
});

function showAttachmentPreview(file) {
  attachmentIcon.textContent = iconForMime(file.mimetype, file.filename);
  attachmentName.textContent = file.filename;
  attachmentSize.textContent = formatBytes(file.size);
  attachmentPreview.classList.remove("hidden");
}

function clearAttachmentPreview() {
  pendingFile = null;
  attachmentPreview.classList.add("hidden");
}

messageForm.addEventListener("submit", (e) => {
  e.preventDefault();
  if (!socket) return;

  const text = messageInput.value.trim();

  if (pendingFile) {
    socket.emit("send_file", {
      filename: pendingFile.filename,
      mimetype: pendingFile.mimetype,
      size: pendingFile.size,
      data: pendingFile.dataBase64,
      caption: text,
    });
    clearAttachmentPreview();
    messageInput.value = "";
    socket.emit("typing", { typing: false });
    return;
  }

  if (!text) return;
  socket.emit("send_message", { text });
  messageInput.value = "";
  socket.emit("typing", { typing: false });
});

messageInput.addEventListener("input", () => {
  if (!socket) return;
  socket.emit("typing", { typing: true });
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    socket.emit("typing", { typing: false });
  }, 1200);
});

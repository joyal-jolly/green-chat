"""
GreenChat - Local Network Real-Time Chat Server
=================================================
Run this on the "server computer". Other computers on the same LAN
connect to it through a web browser.

Usage:
    python server.py

Then, on the server computer, open:
    http://localhost:5000

On other computers on the same LAN, open:
    http://<server-computer-local-ip>:5000

Messages are kept only in memory (a Python list) for the life of the
process. Restarting the server clears all chat history, and no
database or file storage is used.
"""

import socket
from datetime import datetime

from flask import Flask, render_template, request
from flask_socketio import SocketIO, emit

app = Flask(__name__)
app.config["SECRET_KEY"] = "greenchat-dev-secret"  # fine for a LAN demo/lab tool

# Max file size we'll relay (raw bytes, before base64 encoding).
# Base64 inflates size by ~33%, so give the socket buffer extra headroom.
MAX_FILE_SIZE = 10 * 1024 * 1024  # 10 MB

# async_mode="threading" avoids needing eventlet/gevent installed separately.
socketio = SocketIO(
    app,
    cors_allowed_origins="*",
    async_mode="threading",
    max_http_buffer_size=16 * 1024 * 1024,  # headroom for base64-encoded files
)

# ---------------------------------------------------------------------------
# In-memory state (Section 4 / 7 of the project plan: no permanent storage)
# ---------------------------------------------------------------------------
# sid -> username, only for currently connected clients.
connected_users = {}


def get_local_ip():
    """Best-effort guess of this machine's LAN IP, for convenience printing."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        # Doesn't actually send anything; just used to pick the right interface.
        s.connect(("8.8.8.8", 80))
        ip = s.getsockname()[0]
    except Exception:
        ip = "127.0.0.1"
    finally:
        s.close()
    return ip


def timestamp():
    return datetime.now().strftime("%H:%M:%S")


# ---------------------------------------------------------------------------
# HTTP route - serves the chat page
# ---------------------------------------------------------------------------
@app.route("/")
def index():
    return render_template("index.html")


# ---------------------------------------------------------------------------
# WebSocket events
# ---------------------------------------------------------------------------
@socketio.on("connect")
def handle_connect():
    # Client hasn't set a username yet at this point; nothing to broadcast.
    print(f"[+] Client connected: {request.sid}")


@socketio.on("disconnect")
def handle_disconnect():
    username = connected_users.pop(request.sid, None)
    if username:
        print(f"[-] {username} disconnected")
        emit(
            "system_message",
            {"text": f"{username} left the chat.", "time": timestamp()},
            broadcast=True,
        )
        emit("user_list", {"users": list(connected_users.values())}, broadcast=True)


@socketio.on("join")
def handle_join(data):
    """Client sends this once, right after connecting, with a chosen username."""
    username = (data or {}).get("username", "").strip() or "Anonymous"

    # Avoid duplicate display names causing confusion (simple, in-memory only).
    original = username
    counter = 2
    existing_names = set(connected_users.values())
    while username in existing_names:
        username = f"{original}{counter}"
        counter += 1

    connected_users[request.sid] = username
    print(f"[+] {username} joined")

    emit("joined", {"username": username})
    emit(
        "system_message",
        {"text": f"{username} joined the chat.", "time": timestamp()},
        broadcast=True,
        include_self=False,
    )
    emit("user_list", {"users": list(connected_users.values())}, broadcast=True)


@socketio.on("send_message")
def handle_send_message(data):
    username = connected_users.get(request.sid, "Anonymous")
    text = (data or {}).get("text", "").strip()
    if not text:
        return

    # Nothing here is written to disk or a database — memory only, per client list.
    emit(
        "receive_message",
        {"username": username, "text": text, "time": timestamp()},
        broadcast=True,
    )


@socketio.on("send_file")
def handle_send_file(data):
    """Relay a file/document to all connected clients.

    The file is passed through as a base64 data URL and is never written
    to disk on the server — it only exists in transit, consistent with the
    "no permanent storage" design of the rest of the chat.
    """
    username = connected_users.get(request.sid, "Anonymous")
    data = data or {}

    filename = str(data.get("filename", "file"))[:255]
    mimetype = str(data.get("mimetype", "application/octet-stream"))
    file_data = data.get("data", "")  # base64 string (no data: prefix)
    size = int(data.get("size", 0) or 0)
    caption = (data.get("caption") or "").strip()

    if not file_data:
        return

    if size > MAX_FILE_SIZE:
        emit(
            "system_message",
            {
                "text": f"File '{filename}' is too large to send (max 10 MB).",
                "time": timestamp(),
            },
        )
        return

    emit(
        "receive_file",
        {
            "username": username,
            "filename": filename,
            "mimetype": mimetype,
            "data": file_data,
            "size": size,
            "caption": caption,
            "time": timestamp(),
        },
        broadcast=True,
    )


@socketio.on("typing")
def handle_typing(data):
    username = connected_users.get(request.sid, "Anonymous")
    is_typing = bool((data or {}).get("typing", False))
    emit(
        "typing_status",
        {"username": username, "typing": is_typing},
        broadcast=True,
        include_self=False,
    )


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    local_ip = get_local_ip()
    port = 5000
    print("=" * 60)
    print(" GreenChat server starting...")
    print(f"   Local:   http://localhost:{port}")
    print(f"   Network: http://{local_ip}:{port}   (share this with other computers)")
    print("=" * 60)
    # host="0.0.0.0" is what makes this reachable from other computers on the LAN
    # (Phase 3 of the project plan).
    socketio.run(app, host="0.0.0.0", port=port, debug=True, allow_unsafe_werkzeug=True)

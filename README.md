# ⛏ Windows Minecraft Server Manager

A real-time, web-based Minecraft server manager built with Node.js and Socket.IO. Run it locally and manage your server from any browser on your network — no client software required.

![Node.js](https://img.shields.io/badge/Node.js-18+-339933?style=flat&logo=node.js&logoColor=white)
![Platform](https://img.shields.io/badge/Platform-Windows-0078D6?style=flat&logo=windows&logoColor=white)

---

## Features

- **Multi-Server Support** — manage multiple server instances from one dashboard, switch between them instantly
- **Real-time Console** — live server output with colour-coded log levels, search/filter, command history, and save to file
- **Player Management** — view online players, kick, ban, op/deop, change gamemode, manage whitelist and ban list
- **Plugin Manager** — upload plugins via drag & drop, enable/disable, delete, and view plugin metadata (name, version, author) read directly from the JAR
- **File Editor** — browse and edit any server file (configs, datapacks, YAMLs) directly in the browser with Ctrl+S to save
- **World Backups** — one-click backups that zip your world, plugins, and config files; configurable backup directory; download backups from the browser
- **Task Scheduler** — schedule commands, automatic backups, or server restarts on any interval with pre-restart warnings
- **Performance Monitor** — live RAM and CPU usage charts (real percentage, Windows-compatible), updating every 5 seconds
- **Discord Webhooks** — get notified on server start/stop, crashes, and player join/leave
- **Password Protection** — optional login screen to secure the web UI on a shared network

---

## Requirements

- [Node.js 18+](https://nodejs.org)
- [Java 17+](https://adoptium.net) (for running the Minecraft server itself)
- A Minecraft server JAR (Paper, Spigot, Vanilla, Fabric, etc.)

---

## Installation

```bash
# 1. Clone the repo
git clone https://github.com/yourusername/minecraft-server-manager.git
cd minecraft-server-manager

# 2. Install dependencies
npm install

# 3. Start the manager
npm start
```

Then open **http://localhost:3000** in your browser.

---

## First-Time Setup

1. Click **+ Add** in the header to add your first server
2. Fill in:
   - **Name** — anything you like
   - **Server Path** — the folder containing your server JAR, e.g. `C:\minecraft-server`
   - **JAR File** — the filename of your server JAR, e.g. `paper-1.21.4.jar`
   - **Java Path** — `java` if Java is on your PATH, otherwise the full path e.g. `C:\Program Files\Eclipse Adoptium\jdk-21\bin\java.exe`
   - **JVM Args** — memory allocation, e.g. `-Xmx4G -Xms2G`
3. Click **Save**, then hit **▶ Start**

---

## Building a Standalone Executable

You can compile the app into a single `.exe` that requires nothing installed — just share the file.

```bash
# Install pkg globally
npm install -g pkg

# Build
npm run build
```

The executable will be output to `dist/minecraft-server-manager.exe`. Place it in any folder and run it — `config.json` and the `backups/` folder will be created alongside it automatically.

> **Note:** Windows Defender may flag the executable as a false positive since it contains a bundled Node.js runtime. You may need to add an exclusion.

---

## Project Structure

```
minecraft-server-manager/
├── server.js           # Express + Socket.IO backend
├── package.json
├── config.json         # Auto-generated on first run
├── backups/            # Auto-generated backup storage
└── public/
    └── index.html      # Full web UI (single file)
```

---

## Tech Stack

| | |
|---|---|
| **Backend** | Node.js, Express, Socket.IO |
| **Frontend** | Vanilla JS, Chart.js, Socket.IO client |
| **Packaging** | pkg |

---

## Security Note

This tool is intended for **local or LAN use only**. If you expose port 3000 to the internet, enable password protection in the Settings tab. Consider using a reverse proxy with HTTPS for any public-facing deployment.

---

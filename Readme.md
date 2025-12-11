![alt text](https://github.com/Samuele98-git/Mediater/blob/main/imgxtx/mediater.png)

# Mediater
> Your private, self-hosted media streaming library.

**Mediater** is a lightweight, high-performance media server built with Node.js. It transforms your local folder of videos and images into a sleek, streaming service accessible from any browser on your network.

## ✨ Features

* **📋 Playlist Management:** Create custom playlists, upload custom covers, and drag-and-drop to reorder episodes.
* **👥 Multi-User System:** Role-based access (Admin vs. Viewer). Admins can upload content; Viewers can only watch.
* **⚡ Smart Streaming:** Supports HTTP Range Requests for instant seeking and fast playback on mobile/TV.
* **🔄 Auto-Play:** Automatically plays the next video in the playlist (Binge-watch mode).
* **🔒 Admin Dashboard:** Manage users, reset passwords, and organize content via a GUI.

---

## 🛠️ Prerequisites

Before you begin, ensure you have **Node.js** installed.

* **Windows:** Download from [nodejs.org](https://nodejs.org/).
* **Linux (Ubuntu/Debian):** `sudo apt install nodejs npm`
* **Linux (RHEL/Oracle/CentOS):**
    ```
    curl -fsSL [https://rpm.nodesource.com/setup_20.x](https://rpm.nodesource.com/setup_20.x) | sudo bash -
    sudo dnf install -y nodejs
    ```

---

## 🚀 Installation & Setup

### 1. Clone or Download
Download this repository and extract it, or clone it via git:
```
git clone https://github.com/Samuele98-git/Mediater.git
cd mediater
```
---
 
### Install Dependencies
```npm install```

---

### Configuration
Ensure you have a ```nodemon.json``` file in the root directory to prevent the server from restarting during uploads. If it's missing, create it:
```
{
  "ignore": ["uploads/*", "public/*", "data.json"],
  "ext": "js,json"
}
```
---
### 🖥️ How to Run
On Windows and linux:
```npm run dev```

on Linux (Server/Headless)
Open the Firewall port (Required for accessing from phones/TVs):
```
sudo firewall-cmd --zone=public --add-port=3000/tcp --permanent
sudo firewall-cmd --reload
npm run dev
```
---

### Default:

```http://localhost:3000```

### Credentials:
---
User:
```admin```

Password:
```123```

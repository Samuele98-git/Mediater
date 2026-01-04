# Mediater 🍿

**Mediater** is a self-hosted, premium media streaming server inspired by the aesthetics of popular streaming platforms. It features a sleek, responsive "Netflix-style" viewer interface and a powerful Admin Dashboard for managing content, users, and settings without touching code.

![Mediater](/imgxtx/mediater.png)

## ✨ Features

* **Premium Interface:** Dark mode, responsive design, horizontal sliders, and touch support for mobile/tablets.
* **Admin Dashboard:** Full GUI management of Movies, Series, and Episodes.
* **Drag & Drop Upload:** Upload covers and video files directly from the browser to your server.
* **User Management:** Create Admins and Viewers. Users can manage their own profiles (Avatar/Password).
* **SSO Support:** Native integration for **Authentik** and **Keycloak** (OpenID Connect).
* **Series Support:** Automatic handling of Seasons/Episodes with a dedicated playlist view.
* **Persistent Sessions:** Secure login sessions that survive server restarts.
* **Customization:** Change the App Name and Accent Colors dynamically from the Admin Settings.

---

## 🚀 Prerequisites

Before you begin, ensure you have the following installed on your machine:

* **Node.js** (Version 18 or higher) - [Download Here](https://nodejs.org/)
* **Git** - [Download Here](https://git-scm.com/)

---

## 💻 Local Installation (Windows, macOS, Linux)

Follow these steps to run Mediater on your personal computer for development or home use.

### 1. Clone the Repository
Open your terminal (Command Prompt, PowerShell, or Terminal) and run:

```bash
git clone https://github.com/Samuele98-git/Mediater.git
cd mediater
```

### 2. Install Dependencies
Install the required system packages:

```bash
npm install
```

### 3. Initialize the Database
Mediater uses **SQLite**, so no external database installation is required. Run this command to create the database file:

```bash
npx prisma db push
```

### 4. Start the Server
Launch the application:

```bash
node server.js
```

### 5. Access the App
Open your browser and navigate to:
**http://localhost:3000**

> **Default Credentials:**
>
> * **Username:** `admin`
> * **Password:** `admin123`

---

## 🌐 Server Deployment (VPS / Ubuntu / Debian)

If you want to run Mediater on a VPS (like DigitalOcean, Hetzner, AWS) to access it from anywhere.

### 1. Setup on Server
Log into your server and follow the **Local Installation** steps above (Clone, Install, DB Push).

### 2. Run in Background (PM2)
Instead of running `node server.js` (which stops when you close the SSH window), use **PM2** to keep it running forever.

```bash
# Install PM2 globally
sudo npm install -g pm2

# Start Mediater
pm2 start server.js --name "mediater"

# Make it start automatically on server reboot
pm2 startup
pm2 save
```

### 3. Expose to the Web (Nginx Proxy)
To access it via a domain (e.g., `media.yourdomain.com`) instead of `IP:3000`, set up Nginx as a reverse proxy.

1.  **Install Nginx:**
    ```bash
    sudo apt update
    sudo apt install nginx
    ```

2.  **Create a config file:**
    ```bash
    sudo nano /etc/nginx/sites-available/mediater
    ```

3.  **Paste this configuration inside** (Change `server_name` to your domain):

```nginx
server {
    listen 80;
    server_name media.yourdomain.com; # <--- REPLACE WITH YOUR DOMAIN

    # Max upload size for video files (e.g., 10GB)
    client_max_body_size 10000M;

    location / {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;
    }
}
```

4.  **Enable the site and restart Nginx:**

```bash
sudo ln -s /etc/nginx/sites-available/mediater /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl restart nginx
```

---

## ⚙️ Configuration & Customization

### Changing Branding (Theme)
1.  Log in as Admin.
2.  Go to **Dashboard** -> **Settings**.
3.  Change **App Name** (e.g., "MyStream") and **Accent Color** (e.g., Gold, Blue).
4.  Click **Save**. The interface updates immediately for all users.

### Setting up Authentik / Keycloak (SSO)
To enable the "Login with SSO" button on the login page:
1.  Go to **Dashboard** -> **Settings**.
2.  Enter your OIDC details provided by Authentik/Keycloak (Client ID, Secret, Issuer URL, etc.).
3.  Save.
4.  Logout. The login page will now show the SSO option automatically.

---

## 📂 Project Structure

* **`server.js`** - Main application entry point and configuration.
* **`routes/`** - Logic split into modules (Auth, Admin, Profile, Views).
* **`views/`** - EJS Templates (The HTML frontend).
* **`public/uploads/`** - Where your uploaded images and videos are stored locally.
* **`prisma/schema.prisma`** - Database structure configuration.

---

## 🛠 Troubleshooting

**Problem: "Login Loop" (Keep getting logged out)**
* Ensure you are accessing via `http://localhost:3000`.
* If developing locally, ensure cookies are enabled. The app uses relaxed cookie security for localhost.

**Problem: "File too large" error during upload**
* The internal limit is set to 5GB.
* If using Nginx, ensure `client_max_body_size` is set correctly in the Nginx config (see Deployment section).

**Problem: Database errors or Schema changes**
* If you change the code significantly, delete the `dev.db` file and run `npx prisma db push` to reset the database cleanly.

---

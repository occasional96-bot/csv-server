# CSV Server 📦

Upload and fetch CSV files by name over the internet.

---

## 🚀 Deploy to Railway (Free)

1. Go to https://railway.app and sign up (free)
2. Click **"New Project" → "Deploy from GitHub"**
3. Push this folder to a GitHub repo first, then connect it
   - OR use Railway CLI: `npm install -g @railway/cli` → `railway up`
4. Railway auto-detects Node.js and runs `npm start`
5. Click your deployment → **Settings → Generate Domain**
   - You'll get a URL like: `https://csv-server-production.up.railway.app`

---

## 📡 API Endpoints

### Upload a CSV
```
POST /upload
Content-Type: multipart/form-data
Key: file  →  your .csv file
```

### Fetch a CSV by name
```
GET /file/parts.csv
```

### List all files
```
GET /files
```

### Delete a file
```
DELETE /file/parts.csv
```

---

## 🧪 Test Locally First

```bash
npm install
npm start
# Server runs at http://localhost:3000
```

Upload test (using curl):
```bash
curl -F "file=@yourfile.csv" http://localhost:3000/upload
```

Fetch test:
```bash
curl http://localhost:3000/file/yourfile.csv
```

---

## 📱 In Your React Native App

```javascript
// Fetch a CSV
const response = await fetch('https://your-railway-url.up.railway.app/file/parts.csv');
const csvText = await response.text();
```

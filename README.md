# YouTube-Subscription-Calendar

A web-based calendar application that authenticates with your YouTube account and displays recent uploads from your subscribed channels in an interactive, filterable monthly calendar with PostgreSQL-backed watch history.

## Features
- **Google Authentication:** Securely log in with your YouTube account using OAuth 2.0 (Google Identity Services).
- **Dynamic Calendar:** View all recent content from your subscriptions on an interactive monthly calendar.
- **Content Categorization:** Automatically identifies and color-codes Standard Videos, Livestreams, YouTube Shorts, and Community Posts.
- **Detailed Day View:** Click on any day to see a detailed, chronologically sorted list of all content with thumbnails and upload times.
- **Persistent Watch History (PostgreSQL):** Mark videos as watched with real-time persistence to a PostgreSQL relational database (Supabase), backed by a local fast-cache for instant loading.
- **Relational Data Modeling:** Normalized database schema linking a `users` table to `watched_videos` using Foreign Keys, unique constraints, and cascade deletion.
- **Filtering & Searching:**
  - Toggle content types on or off via the legend.
  - Instantly search for content by title or channel name.
- **Smart Caching:** API results are cached for 15 minutes to conserve YouTube API quota and provide fast load times.
- **Force Refresh:** Dedicated button to bypass the cache and fetch the latest subscription data on demand.

## Technologies Used
- **Frontend:** Vanilla JavaScript (ES6+), HTML5, CSS3 (Grid & Flexbox)
- **Backend / API:** Node.js, Express, Vercel Serverless Functions
- **Database:** PostgreSQL (hosted on Supabase), `node-postgres` (`pg`) driver
- **APIs & Auth:** YouTube Data API v3, Google Identity Services (GIS)

## Database Schema
The database uses a normalized relational structure:
- **`users` table:** Tracks unique user identifiers (`id`, `created_at`, `last_seen_at`).
- **`watched_videos` table:** Stores watched video records linked via Foreign Key (`user_id REFERENCES users(id) ON DELETE CASCADE`), with a `UNIQUE(user_id, video_id)` constraint and indexed lookups.

## How to Run Locally

### 1. Install Dependencies
```bash
npm install
```

### 2. Configure Credentials
- **Google API:** Create a `config.js` file in the root directory (or let `build.js` generate it) with your Google API credentials:
  ```javascript
  const CLIENT_ID = "YOUR_GOOGLE_CLIENT_ID";
  const API_KEY = "YOUR_GOOGLE_API_KEY";
  ```
- **PostgreSQL Database:** Create a `.env` file (see `.env.example`) with your Supabase Transaction Pooler connection string:
  ```env
  DATABASE_URL="postgresql://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres"
  PORT=8000
  ```

### 3. Initialize the Database Schema
Apply the tables and indexes to your PostgreSQL database:
```bash
npm run init-db
```

### 4. Configure Google Cloud Console
In your Google Cloud Console, under your OAuth 2.0 Client ID settings, add `http://localhost:8000` to **Authorized JavaScript origins**.

### 5. Start the Server
```bash
npm run dev
```
Open `http://localhost:8000` in your browser.

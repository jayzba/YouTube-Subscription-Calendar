/**
 * Local Full-Stack Server (Express + PostgreSQL)
 * Serves static frontend files AND mounts the /api/watched PostgreSQL endpoint.
 */
require('dotenv').config();
const express = require('express');
const path = require('path');
const watchedHandler = require('./api/watched');

const app = express();
const PORT = process.env.PORT || 8000;

// Parse incoming JSON request bodies
app.use(express.json());

// Mount the PostgreSQL API endpoint
app.all('/api/watched', (req, res) => watchedHandler(req, res));

// Serve static frontend files (index.html, script.js, style.css, config.js)
app.use(express.static(path.join(__dirname)));

app.listen(PORT, () => {
    console.log(`✓ Server running at http://localhost:${PORT}`);
    if (!process.env.DATABASE_URL) {
        console.warn('⚠ WARNING: DATABASE_URL is not set in .env. PostgreSQL sync will be unavailable until configured.');
    } else {
        console.log('✓ PostgreSQL DATABASE_URL detected.');
    }
});


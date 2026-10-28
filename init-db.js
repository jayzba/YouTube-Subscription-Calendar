/**
 * Database Initialization Script
 * Reads schema.sql and executes it against the PostgreSQL database configured in .env
 * Usage: npm run init-db
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

async function initDatabase() {
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) {
        console.error('ERROR: DATABASE_URL is not set in your .env file.');
        console.error('Copy .env.example to .env and add your Supabase or local PostgreSQL connection string.');
        process.exit(1);
    }

    const isLocal =
        connectionString.includes('localhost') ||
        connectionString.includes('127.0.0.1');

    const pool = new Pool({
        connectionString,
        ssl: isLocal ? false : { rejectUnauthorized: false }
    });

    try {
        const schemaPath = path.join(__dirname, 'schema.sql');
        const schemaSql = fs.readFileSync(schemaPath, 'utf8');

        console.log('Connecting to PostgreSQL and applying schema.sql...');
        await pool.query(schemaSql);
        console.log('✓ PostgreSQL schema applied successfully! Tables `users` and `watched_videos` are ready.');
    } catch (error) {
        console.error('✗ Failed to initialize database schema:', error.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

initDatabase();


const { Pool } = require('pg');

let pool;

function getPool() {
    if (!pool) {
        const connectionString = process.env.DATABASE_URL;
        if (!connectionString) {
            throw new Error('DATABASE_URL environment variable is not set.');
        }

        const isLocal =
            connectionString.includes('localhost') ||
            connectionString.includes('127.0.0.1');

        pool = new Pool({
            connectionString,
            ssl: isLocal ? false : { rejectUnauthorized: false }
        });
    }
    return pool;
}

/**
 * Backend API Handler for /api/watched
 * Compatible with both Vercel Serverless Functions and local Express server.
 */
module.exports = async function handler(req, res) {
    if (!process.env.DATABASE_URL) {
        return res.status(503).json({
            error: 'Database not configured. Set DATABASE_URL in your .env file or Vercel environment variables.'
        });
    }

    const db = getPool();

    try {
        // ====================================================================
        // GET /api/watched?userId=...
        // Prunes records older than 90 days and returns the user's watch history
        // ====================================================================
        if (req.method === 'GET') {
            const userId = req.query.userId;
            if (!userId) {
                return res.status(400).json({ error: 'Missing required query parameter: userId' });
            }

            // 1. Prune watch history older than 90 days for this user
            await db.query(
                `DELETE FROM watched_videos
                 WHERE user_id = $1
                   AND watched_at < CURRENT_DATE - INTERVAL '90 days'`,
                [userId]
            );

            // 2. Fetch all active watched videos for this user
            const result = await db.query(
                `SELECT video_id, title, channel, thumbnail_url, video_type, video_url, watched_at
                 FROM watched_videos
                 WHERE user_id = $1
                 ORDER BY watched_at DESC`,
                [userId]
            );

            return res.status(200).json({ watchedVideos: result.rows });
        }

        // ====================================================================
        // POST /api/watched
        // Upserts user and saves one or more watched videos in a SQL transaction
        // ====================================================================
        if (req.method === 'POST') {
            const { userId, video, videos } = req.body || {};
            const videosToSave = Array.isArray(videos) ? videos : (video ? [video] : []);

            if (!userId || videosToSave.length === 0) {
                return res.status(400).json({
                    error: 'Request body must include userId and video (or videos array).'
                });
            }

            const client = await db.connect();
            try {
                await client.query('BEGIN');

                // 1. Ensure the user exists in the parent `users` table (satisfies Foreign Key)
                await client.query(
                    `INSERT INTO users (id, last_seen_at)
                     VALUES ($1, NOW())
                     ON CONFLICT (id)
                     DO UPDATE SET last_seen_at = NOW()`,
                    [userId]
                );

                // 2. Upsert each watched video into `watched_videos`
                const savedRows = [];
                const upsertVideoQuery = `
                    INSERT INTO watched_videos (
                        user_id, video_id, title, channel, thumbnail_url, video_type, video_url, watched_at
                    )
                    VALUES ($1, $2, $3, $4, $5, $6, $7, CURRENT_DATE)
                    ON CONFLICT (user_id, video_id)
                    DO UPDATE SET
                        title = EXCLUDED.title,
                        channel = EXCLUDED.channel,
                        thumbnail_url = EXCLUDED.thumbnail_url,
                        video_type = EXCLUDED.video_type,
                        video_url = EXCLUDED.video_url,
                        watched_at = CURRENT_DATE
                    RETURNING *;
                `;

                for (const item of videosToSave) {
                    const videoId = item.id || item.videoId;
                    if (!videoId) continue;

                    const values = [
                        userId,
                        videoId,
                        item.title || null,
                        item.channel || null,
                        item.thumbnail || null,
                        item.type || null,
                        item.url || null
                    ];
                    const { rows } = await client.query(upsertVideoQuery, values);
                    if (rows[0]) {
                        savedRows.push(rows[0]);
                    }
                }

                await client.query('COMMIT');
                return res.status(200).json({ saved: savedRows.length, records: savedRows });
            } catch (txError) {
                await client.query('ROLLBACK');
                throw txError;
            } finally {
                client.release();
            }
        }

        // ====================================================================
        // DELETE /api/watched
        // Removes a specific video from a user's watch history
        // ====================================================================
        if (req.method === 'DELETE') {
            const { userId, videoId } = req.body || req.query || {};
            if (!userId || !videoId) {
                return res.status(400).json({ error: 'Missing userId or videoId' });
            }

            await db.query(
                `DELETE FROM watched_videos WHERE user_id = $1 AND video_id = $2`,
                [userId, videoId]
            );

            return res.status(200).json({ deleted: true });
        }

        res.setHeader('Allow', ['GET', 'POST', 'DELETE']);
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    } catch (error) {
        console.error('PostgreSQL API Error:', error);
        return res.status(500).json({ error: 'Internal Server Error', details: error.message });
    }
};


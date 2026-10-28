-- ============================================================================
-- PostgreSQL Schema for YouTube Subscription Calendar
-- Run this script in your Supabase SQL Editor (or local psql / pgAdmin)
-- ============================================================================

-- 1. Users Table
-- Stores unique user identifiers (e.g., YouTube Channel ID or local fallback ID)
CREATE TABLE IF NOT EXISTS users (
    id VARCHAR(128) PRIMARY KEY,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

-- 2. Watched Videos Table
-- Stores each video a user has marked as watched, linked to the users table
-- via a FOREIGN KEY with ON DELETE CASCADE (if a user is deleted, their history is deleted).
CREATE TABLE IF NOT EXISTS watched_videos (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(128) NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    video_id VARCHAR(64) NOT NULL,
    title TEXT,
    channel TEXT,
    thumbnail_url TEXT,
    video_type VARCHAR(32),
    video_url TEXT,
    watched_at DATE DEFAULT CURRENT_DATE,
    -- Prevents duplicate entries when the same user clicks the same video multiple times
    CONSTRAINT unique_user_video UNIQUE (user_id, video_id)
);

-- 3. Indexes for Query Performance
-- Speeds up fetching watch history for a specific user and pruning old records
CREATE INDEX IF NOT EXISTS idx_watched_videos_user_id ON watched_videos(user_id);
CREATE INDEX IF NOT EXISTS idx_watched_videos_watched_at ON watched_videos(watched_at);
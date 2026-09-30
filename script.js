/**
 * Escapes HTML special characters to prevent XSS when injecting API data via innerHTML.
 * @param {string} str The untrusted string to escape.
 * @returns {string} The escaped string safe for HTML insertion.
 */
function escapeHTML(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

const calendarBody = document.getElementById('calendar-body');
const prevMonthBtn = document.getElementById('prev-month-btn');
const nextMonthBtn = document.getElementById('next-month-btn');
const authBtn = document.getElementById('auth-btn');
const todayBtn = document.getElementById('today-btn');
const forceRefreshBtn = document.getElementById('force-refresh-btn');
const searchInput = document.getElementById('search-input');
const modal = document.getElementById('details-modal');
const modalOverlay = document.getElementById('modal-overlay');
const modalContent = document.getElementById('modal-content');
const loadingOverlay = document.getElementById('loading-overlay');
const modalCloseBtn = document.getElementById('modal-close-btn');
const prevDayBtn = document.getElementById('prev-day-btn');
const nextDayBtn = document.getElementById('next-day-btn');
let currentDate = new Date();
let currentlyViewedDate = null;

let gapiInited = false;
let gisInited = false;
let tokenClient;
let uploads = []; // This will hold the real data from the API
// --- Watch History with Timestamps & Auto-Pruning ---
const WATCH_HISTORY_MAX_AGE_DAYS = 90;
let watchedData; // Object: { videoId: timestamp, ... }
let watchedIds;  // Set for fast .has() lookups

function loadWatchHistory() {
    try {
        const raw = JSON.parse(localStorage.getItem('watchedVideoIds'));
        if (!raw) {
            return { data: {}, ids: new Set() };
        }
        // Backward compatibility: old format was a flat array ["id1", "id2", ...]
        if (Array.isArray(raw)) {
            const now = Date.now();
            const migrated = {};
            raw.forEach(id => { migrated[id] = now; });
            console.log(`DEBUG: Migrated ${raw.length} watch history entries from array to timestamped format.`);
            return { data: migrated, ids: new Set(raw) };
        }
        // New format: { id: timestamp, ... } — prune old entries
        const cutoff = Date.now() - (WATCH_HISTORY_MAX_AGE_DAYS * 24 * 60 * 60 * 1000);
        const pruned = {};
        let prunedCount = 0;
        for (const [id, ts] of Object.entries(raw)) {
            if (ts >= cutoff) {
                pruned[id] = ts;
            } else {
                prunedCount++;
            }
        }
        if (prunedCount > 0) {
            console.log(`DEBUG: Pruned ${prunedCount} watch history entries older than ${WATCH_HISTORY_MAX_AGE_DAYS} days.`);
        }
        return { data: pruned, ids: new Set(Object.keys(pruned)) };
    } catch (e) {
        console.error("Could not parse watchedVideoIds from localStorage. Resetting.", e);
        return { data: {}, ids: new Set() };
    }
}

function saveWatchHistory(videoId) {
    // Keep the local storage version as a fallback/fast cache
    localStorage.setItem('watchedVideoIds', JSON.stringify(watchedData));

    // If a videoId was provided, save it to Firebase
    if (videoId && window.firebaseDB) {
        // Find the full video object from our loaded uploads
        const video = uploads.find(u => u.id === videoId);
        
        if (video) {
            // Use the real Firebase user ID if available, otherwise fallback to local
            let userId = window.firebaseUserId || localStorage.getItem('local_user_id');
            if (!userId) {
                userId = 'user_' + Math.random().toString(36).substr(2, 9);
                localStorage.setItem('local_user_id', userId);
            }

            try {
                // Reference: users/{userId}/watchedVideos/{videoId}
                const videoRef = window.firestoreDocs.doc(window.firebaseDB, "users", userId, "watchedVideos", video.id);

                window.firestoreDocs.setDoc(videoRef, {
                    videoId: video.id,
                    title: video.title,
                    channel: video.channel,
                    thumbnail: video.thumbnail || null,
                    type: video.type,
                    url: video.url,
                    watchedAt: new Date().toISOString(),
                    watched: true
                }).then(() => {
                    console.log("Watch history saved to Firestore successfully!");
                }).catch(error => {
                    console.error("Error saving to Firestore:", error);
                });
            } catch (error) {
                console.error("Error setting up Firebase document:", error);
            }
        }
    }
}

function markAsWatched(videoId) {
    if (!videoId) return;
    watchedData[videoId] = Date.now();
    watchedIds.add(videoId);
    saveWatchHistory(videoId);
}

({ data: watchedData, ids: watchedIds } = loadWatchHistory());
saveWatchHistory(); // Persist the pruned/migrated version immediately

// The permissions your app is requesting
const SCOPES = 'https://www.googleapis.com/auth/youtube.readonly';

function gapiLoaded() {
    console.log('DEBUG: gapiLoaded() called.');
    gapi.load('client', initializeGapiClient);
}

function gisLoaded() {
    console.log('DEBUG: gisLoaded() called.');
    try {
        tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CLIENT_ID,
            scope: SCOPES,
            callback: handleTokenResponse, // Callback function to handle the token
            error_callback: (error) => {
                console.error('DEBUG: GIS Error Callback:', error);
                // This can happen if 3rd-party cookies are blocked. The silent sign-in will fail.
                // The 'prompt: none' request will then call the main `callback` with an error object.
            }
        });
        gisInited = true;
        console.log('DEBUG: GIS client initialized.');
        checkAndInitializeAuth(); // Renamed to reflect its purpose better
    } catch (error) {
        console.error('DEBUG: Error initializing GIS client:', error);
    }
}

async function initializeGapiClient() {
    console.log('DEBUG: initializeGapiClient() called.');
    try {
        await gapi.client.init({
            apiKey: API_KEY,
            discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/youtube/v3/rest'],
        });
        gapiInited = true;
        console.log('DEBUG: GAPI client initialized.');
        checkAndInitializeAuth(); // Renamed
    } catch (error) {
        console.error('DEBUG: Error initializing GAPI client:', error);
    }
}

function handleAuthClick() {
    if (gapi.client.getToken() === null) {
        console.log('DEBUG: handleAuthClick() triggered. Requesting access token.');
        // Prompt the user to select a Google Account and ask for consent to share their data
        tokenClient.requestAccessToken({ prompt: 'consent select_account' });
    } else {
        // The user is already signed in and has given consent
        console.log('User is already authenticated.');
        // Optionally, you could add sign-out logic here
    }
}

function handleSignoutClick() {
    const token = gapi.client.getToken();
    if (token !== null) {
        google.accounts.oauth2.revoke(token.access_token, () => {
            gapi.client.setToken(null);
            localStorage.removeItem('youtube_access_token');
            localStorage.removeItem('youtube_calendar_cache');
            localStorage.removeItem('watchedVideoIds');
            window.firebaseUserId = null; // Clear Firebase UID
            if (window.firebaseAuth) window.firebaseAuth.auth.signOut();
            watchedData = {};
            watchedIds.clear();
            uploads = []; // Clear data on sign out
            updateAuthUI();
            renderCalendar(currentDate); // Re-render to clear view
        });
    }
}

function syncFirebaseAuth(accessToken) {
    if (window.firebaseAuth) {
        const { auth, signInWithCredential, GoogleAuthProvider } = window.firebaseAuth;
        const credential = GoogleAuthProvider.credential(null, accessToken);
        signInWithCredential(auth, credential).then((result) => {
            console.log("DEBUG: Synced with Firebase Auth. UID:", result.user.uid);
            window.firebaseUserId = result.user.uid;
        }).catch((error) => {
            console.error("DEBUG: Firebase auth sync failed:", error);
        });
    }
}

function handleTokenResponse(tokenResponse) {
    // The GIS library can return an error object to the callback.
    if (tokenResponse && tokenResponse.error) {
        console.error('DEBUG: Token response contained an error (likely silent sign-in failure):', tokenResponse.error);
        updateAuthUI();
        return;
    }
    // If we get here, sign-in was successful (either silent or manual).
    gapi.client.setToken(tokenResponse);
    localStorage.setItem('youtube_access_token', tokenResponse.access_token);
    syncFirebaseAuth(tokenResponse.access_token); // Log into Firebase
    updateAuthUI();
}

let authSetupComplete = false; // New flag to ensure initial button setup runs only once

function checkAndInitializeAuth() { // Renamed from initializeSession
    // This function is called after each library loads.
    // It will only run its logic once both are ready and it hasn't run before.
    if (gapiInited && gisInited && !authSetupComplete) {
        authSetupComplete = true;
        console.log("DEBUG: Both GAPI and GIS are initialized. Performing initial auth setup.");

        // Enable the button and set its initial click handler
        authBtn.disabled = false;
        authBtn.onclick = handleAuthClick; // Default to login handler
        console.log('DEBUG: Auth button enabled and default handleAuthClick assigned.');

        // Attempt to restore session from localStorage
        const savedToken = localStorage.getItem('youtube_access_token');
        if (savedToken) {
            console.log("DEBUG: Found saved token, setting it in gapi.client.");
            gapi.client.setToken({ access_token: savedToken });
            syncFirebaseAuth(savedToken); // Log into Firebase
        }
        updateAuthUI(); // Update UI based on current auth state (token might be null or restored)
    }
}

function updateAuthUI() { // This function now primarily updates the button's text and handler based on current auth state
    console.log('DEBUG: updateAuthUI() called.');
    // Don't do anything until both libraries are loaded.
    if (!authSetupComplete) { // Ensure initial setup has run
        console.log('DEBUG: updateAuthUI: Initial auth setup not complete. Returning.');
        return;
    }

    console.log('DEBUG: updateAuthUI: Initial auth setup complete. Updating button state.');
    const token = gapi.client.getToken();
    const isSignedIn = token !== null;

    if (isSignedIn) {
        authBtn.textContent = 'Log Out';
        forceRefreshBtn.style.display = 'inline-block';
        authBtn.onclick = handleSignoutClick;
        console.log('DEBUG: UI updated to "Log Out" state.');

        // Check for a cache first
        const cachedDataJSON = localStorage.getItem('youtube_calendar_cache');
        let hasRenderedCache = false;
        try {
            const CACHE_EXPIRATION_MINUTES = 15;
            if (cachedDataJSON) {
                const cache = JSON.parse(cachedDataJSON);

                // Immediately render from cache, regardless of age!
                console.log(`DEBUG: Found cache. Loading immediately.`);
                uploads = cache.uploads.map(upload => ({
                    ...upload,
                    publishedAt: new Date(upload.publishedAt)
                }));
                renderCalendar(currentDate);
                hasRenderedCache = true;

                const cacheAgeMinutes = (new Date().getTime() - cache.timestamp) / 1000 / 60;

                if (cacheAgeMinutes < CACHE_EXPIRATION_MINUTES) {
                    console.log(`DEBUG: Cache is fresh (less than ${CACHE_EXPIRATION_MINUTES} minutes old). No background fetch needed.`);
                    return; // We're done, no need to fetch from API
                } else {
                    console.log("DEBUG: Cache is stale, will fetch new data in background.");
                }
            }
        } catch (e) {
            console.error("Could not parse calendar cache from localStorage. Resetting.", e);
            localStorage.removeItem('youtube_calendar_cache');
        }

        // If we reach here, we need to fetch from API (either no cache or stale cache).
        fetchSubscriptions(hasRenderedCache);
    } else {
        authBtn.textContent = 'Log In with YouTube';
        forceRefreshBtn.style.display = 'none';
        authBtn.onclick = handleAuthClick;
        console.log('DEBUG: UI updated to "Log In" state.');
    }
}

async function fetchSubscriptions(isBackgroundRefresh = false) {
    if (!isBackgroundRefresh) {
        loadingOverlay.style.display = 'flex';
    }

    try {
        let allSubscriptions = [];
        let nextPageToken = '';

        // We use a do...while loop because users might have more than 50 subscriptions.
        // The API returns up to 50 at a time, plus a token to get the next page.
        do {
            const response = await gapi.client.youtube.subscriptions.list({
                part: 'snippet',
                mine: true,
                maxResults: 50,
                pageToken: nextPageToken
            });

            const items = response.result.items;
            if (items) {
                allSubscriptions = allSubscriptions.concat(items);
            }

            nextPageToken = response.result.nextPageToken;
        } while (nextPageToken);

        console.log('Successfully fetched subscriptions:', allSubscriptions);

        // Extract the channel IDs, as we'll need these to fetch the videos later
        const channelIds = allSubscriptions.map(sub => sub.snippet.resourceId.channelId);

        // Now fetch the recent uploads for these channels
        await fetchUploadsForChannels(channelIds, isBackgroundRefresh);

    } catch (error) {
        handleApiError(error, 'Failed to fetch subscriptions.', isBackgroundRefresh);
    }
}

function handleApiError(error, userMessage, isBackgroundRefresh = false) {
    loadingOverlay.style.display = 'none'; // Hide spinner on any API error

    console.error(userMessage, error);
    const apiError = error.result?.error;

    // Check if the error is a 401 Unauthorized, indicating an expired token
    if (apiError && apiError.code === 401) {
        console.log("DEBUG: Token expired or invalid (401). Clearing session.");
        localStorage.removeItem('youtube_access_token');
        gapi.client.setToken(null); // Clear the bad token from the GAPI client
        updateAuthUI(); // Reset UI to logged-out state

        if (!isBackgroundRefresh) {
            uploads = []; // Clear data model
            renderCalendar(currentDate); // Re-render to clear view
            alert("Your session has expired. Please log in again.");
        }
    } else if (apiError && apiError.code === 403 && apiError.errors?.[0]?.reason === 'quotaExceeded') {
        console.log("DEBUG: YouTube API daily quota exceeded (403).");
        if (!isBackgroundRefresh) {
            alert("The application has exceeded its daily YouTube API usage limit. Some data may be missing. Please try again tomorrow.");
        }
    } else {
        if (!isBackgroundRefresh) {
            alert(`${userMessage} Please check the console for details.`);
        }
    }
}

/**
 * Parses an ISO 8601 duration string (e.g., "PT1M30S") into seconds.
 * @param {string} duration The ISO 8601 duration string.
 * @returns {number} The total duration in seconds.
 */
function parseISO8601Duration(duration) {
    const regex = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/;
    const matches = duration.match(regex);
    if (!matches) return 0;

    const hours = parseInt(matches[1] || 0, 10);
    const minutes = parseInt(matches[2] || 0, 10);
    const seconds = parseInt(matches[3] || 0, 10);

    return (hours * 3600) + (minutes * 60) + seconds;
}

async function fetchUploadsForChannels(channelIds, isBackgroundRefresh = false) {
    console.log(`DEBUG: Fetching activities for ${channelIds.length} channels.`);

    try {
        // Step 1: Fetch all recent activities for all channels
        const activityPromises = channelIds.map(id =>
            gapi.client.youtube.activities.list({
                part: 'snippet,contentDetails',
                channelId: id,
                maxResults: 15, // Get up to 15 recent items per channel
            })
        );
        const activityResults = await Promise.allSettled(activityPromises);
        const activityResponses = activityResults
            .filter(r => r.status === 'fulfilled')
            .map(r => r.value);

        // Step 2: Collect all video IDs from 'upload' activities and keep the original activity items
        const videoIds = [];
        const activities = [];
        activityResponses.forEach(response => {
            if (response.result.items) {
                response.result.items.forEach(item => {
                    activities.push(item);
                    if (item.snippet.type === 'upload' && item.contentDetails.upload) {
                        videoIds.push(item.contentDetails.upload.videoId);
                    }
                });
            }
        });

        // Step 3: Fetch detailed information for all collected video IDs in batches
        const videoDetailsMap = new Map();
        if (videoIds.length > 0) {
            console.log(`DEBUG: Fetching details for ${videoIds.length} videos.`);
            const videoDetailsPromises = [];
            for (let i = 0; i < videoIds.length; i += 50) { // API limit is 50 IDs per request
                const chunk = videoIds.slice(i, i + 50);
                videoDetailsPromises.push(
                    gapi.client.youtube.videos.list({
                        part: 'contentDetails,liveStreamingDetails',
                        id: chunk.join(','),
                    })
                );
            }
            const videoDetailResults = await Promise.allSettled(videoDetailsPromises);
            const videoDetailsResponses = videoDetailResults
                .filter(r => r.status === 'fulfilled')
                .map(r => r.value);
            videoDetailsResponses.forEach(response => {
                if (response.result.items) {
                    response.result.items.forEach(video => videoDetailsMap.set(video.id, video));
                }
            });
        }

        // Step 4: Process all activities with the detailed video info to categorize them accurately
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
        const isAndroid = /Android/.test(navigator.userAgent);

        const allUploads = activities.map(item => {
            const publishedDate = new Date(item.snippet.publishedAt);
            let itemType = null, itemId = null, itemUrl = null, itemTitle = escapeHTML(item.snippet.title), thumbnailUrl = item.snippet.thumbnails?.default?.url;

            if (item.snippet.type === 'upload' && item.contentDetails.upload) {
                itemId = item.contentDetails.upload.videoId;
                const videoDetails = videoDetailsMap.get(itemId);

                if (videoDetails) {
                    if (videoDetails.liveStreamingDetails && (videoDetails.liveStreamingDetails.actualStartTime || videoDetails.liveStreamingDetails.scheduledStartTime)) {
                        itemType = 'livestream';
                    } else {
                        const durationInSeconds = parseISO8601Duration(videoDetails.contentDetails.duration);
                        // Heuristic: The official definition of a Short includes a vertical aspect ratio, which the API doesn't provide.
                        // We use duration <= 61s as a strong and reliable proxy. It's safe to assume most videos this short are intended as Shorts.
                        itemType = (durationInSeconds > 0 && durationInSeconds <= 61) ? 'short' : 'video';
                    }
                } else {
                    itemType = 'video'; // Fallback if details are missing
                }

                if (itemType === 'short') {
                    if (isAndroid) {
                        itemUrl = `intent://shorts/${itemId}#Intent;scheme=vnd.youtube;package=com.google.android.youtube;S.browser_fallback_url=https%3A%2F%2Fwww.youtube.com%2Fshorts%2F${itemId};end;`;
                    } else if (isIOS) {
                        itemUrl = `youtube://shorts/${itemId}`;
                    } else {
                        itemUrl = `https://www.youtube.com/shorts/${itemId}`;
                    }
                } else {
                    if (isAndroid) {
                        itemUrl = `intent://watch?v=${itemId}#Intent;scheme=vnd.youtube;package=com.google.android.youtube;S.browser_fallback_url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3D${itemId};end;`;
                    } else if (isIOS) {
                        itemUrl = `youtube://watch?v=${itemId}`;
                    } else {
                        itemUrl = `https://www.youtube.com/watch?v=${itemId}`;
                    }
                }
            }
            else if (item.snippet.type === 'bulletin' && item.contentDetails.bulletin) {
                itemType = 'community';
                itemId = item.id;
                itemUrl = `https://www.youtube.com/channel/${item.snippet.channelId}/community?lb=${itemId}`;
                itemTitle = escapeHTML(item.snippet.title || item.snippet.description?.split('\n')[0] || 'Community Post');
            }

            if (!itemType) return null;

            return { id: itemId, url: itemUrl, title: itemTitle, channel: escapeHTML(item.snippet.channelTitle), date: publishedDate.getDate(), month: publishedDate.getMonth(), year: publishedDate.getFullYear(), type: itemType, thumbnail: thumbnailUrl, publishedAt: publishedDate };
        }).filter(Boolean);

        // Cache the newly fetched data
        const cacheData = {
            timestamp: new Date().getTime(),
            uploads: allUploads
        };
        localStorage.setItem('youtube_calendar_cache', JSON.stringify(cacheData));
        console.log("DEBUG: New data fetched and saved to cache.");

        uploads = allUploads;
        renderCalendar(currentDate);
        loadingOverlay.style.display = 'none'; // Hide spinner unconditionally
    } catch (error) {
        handleApiError(error, 'Failed to fetch video uploads.', isBackgroundRefresh);
    }
}

// Track which media types are currently active, checking local storage first
const defaultFilters = {
    video: true,
    short: true,
    community: true,
    livestream: true
};
let activeFilters;
try {
    const savedFilters = localStorage.getItem('calendarFilters');
    activeFilters = savedFilters ? JSON.parse(savedFilters) : defaultFilters;
} catch (e) {
    console.error("Could not parse calendarFilters from localStorage. Resetting.", e);
    activeFilters = defaultFilters;
}

function openDayModalForDate(targetDate) {
    const year = targetDate.getFullYear();
    const month = targetDate.getMonth();
    const date = targetDate.getDate();

    const searchQuery = searchInput.value.toLowerCase();
    const allUploadsForThisDay = uploads.filter(upload =>
        upload.year === year && upload.month === month && upload.date === date
    );
    const dayUploads = allUploadsForThisDay.filter(upload => {
        const matchesType = activeFilters[upload.type];
        const matchesSearch = upload.title.toLowerCase().includes(searchQuery) || upload.channel.toLowerCase().includes(searchQuery);
        return matchesType && matchesSearch;
    });

    dayUploads.sort((a, b) => a.publishedAt - b.publishedAt);

    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    const dateString = `${monthNames[month]} ${date}, ${year}`;

    currentlyViewedDate = targetDate;
    openDayModal(dateString, dayUploads, allUploadsForThisDay.length);
}

function openDayModal(dateString, uploads, totalUploadsForDay) {
    let contentHTML = `<div class="modal-header-row"><h3>Uploads for ${dateString}</h3>`;

    // Add "Mark All as Watched" button if there are unwatched uploads
    const unwatchedUploads = uploads.filter(u => !watchedIds.has(u.id));
    if (uploads.length > 0) {
        const allWatched = unwatchedUploads.length === 0;
        contentHTML += `<button class="mark-all-watched-btn${allWatched ? ' all-done' : ''}" id="mark-all-day-btn" ${allWatched ? 'disabled' : ''}>${allWatched ? '✓ All Watched' : '✓ Mark All as Watched'}</button>`;
    }
    contentHTML += `</div>`;

    if (uploads.length === 0) {
        contentHTML += totalUploadsForDay > 0 ? `<p>No content matches the current filters for this day.</p>` : `<p>No content uploaded on this day.</p>`;
    } else {
        const typeLabels = {
            'video': 'Videos',
            'livestream': 'Livestreams',
            'short': 'Shorts',
            'community': 'Community Posts'
        };
        const typeOrder = ['video', 'livestream', 'short', 'community'];

        contentHTML += `<div class="modal-upload-list">`;

        typeOrder.forEach(type => {
            const groupUploads = uploads.filter(upload => upload.type === type);
            if (groupUploads.length > 0) {
                // Sort each category chronologically
                groupUploads.sort((a, b) => a.publishedAt - b.publishedAt);

                const unwatchedInGroup = groupUploads.filter(u => !watchedIds.has(u.id));
                const groupAllWatched = unwatchedInGroup.length === 0;

                contentHTML += `<div class="category-header-row">`;
                contentHTML += `<h4 class="category-header" data-type="${type}"><span class="toggle-icon">▼</span> ${typeLabels[type]}</h4>`;
                contentHTML += `<button class="mark-category-watched-btn${groupAllWatched ? ' all-done' : ''}" data-type="${type}" ${groupAllWatched ? 'disabled' : ''}>${groupAllWatched ? '✓ Done' : '✓ All'}</button>`;
                contentHTML += `</div>`;
                contentHTML += `<div class="category-content" id="content-${type}">`;
                groupUploads.forEach(upload => {
                    const formattedTime = upload.publishedAt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
                    const isWatched = watchedIds.has(upload.id);
                    const watchedClass = isWatched ? 'watched' : '';
                    contentHTML += `
                        <a href="${upload.url}" target="_blank" rel="noopener noreferrer" class="modal-upload-item ${upload.type} ${watchedClass}" data-videoid="${upload.id}">
                            ${upload.thumbnail ? `<img src="${upload.thumbnail}" class="modal-thumbnail" alt="">` : ''}
                            <div class="modal-item-details">
                                <div><strong>${upload.channel}</strong></div>
                                <div>${upload.title}</div>
                                <div class="upload-time">${formattedTime}</div>
                            </div>
                        </a>
                    `;
                });
                contentHTML += `</div>`;
            }
        });
        contentHTML += `</div>`;
    }

    modalContent.innerHTML = contentHTML;
    document.body.classList.add('modal-open');

    // --- "Mark All as Watched" for the entire day ---
    const markAllDayBtn = document.getElementById('mark-all-day-btn');
    if (markAllDayBtn) {
        markAllDayBtn.addEventListener('click', () => {
            uploads.forEach(upload => markAsWatched(upload.id));
            // Visually update all items in the modal
            modalContent.querySelectorAll('.modal-upload-item').forEach(el => el.classList.add('watched'));
            // Update the button itself
            markAllDayBtn.textContent = '✓ All Watched';
            markAllDayBtn.disabled = true;
            markAllDayBtn.classList.add('all-done');
            // Update per-category buttons too
            modalContent.querySelectorAll('.mark-category-watched-btn').forEach(btn => {
                btn.textContent = '✓ Done';
                btn.disabled = true;
                btn.classList.add('all-done');
            });
            // Re-render calendar in background to reflect watched state
            renderCalendar(currentDate);
        });
    }

    // --- "✓ All" per category ---
    modalContent.querySelectorAll('.mark-category-watched-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            const type = btn.getAttribute('data-type');
            const categoryItems = modalContent.querySelectorAll(`#content-${type} .modal-upload-item`);
            categoryItems.forEach(el => {
                const videoId = el.getAttribute('data-videoid');
                markAsWatched(videoId);
                el.classList.add('watched');
            });
            btn.textContent = '✓ Done';
            btn.disabled = true;
            btn.classList.add('all-done');
            // Check if all categories are now fully watched
            const anyUnwatched = uploads.some(u => !watchedIds.has(u.id));
            if (!anyUnwatched && markAllDayBtn) {
                markAllDayBtn.textContent = '✓ All Watched';
                markAllDayBtn.disabled = true;
                markAllDayBtn.classList.add('all-done');
            }
            renderCalendar(currentDate);
        });
    });

    // Add click listeners to mark individual items as watched
    modalContent.querySelectorAll('.modal-upload-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const videoId = e.currentTarget.getAttribute('data-videoid');
            markAsWatched(videoId);
            e.currentTarget.classList.add('watched');
        });
    });

    // Add event listeners for collapsible category headers
    const headers = modalContent.querySelectorAll('.category-header');
    headers.forEach(header => {
        header.addEventListener('click', () => {
            const type = header.getAttribute('data-type');
            const content = modalContent.querySelector(`#content-${type}`);
            const icon = header.querySelector('.toggle-icon');

            content.classList.toggle('collapsed');
            icon.innerText = content.classList.contains('collapsed') ? '▶' : '▼';
        });
    });
}

function closeModal() {
    document.body.classList.remove('modal-open');
}

function renderCalendar(date) {
    // Clear the calendar body before rendering the new month
    calendarBody.innerHTML = '';

    const searchQuery = searchInput.value.toLowerCase();

    const year = date.getFullYear();
    const month = date.getMonth(); // 0-indexed (0 = January, 11 = December)

    // Update the UI to display the current month and year
    const monthNames = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    document.getElementById('month-year').innerText = `${monthNames[month]} ${year}`;

    // Get today's actual date to highlight the current day
    const actualToday = new Date();
    const isViewingCurrentMonth = actualToday.getFullYear() === year && actualToday.getMonth() === month;

    // Calculate the number of days in the current month (Passing 0 as the day gets the last day of the previous month)
    const daysInMonth = new Date(year, month + 1, 0).getDate();

    // Calculate the day of the week the 1st of the month falls on (0 = Sun, 1 = Mon, etc.)
    const startDayOfWeek = new Date(year, month, 1).getDay();

    // 1. Create empty slots for days belonging to the previous month
    for (let i = 0; i < startDayOfWeek; i++) {
        const emptyCell = document.createElement('div');
        calendarBody.appendChild(emptyCell);
    }

    // 2. Generate the actual days of the current month
    for (let i = 1; i <= daysInMonth; i++) {
        const dayCell = document.createElement('div');
        dayCell.classList.add('day');

        const dayLabel = document.createElement('div');
        dayLabel.classList.add('day-number');

        // Calculate the short weekday name (e.g., 'Mon', 'Tue')
        const currentDayDate = new Date(year, month, i);
        const weekdayName = currentDayDate.toLocaleDateString('en-US', { weekday: 'short' });

        dayLabel.innerHTML = `${i} <span class="mobile-weekday">${weekdayName}</span>`;
        dayCell.appendChild(dayLabel);

        // Highlight if this specific day cell is today
        if (isViewingCurrentMonth && i === actualToday.getDate()) {
            dayCell.classList.add('current-day');
        }

        // First, get all uploads for this day, before applying other filters
        const allUploadsForThisDay = uploads.filter(upload =>
            upload.year === year && upload.month === month && upload.date === i
        );

        // Now, apply the search and type filters to get the list to display
        const dayUploads = allUploadsForThisDay.filter(upload => {
            const matchesType = activeFilters[upload.type];
            const matchesSearch = upload.title.toLowerCase().includes(searchQuery) || upload.channel.toLowerCase().includes(searchQuery);
            return matchesType && matchesSearch;
        });

        // Sort all uploads for the day chronologically before displaying them
        dayUploads.sort((a, b) => a.publishedAt - b.publishedAt);

        // Make the entire day cell clickable to open the day view modal
        dayCell.addEventListener('click', () => {
            currentlyViewedDate = new Date(year, month, i);
            const dateString = `${monthNames[month]} ${i}, ${year}`;
            openDayModal(dateString, dayUploads, allUploadsForThisDay.length);
        });

        // Limit the number of visually rendered items to prevent layout issues
        const MAX_ITEMS = 3;
        const uploadsToShow = dayUploads.slice(0, MAX_ITEMS);

        uploadsToShow.forEach(upload => {
            const videoItem = document.createElement('a');
            const isWatched = watchedIds.has(upload.id);
            videoItem.classList.add('yt-item', upload.type);
            if (isWatched) {
                videoItem.classList.add('watched');
            }

            videoItem.href = upload.url;
            videoItem.target = '_blank';
            videoItem.rel = 'noopener noreferrer';
            videoItem.innerHTML = `
                ${upload.thumbnail ? `<img src="${upload.thumbnail}" class="yt-item-thumbnail" alt="">` : ''}
                <span class="yt-item-title">${upload.channel}: ${upload.title}</span>
            `;

            videoItem.addEventListener('click', (e) => {
                e.stopPropagation(); // IMPORTANT: This stops the click from also triggering the modal for the day cell
                markAsWatched(upload.id);
                videoItem.classList.add('watched');
            });

            dayCell.appendChild(videoItem);
        });

        // Add a '+X more' indicator if there are more uploads than the limit
        if (dayUploads.length > MAX_ITEMS) {
            const moreIndicator = document.createElement('div');
            moreIndicator.classList.add('more-indicator');
            moreIndicator.innerText = `+${dayUploads.length - MAX_ITEMS} more`;
            dayCell.appendChild(moreIndicator);
        }

        calendarBody.appendChild(dayCell);
    }

    // 3. Create empty slots at the end to complete the final week's row
    const totalCells = startDayOfWeek + daysInMonth;
    const emptyCellsAtEnd = totalCells % 7 === 0 ? 0 : 7 - (totalCells % 7);
    for (let i = 0; i < emptyCellsAtEnd; i++) {
        const emptyCell = document.createElement('div');
        calendarBody.appendChild(emptyCell);
    }
}

prevMonthBtn.addEventListener('click', () => {
    currentDate.setMonth(currentDate.getMonth() - 1);
    renderCalendar(currentDate);
});

nextMonthBtn.addEventListener('click', () => {
    currentDate.setMonth(currentDate.getMonth() + 1);
    renderCalendar(currentDate);
});

todayBtn.addEventListener('click', () => {
    currentDate = new Date();
    renderCalendar(currentDate);

    // On narrow screens (mobile view), automatically scroll down to the current day
    if (window.innerWidth <= 768) {
        // Use a tiny timeout to let the browser render the new calendar cells first
        setTimeout(() => {
            const todayCell = document.querySelector('.current-day');
            if (todayCell) {
                todayCell.scrollIntoView({ behavior: 'smooth', block: 'start' });
            }
        }, 50);
    }
});

forceRefreshBtn.addEventListener('click', () => {
    // Ensure user is signed in before allowing a refresh
    if (gapi.client.getToken() !== null) {
        console.log("DEBUG: Force refresh clicked. Clearing cache and fetching new data.");
        localStorage.removeItem('youtube_calendar_cache');
        fetchSubscriptions(false); // force spinner
    }
});



// Modal event listeners
modalCloseBtn.addEventListener('click', closeModal);
modalOverlay.addEventListener('click', closeModal);

prevDayBtn.addEventListener('click', () => {
    if (currentlyViewedDate) {
        const newDate = new Date(currentlyViewedDate);
        newDate.setDate(newDate.getDate() - 1);
        openDayModalForDate(newDate);
    }
});

nextDayBtn.addEventListener('click', () => {
    if (currentlyViewedDate) {
        const newDate = new Date(currentlyViewedDate);
        newDate.setDate(newDate.getDate() + 1);
        openDayModalForDate(newDate);
    }
});

window.addEventListener('keydown', (e) => {
    // Close modal on 'Escape' key press
    if (e.key === 'Escape' && document.body.classList.contains('modal-open')) {
        closeModal();
    }
    // Navigate months with arrow keys (only when modal is closed and no input is focused)
    if (!document.body.classList.contains('modal-open') && document.activeElement?.tagName !== 'INPUT') {
        if (e.key === 'ArrowLeft') {
            currentDate.setMonth(currentDate.getMonth() - 1);
            renderCalendar(currentDate);
        } else if (e.key === 'ArrowRight') {
            currentDate.setMonth(currentDate.getMonth() + 1);
            renderCalendar(currentDate);
        }
    } else if (document.body.classList.contains('modal-open') && document.activeElement?.tagName !== 'INPUT') {
        // Navigate days with arrow keys when modal is open
        if (e.key === 'ArrowLeft' && currentlyViewedDate) {
            const newDate = new Date(currentlyViewedDate);
            newDate.setDate(newDate.getDate() - 1);
            openDayModalForDate(newDate);
        } else if (e.key === 'ArrowRight' && currentlyViewedDate) {
            const newDate = new Date(currentlyViewedDate);
            newDate.setDate(newDate.getDate() + 1);
            openDayModalForDate(newDate);
        }
    }
});

// Setup click listeners and initial visual state for media type filtering
document.querySelectorAll('.legend-item').forEach(item => {
    const type = item.getAttribute('data-type');

    // Set initial visual state based on loaded filters
    if (type && !activeFilters[type]) {
        item.classList.add('inactive');
    }

    item.addEventListener('click', () => {
        if (type) {
            activeFilters[type] = !activeFilters[type];
            item.classList.toggle('inactive');
            localStorage.setItem('calendarFilters', JSON.stringify(activeFilters));
            renderCalendar(currentDate);
        }
    });
});

// Re-render calendar when user types in the search bar (debounced to prevent jank)
let searchDebounceTimer;
searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
        renderCalendar(currentDate);
    }, 300);
});

// Initial render
renderCalendar(currentDate);
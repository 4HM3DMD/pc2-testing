/**
 * UIUpdateModal - Update notification toast and modal
 * 
 * Provides macOS-style update experience:
 * - Toast notification when update is available
 * - Modal with version info and install button
 * - Progress UI during update installation
 * - Auto-reconnect after server restart
 */

let updateModalInstance = null;
let updateToastInstance = null;

/**
 * Check for updates from the server
 */
async function checkForUpdates() {
    try {
        // Only check in PC2 mode
        if (!window.pc2_config?.pc2_mode) {
            return null;
        }

        const response = await fetch('/api/update/status', {
            headers: {
                'Authorization': `Bearer ${puter.authToken}`
            }
        });

        if (!response.ok) {
            console.log('[Update] Failed to check for updates:', response.status);
            return null;
        }

        const data = await response.json();
        window.latestVersionInfo = data;
        
        // Set global flag for dropdown menu
        window.pc2UpdateAvailable = data.updateAvailable || false;

        if (data.updateAvailable) {
            const lastDismissed = localStorage.getItem('updateDismissed');
            if (lastDismissed !== data.latestVersion) {
                showUpdateToast(data);
            }
        }

        return data;
    } catch (error) {
        console.log('[Update] Check failed:', error);
        return null;
    }
}

/**
 * Show update toast notification
 */
function showUpdateToast(versionInfo) {
    // Remove existing toast if any
    if (updateToastInstance) {
        $(updateToastInstance).remove();
    }

    const toastHtml = `
        <div class="update-toast" style="
            position: fixed;
            bottom: 80px;
            right: 20px;
            background: linear-gradient(135deg, #4a90d9 0%, #357abd 100%);
            color: white;
            padding: 16px 20px;
            border-radius: 12px;
            box-shadow: 0 4px 20px rgba(0, 0, 0, 0.25);
            z-index: 999999;
            display: flex;
            align-items: center;
            gap: 16px;
            max-width: 380px;
            animation: slideInRight 0.3s ease-out;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        ">
            <div style="flex-shrink: 0;">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                    <polyline points="7 10 12 15 17 10"/>
                    <line x1="12" y1="15" x2="12" y2="3"/>
                </svg>
            </div>
            <div style="flex: 1;">
                <div style="font-weight: 600; font-size: 14px; margin-bottom: 4px;">
                    Update Available
                </div>
                <div style="font-size: 12px; opacity: 0.9;">
                    Version ${window.html_encode(versionInfo.latestVersion || 'New')} is ready to install
                </div>
            </div>
            <div style="display: flex; gap: 8px; flex-shrink: 0;">
                <button class="update-toast-later" style="
                    background: rgba(255, 255, 255, 0.2);
                    border: none;
                    color: white;
                    padding: 8px 12px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 500;
                ">Later</button>
                <button class="update-toast-install" style="
                    background: white;
                    border: none;
                    color: #357abd;
                    padding: 8px 16px;
                    border-radius: 6px;
                    cursor: pointer;
                    font-size: 12px;
                    font-weight: 600;
                ">Update Now</button>
            </div>
        </div>
        <style>
            @keyframes slideInRight {
                from {
                    transform: translateX(100%);
                    opacity: 0;
                }
                to {
                    transform: translateX(0);
                    opacity: 1;
                }
            }
            .update-toast-later:hover {
                background: rgba(255, 255, 255, 0.3) !important;
            }
            .update-toast-install:hover {
                background: #f0f0f0 !important;
            }
        </style>
    `;

    const $toast = $(toastHtml);
    $('body').append($toast);
    updateToastInstance = $toast[0];

    // Later button - dismiss and remember
    $toast.find('.update-toast-later').on('click', function() {
        localStorage.setItem('updateDismissed', versionInfo.latestVersion);
        $toast.fadeOut(200, function() { $(this).remove(); });
        updateToastInstance = null;
    });

    // Update Now button - show modal
    $toast.find('.update-toast-install').on('click', function() {
        $toast.fadeOut(200, function() { $(this).remove(); });
        updateToastInstance = null;
        showUpdateModal(versionInfo);
    });
}

/**
 * Show update modal with version info and install button
 */
function showUpdateModal(versionInfo) {
    // Remove existing modal if any
    if (updateModalInstance) {
        $(updateModalInstance).remove();
    }

    const releaseNotes = versionInfo.releaseNotes 
        ? window.html_encode(versionInfo.releaseNotes).substring(0, 500) 
        : 'Bug fixes and performance improvements.';

    const modalHtml = `
        <div class="update-modal-overlay" style="
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 999998;
            display: flex;
            align-items: center;
            justify-content: center;
            animation: fadeIn 0.2s ease-out;
        ">
            <div class="update-modal" style="
                background: white;
                border-radius: 16px;
                box-shadow: 0 10px 40px rgba(0, 0, 0, 0.3);
                width: 420px;
                max-width: 90vw;
                overflow: hidden;
                animation: scaleIn 0.2s ease-out;
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            ">
                <div style="padding: 24px; text-align: center;">
                    <div style="
                        width: 64px;
                        height: 64px;
                        background: linear-gradient(135deg, #4a90d9 0%, #357abd 100%);
                        border-radius: 16px;
                        display: flex;
                        align-items: center;
                        justify-content: center;
                        margin: 0 auto 16px;
                    ">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                            <polyline points="7 10 12 15 17 10"/>
                            <line x1="12" y1="15" x2="12" y2="3"/>
                        </svg>
                    </div>
                    <h2 style="margin: 0 0 8px; font-size: 20px; color: #333;">Update Available</h2>
                    <p style="margin: 0 0 16px; color: #666; font-size: 14px;">
                        A new version of PC2 is ready to install
                    </p>
                    
                    <div style="
                        background: #f5f5f5;
                        border-radius: 8px;
                        padding: 12px;
                        margin-bottom: 16px;
                        text-align: left;
                    ">
                        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
                            <span style="color: #666; font-size: 13px;">Current Version</span>
                            <span style="font-weight: 600; color: #333; font-size: 13px;">${window.html_encode(versionInfo.currentVersion || '1.0.0')}</span>
                        </div>
                        <div style="display: flex; justify-content: space-between;">
                            <span style="color: #666; font-size: 13px;">New Version</span>
                            <span style="font-weight: 600; color: #4a90d9; font-size: 13px;">${window.html_encode(versionInfo.latestVersion || 'Latest')}</span>
                        </div>
                    </div>
                    
                    <div class="update-modal-notes" style="
                        text-align: left;
                        font-size: 12px;
                        color: #666;
                        max-height: 100px;
                        overflow-y: auto;
                        margin-bottom: 16px;
                        padding: 8px;
                        background: #fafafa;
                        border-radius: 6px;
                        white-space: pre-wrap;
                    ">${releaseNotes}</div>
                    
                    <div class="update-progress" style="display: none; margin-bottom: 16px; text-align: left;">
                        <div class="update-progress-bar-track" style="
                            width: 100%;
                            height: 6px;
                            background: #e5e7eb;
                            border-radius: 3px;
                            overflow: hidden;
                            margin-bottom: 14px;
                        ">
                            <div class="update-progress-bar-fill" style="
                                height: 100%;
                                width: 0%;
                                background: linear-gradient(90deg, #4a90d9 0%, #357abd 100%);
                                border-radius: 3px;
                                transition: width 0.6s cubic-bezier(0.4, 0, 0.2, 1);
                            "></div>
                        </div>

                        <div class="update-progress-text" style="
                            font-size: 14px;
                            color: #111827;
                            font-weight: 500;
                            margin-bottom: 4px;
                            min-height: 20px;
                        ">Starting update&hellip;</div>

                        <div class="update-progress-elapsed" style="
                            font-size: 11px;
                            color: #9ca3af;
                            margin-bottom: 14px;
                            font-variant-numeric: tabular-nums;
                        ">Elapsed: 0s</div>

                        <div class="update-step-list" style="
                            background: #f9fafb;
                            border: 1px solid #f3f4f6;
                            border-radius: 8px;
                            padding: 10px 14px;
                            margin-bottom: 14px;
                        ">
                            <div class="update-step-item" data-step="fetch" style="display: flex; align-items: center; gap: 10px; padding: 5px 0; opacity: 0.4; font-size: 13px; color: #4b5563; transition: opacity 0.3s ease;">
                                <span class="update-step-icon" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: #9ca3af;">&#9675;</span>
                                <span class="update-step-label">Downloading update</span>
                            </div>
                            <div class="update-step-item" data-step="install-root" style="display: flex; align-items: center; gap: 10px; padding: 5px 0; opacity: 0.4; font-size: 13px; color: #4b5563; transition: opacity 0.3s ease;">
                                <span class="update-step-icon" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: #9ca3af;">&#9675;</span>
                                <span class="update-step-label">Installing dependencies</span>
                            </div>
                            <div class="update-step-item" data-step="install-node" style="display: flex; align-items: center; gap: 10px; padding: 5px 0; opacity: 0.4; font-size: 13px; color: #4b5563; transition: opacity 0.3s ease;">
                                <span class="update-step-icon" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: #9ca3af;">&#9675;</span>
                                <span class="update-step-label">Installing PC2 components</span>
                            </div>
                            <div class="update-step-item" data-step="build" style="display: flex; align-items: center; gap: 10px; padding: 5px 0; opacity: 0.4; font-size: 13px; color: #4b5563; transition: opacity 0.3s ease;">
                                <span class="update-step-icon" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: #9ca3af;">&#9675;</span>
                                <span class="update-step-label">Building application</span>
                            </div>
                            <div class="update-step-item" data-step="restart" style="display: flex; align-items: center; gap: 10px; padding: 5px 0; opacity: 0.4; font-size: 13px; color: #4b5563; transition: opacity 0.3s ease;">
                                <span class="update-step-icon" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: #9ca3af;">&#9675;</span>
                                <span class="update-step-label">Restarting server</span>
                            </div>
                            <div class="update-step-item" data-step="reconnect" style="display: flex; align-items: center; gap: 10px; padding: 5px 0; opacity: 0.4; font-size: 13px; color: #4b5563; transition: opacity 0.3s ease;">
                                <span class="update-step-icon" style="width: 16px; height: 16px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; font-size: 12px; color: #9ca3af;">&#9675;</span>
                                <span class="update-step-label">Reconnecting</span>
                            </div>
                        </div>

                        <div class="update-log-section" style="margin-bottom: 12px;">
                            <button class="update-log-toggle" type="button" style="
                                display: flex;
                                align-items: center;
                                gap: 8px;
                                width: 100%;
                                background: transparent;
                                border: none;
                                padding: 6px 0;
                                cursor: pointer;
                                font-size: 11px;
                                color: #6b7280;
                                font-family: inherit;
                                font-weight: 500;
                                text-align: left;
                            ">
                                <span class="update-log-toggle-icon" style="
                                    display: inline-block;
                                    transition: transform 0.15s ease;
                                    font-size: 10px;
                                ">&#9654;</span>
                                <span class="update-log-toggle-label">View detailed logs</span>
                                <span class="update-log-line-count" style="
                                    margin-left: auto;
                                    font-variant-numeric: tabular-nums;
                                    color: #9ca3af;
                                    font-size: 10px;
                                ">0 lines</span>
                            </button>
                            <div class="update-log-panel" style="
                                display: none;
                                margin-top: 6px;
                                background: #0f172a;
                                border: 1px solid #1e293b;
                                border-radius: 6px;
                                padding: 8px 10px;
                                max-height: 220px;
                                overflow-y: auto;
                                font-family: 'SF Mono', Monaco, Menlo, Consolas, monospace;
                                font-size: 10.5px;
                                line-height: 1.45;
                                color: #cbd5e1;
                                white-space: pre-wrap;
                                word-break: break-all;
                            "><div class="update-log-content"><span style="color: #64748b;">Waiting for update output&hellip;</span></div></div>
                        </div>

                        <div class="update-progress-hint" style="
                            font-size: 11px;
                            color: #6b7280;
                            text-align: center;
                            line-height: 1.5;
                        ">Please keep this window open until the update completes.<br>Native dependency compilation can take 10-20 minutes on ARM devices.</div>
                    </div>
                </div>
                
                <div class="update-modal-actions" style="
                    padding: 16px 24px;
                    background: #f5f5f5;
                    display: flex;
                    justify-content: flex-end;
                    gap: 12px;
                ">
                    <button class="update-modal-cancel" style="
                        background: white;
                        border: 1px solid #ddd;
                        color: #666;
                        padding: 10px 20px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 500;
                    ">Later</button>
                    <button class="update-modal-install" style="
                        background: linear-gradient(135deg, #4a90d9 0%, #357abd 100%);
                        border: none;
                        color: white;
                        padding: 10px 24px;
                        border-radius: 8px;
                        cursor: pointer;
                        font-size: 14px;
                        font-weight: 600;
                    ">Install Update</button>
                </div>
            </div>
        </div>
        <style>
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            @keyframes scaleIn {
                from { transform: scale(0.9); opacity: 0; }
                to { transform: scale(1); opacity: 1; }
            }
            @keyframes spin {
                to { transform: rotate(360deg); }
            }
            .update-modal-cancel:hover {
                background: #f5f5f5 !important;
            }
            .update-modal-install:hover {
                opacity: 0.9;
            }
            .update-modal-install:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            .update-step-item.active {
                opacity: 1 !important;
                color: #111827 !important;
                font-weight: 500;
            }
            .update-step-item.complete {
                opacity: 0.6 !important;
            }
            .update-step-item.complete .update-step-icon {
                color: #16a34a !important;
                font-size: 14px !important;
            }
            .update-step-item.active .update-step-icon {
                color: #4a90d9 !important;
            }
            .update-step-item .update-step-spinner {
                width: 12px;
                height: 12px;
                border: 2px solid #e5e7eb;
                border-top-color: #4a90d9;
                border-radius: 50%;
                animation: spin 0.8s linear infinite;
            }
        </style>
    `;

    const $modal = $(modalHtml);
    $('body').append($modal);
    updateModalInstance = $modal[0];

    // Track update-in-flight so we can block dismissal mid-update
    let updateInFlight = false;

    // Cancel button — blocked while update is running
    $modal.find('.update-modal-cancel').on('click', function() {
        if (updateInFlight) { return; }
        localStorage.setItem('updateDismissed', versionInfo.latestVersion);
        $modal.fadeOut(200, function() { $(this).remove(); });
        updateModalInstance = null;
    });

    // Click overlay to close — blocked while update is running
    $modal.find('.update-modal-overlay').on('click', function(e) {
        if (e.target !== this) { return; }
        if (updateInFlight) { return; }
        localStorage.setItem('updateDismissed', versionInfo.latestVersion);
        $modal.fadeOut(200, function() { $(this).remove(); });
        updateModalInstance = null;
    });

    // Live-log dropdown — toggles the dark terminal-style log panel.
    // Tracks "user-scrolled-up" so auto-scroll only kicks in when the user
    // is sitting at the bottom (Apple-style sticky-bottom behaviour).
    const $logToggle = $modal.find('.update-log-toggle');
    const $logIcon = $modal.find('.update-log-toggle-icon');
    const $logLabel = $modal.find('.update-log-toggle-label');
    const $logPanel = $modal.find('.update-log-panel');
    let logExpanded = false;
    $logToggle.on('click', function() {
        logExpanded = !logExpanded;
        if (logExpanded) {
            $logPanel.show();
            $logIcon.css('transform', 'rotate(90deg)');
            $logLabel.text('Hide detailed logs');
            // Snap to bottom on open so user sees the latest line.
            const panelEl = $logPanel[0];
            if (panelEl) panelEl.scrollTop = panelEl.scrollHeight;
        } else {
            $logPanel.hide();
            $logIcon.css('transform', 'rotate(0deg)');
            $logLabel.text('View detailed logs');
        }
    });

    // Install button
    $modal.find('.update-modal-install').on('click', async function() {
        const $btn = $(this);
        const $cancel = $modal.find('.update-modal-cancel');
        const $progress = $modal.find('.update-progress');
        const $progressText = $modal.find('.update-progress-text');
        const $progressBar = $modal.find('.update-progress-bar-fill');
        const $progressElapsed = $modal.find('.update-progress-elapsed');
        const $stepList = $modal.find('.update-step-list');
        const $progressHint = $modal.find('.update-progress-hint');
        const $logContent = $modal.find('.update-log-content');
        const $logLineCount = $modal.find('.update-log-line-count');
        const $notes = $modal.find('.update-modal-notes');

        $btn.prop('disabled', true).text('Updating\u2026');
        $cancel.prop('disabled', true).css({ opacity: 0.4, cursor: 'not-allowed' });
        $notes.hide();
        $progress.show();
        updateInFlight = true;

        try {
            const response = await fetch('/api/update/install', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${puter.authToken}`,
                    'Content-Type': 'application/json'
                }
            });

            const result = await response.json();

            if (!result.success) {
                throw new Error(result.error || 'Update failed to start');
            }

            await waitForRestart({
                $progressText,
                $progressBar,
                $progressElapsed,
                $stepList,
                $progressHint,
                $logContent,
                $logLineCount,
                $logPanel,
            });
        } catch (error) {
            console.error('[Update] Installation failed:', error);
            $progressText.html(`<span style="color: #d9534f; font-weight: 600;">Update failed</span><br><span style="font-size: 12px; color: #6b7280;">${window.html_encode(error.message)}</span>`);
            $progressHint.hide();
            $btn.prop('disabled', false).text('Retry');
            $cancel.prop('disabled', false).css({ opacity: 1, cursor: 'pointer' });
            updateInFlight = false;
        }
    });
}

/**
 * Step definitions for the update progress UI.
 *
 * Each step has:
 *   - id:       matches the data-step attribute on the step list DOM
 *   - match:    regex applied to the backend's progress string to detect this step
 *               (UpdateService.performUpdate sets this.updateProgress at every stage)
 *   - label:    user-facing label rendered in the status text
 *   - weight:   relative share of the total progress bar (sum across all steps = 100)
 *   - estMs:    rough expected duration on Jetson, used for smooth intra-step
 *               progress bar interpolation when the backend stays on the same step
 *               for a while (e.g. 90s of npm install)
 */
const UPDATE_STEPS = [
    { id: 'fetch',        match: /^(starting|fetching|resetting)/i,        label: 'Downloading update',        weight: 8,  estMs:  10000 },
    { id: 'install-root', match: /installing root dependencies/i,           label: 'Installing dependencies',   weight: 35, estMs:  90000 },
    { id: 'install-node', match: /installing pc2-node dependencies/i,       label: 'Installing PC2 components', weight: 20, estMs:  60000 },
    { id: 'build',        match: /building application/i,                   label: 'Building application',      weight: 22, estMs:  60000 },
    { id: 'restart',      match: /restarting server/i,                      label: 'Restarting server',         weight: 10, estMs:  10000 },
    { id: 'reconnect',    match: null,                                      label: 'Reconnecting',              weight:  5, estMs:  15000 },
];

const UPDATE_TOTAL_WEIGHT = UPDATE_STEPS.reduce((sum, s) => sum + s.weight, 0);
// 20 minutes covers a Jetson cold install (native compiles of better-sqlite3,
// node-pty, sharp can total 10-15 min) plus build + restart overhead. Hitting
// this threshold doesn't claim failure — it surfaces helpful next steps.
const UPDATE_HARD_TIMEOUT_MS = 20 * 60 * 1000;
const UPDATE_POLL_INTERVAL_MS = 1500;
// Max log lines kept in DOM. Mirrors the backend rolling buffer so we don't
// degrade the modal's perf on a long Jetson update.
const UPDATE_LOG_MAX_LINES = 400;

/** Format milliseconds as e.g. "1m 23s" or "47s". */
function formatElapsed(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const m = Math.floor(total / 60);
    const s = total % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

/**
 * Wait for the update to complete by polling /api/update/progress.
 *
 * Replaces the previous fake-progress-message implementation that
 * cycled hardcoded strings on a setInterval and gave up after 65 s.
 * That UX was both dishonest (text didn't reflect actual state) and
 * actively misleading (false "taking longer than expected" warning
 * fired during normal Jetson updates because the install step alone
 * takes 3-5 minutes).
 *
 * This implementation:
 *   - Polls the real backend progress every 1.5 s
 *   - Maps backend message → step id → updates step list (checkmarks)
 *   - Smoothly interpolates the progress bar within long-running steps
 *     based on elapsed time vs estimated step duration
 *   - Detects server-going-down (consecutive poll failures while on a
 *     late step) and switches to /api/health probing for restart detect
 *   - Hard timeout is 12 minutes (well beyond worst-case Jetson update),
 *     and even then doesn't claim failure — gives helpful next steps
 */
async function waitForRestart(refs) {
    const { $progressText, $progressBar, $progressElapsed, $stepList, $progressHint, $logContent, $logLineCount, $logPanel } = refs;

    let currentStepId = null;
    let stepStartedAt = Date.now();
    let serverWentDown = false;
    let consecutiveFailures = 0;
    let lastProgressString = '';
    let lastLogSeq = 0;
    let renderedLineCount = 0;
    let logHasContent = false;

    const startedAt = Date.now();

    // Returns whether the log panel is currently scrolled to the bottom
    // (within 32px tolerance). Used to decide if we should auto-scroll
    // after appending new lines.
    function isLogStuckToBottom() {
        const el = $logPanel && $logPanel[0];
        if (!el) return true;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) < 32;
    }

    function appendLogLines(lines) {
        if (!Array.isArray(lines) || lines.length === 0 || !$logContent) return;
        const wasStuck = isLogStuckToBottom();
        // Clear the placeholder on first real output.
        if (!logHasContent) {
            $logContent.empty();
            logHasContent = true;
        }
        const fragments = [];
        for (const raw of lines) {
            // Lines arrive as "[HH:MM:SS] [source] message" — colour-code the
            // tag prefix so users can tell git/npm/build apart at a glance.
            const m = String(raw).match(/^(\[\d{2}:\d{2}:\d{2}\])\s+(\[[^\]]+\])\s+(.*)$/);
            let html;
            if (m) {
                html = `<span style="color:#64748b;">${window.html_encode(m[1])}</span> ` +
                       `<span style="color:#7dd3fc;">${window.html_encode(m[2])}</span> ` +
                       `<span>${window.html_encode(m[3])}</span>`;
            } else {
                html = `<span>${window.html_encode(String(raw))}</span>`;
            }
            fragments.push(`<div>${html}</div>`);
        }
        $logContent.append(fragments.join(''));
        renderedLineCount += lines.length;

        // Cap the rendered line count so a long Jetson update doesn't blow
        // up DOM memory. Drop oldest divs.
        if (renderedLineCount > UPDATE_LOG_MAX_LINES) {
            const drop = renderedLineCount - UPDATE_LOG_MAX_LINES;
            $logContent.children().slice(0, drop).remove();
            renderedLineCount = UPDATE_LOG_MAX_LINES;
        }

        if ($logLineCount) {
            $logLineCount.text(renderedLineCount === 1 ? '1 line' : renderedLineCount + ' lines');
        }
        if (wasStuck) {
            const el = $logPanel && $logPanel[0];
            if (el) el.scrollTop = el.scrollHeight;
        }
    }

    const tickElapsed = setInterval(() => {
        $progressElapsed.text('Elapsed: ' + formatElapsed(Date.now() - startedAt));
    }, 1000);

    function updateBar() {
        let cumulativeWeight = 0;
        let stepWeight = 0;
        let stepEstMs = 60000;
        for (const step of UPDATE_STEPS) {
            if (step.id === currentStepId) {
                stepWeight = step.weight;
                stepEstMs = step.estMs;
                break;
            }
            cumulativeWeight += step.weight;
        }
        // Time-based interpolation within the active step. Cap at 0.92 so the
        // bar never quite fills until the step actually completes — prevents
        // the "stuck at 99%" frustration if our estimate underruns.
        const intra = currentStepId
            ? Math.min(0.92, (Date.now() - stepStartedAt) / stepEstMs)
            : 0;
        const pct = ((cumulativeWeight + stepWeight * intra) / UPDATE_TOTAL_WEIGHT) * 100;
        $progressBar.css('width', pct.toFixed(1) + '%');
    }

    function setStep(newStepId) {
        if (newStepId === currentStepId) { return; }
        // Mark the previous step complete (checkmark)
        if (currentStepId) {
            const $prev = $stepList.find(`[data-step="${currentStepId}"]`);
            $prev.removeClass('active').addClass('complete');
            $prev.find('.update-step-icon').html('&#10003;');
        }
        currentStepId = newStepId;
        stepStartedAt = Date.now();
        const step = UPDATE_STEPS.find(s => s.id === newStepId);
        if (step) {
            const $cur = $stepList.find(`[data-step="${newStepId}"]`);
            $cur.addClass('active');
            $cur.find('.update-step-icon').html('<div class="update-step-spinner"></div>');
            $progressText.text(step.label + '\u2026');
        }
        updateBar();
    }

    function detectStep(msg) {
        if (!msg) { return null; }
        for (const step of UPDATE_STEPS) {
            if (step.match && step.match.test(msg)) { return step.id; }
        }
        return null;
    }

    // Smooth bar tick — keeps the bar inching forward visually even when the
    // backend stays on the same step for 90 s (npm install). Without this,
    // long steps would feel frozen.
    const tickBar = setInterval(updateBar, 500);

    try {
        while (Date.now() - startedAt < UPDATE_HARD_TIMEOUT_MS) {
            // 1) If we've previously detected the server going down, prioritize
            //    health checking — that's how we know restart finished.
            if (serverWentDown) {
                try {
                    const h = await fetch('/api/health', { signal: AbortSignal.timeout(1500) });
                    if (h.ok) {
                        if (currentStepId !== 'reconnect') { setStep('reconnect'); }
                        // Mark reconnect complete and finish
                        const $rec = $stepList.find('[data-step="reconnect"]');
                        $rec.removeClass('active').addClass('complete');
                        $rec.find('.update-step-icon').html('&#10003;');
                        $progressBar.css('width', '100%');
                        $progressText.html('<span style="color: #16a34a; font-weight: 600;">Update complete</span><br><span style="font-size: 12px; color: #6b7280;">Reloading\u2026</span>');
                        $progressHint.hide();
                        localStorage.removeItem('updateDismissed');
                        setTimeout(() => window.location.reload(), 1800);
                        return;
                    }
                } catch {
                    // server still down, keep waiting
                }
            }

            // 2) Always try to read backend progress (will fail during restart window).
            //    sinceSeq lets the backend send only new log lines, keeping the
            //    poll payload tiny even when hundreds of lines have streamed.
            try {
                const r = await fetch('/api/update/progress?sinceSeq=' + encodeURIComponent(lastLogSeq), {
                    headers: { 'Authorization': `Bearer ${puter.authToken}` },
                    signal: AbortSignal.timeout(2500),
                });
                if (r.ok) {
                    consecutiveFailures = 0;
                    const data = await r.json();
                    if (data.progress && data.progress !== lastProgressString) {
                        lastProgressString = data.progress;
                        const detected = detectStep(data.progress);
                        if (detected) { setStep(detected); }
                    }
                    // Append any new log lines into the live dropdown.
                    if (Array.isArray(data.log) && data.log.length > 0) {
                        appendLogLines(data.log);
                    }
                    if (typeof data.logSeq === 'number') {
                        lastLogSeq = data.logSeq;
                    }
                    // Backend reports update finished but server didn't go down yet —
                    // the restart command was issued, server is about to disappear.
                    // Switch into health-check mode.
                    if (data.isUpdating === false && currentStepId === 'restart') {
                        serverWentDown = true;
                    }
                }
            } catch {
                consecutiveFailures++;
                // 2 consecutive failures while on a late step = server is restarting.
                // Switch into health-check mode so we detect the comeback.
                if (consecutiveFailures >= 2 && (currentStepId === 'restart' || currentStepId === 'build')) {
                    if (!serverWentDown) {
                        serverWentDown = true;
                        if (currentStepId !== 'restart') { setStep('restart'); }
                    }
                }
            }

            await new Promise(res => setTimeout(res, UPDATE_POLL_INTERVAL_MS));
        }

        // Hard timeout reached — don't claim failure (update may still be running),
        // give the user actionable next steps instead.
        $progressText.html('<span style="color: #f0ad4e; font-weight: 600;">Update is taking longer than expected</span>');
        $progressHint.html(
            'The update may still be running in the background.<br>' +
            'Expand <strong>View detailed logs</strong> above to see live output, ' +
            'or check the server logs:<br>' +
            '<code style="display: inline-block; margin-top: 6px; padding: 2px 6px; background: #f3f4f6; border-radius: 4px; font-size: 11px;">pm2 logs pc2 --lines 50</code>'
        );
    } finally {
        clearInterval(tickElapsed);
        clearInterval(tickBar);
    }
}

/**
 * Show restart confirmation dialog
 */
async function showRestartConfirmation() {
    // Remove any existing dialog
    $('#restart-confirm-overlay').remove();
    
    const apiOrigin = window.api_origin || window.location.origin;
    
    // Check restart mode first
    let restartMode = { autoRestart: true, processManager: 'unknown', restartCommand: 'npm start' };
    try {
        const modeResponse = await fetch(`${apiOrigin}/api/system/restart-mode`, {
            headers: { 'Authorization': `Bearer ${puter.authToken}` }
        });
        if (modeResponse.ok) {
            const modeData = await modeResponse.json();
            restartMode = modeData.result || restartMode;
        }
    } catch (e) {
        console.log('[System] Could not check restart mode:', e);
    }
    
    const warningText = restartMode.autoRestart
        ? 'All active sessions will be temporarily disconnected.'
        : 'Running in local mode. The server will shut down and you will need to restart it manually.';
    
    const $overlay = $(`
        <div id="restart-confirm-overlay" style="
            position: fixed;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: rgba(0, 0, 0, 0.5);
            z-index: 999999;
            display: flex;
            align-items: center;
            justify-content: center;
        ">
            <div style="
                background: white;
                border-radius: 8px;
                padding: 20px;
                min-width: 300px;
                max-width: 450px;
                box-shadow: 0 4px 20px rgba(0,0,0,0.3);
            ">
                <h3 style="margin: 0 0 12px; font-size: 16px; color: #333;">
                    ${restartMode.autoRestart ? 'Restart PC2' : 'Shut Down PC2'}
                </h3>
                <p style="margin: 0 0 20px; color: #666; font-size: 14px;">
                    Are you sure you want to ${restartMode.autoRestart ? 'restart' : 'shut down'} PC2?<br>
                    <span style="font-size: 12px; color: ${restartMode.autoRestart ? '#999' : '#dc2626'};">${warningText}</span>
                </p>
                <div style="display: flex; gap: 10px; justify-content: flex-end;">
                    <button id="restart-cancel" class="button" style="height: 32px; line-height: 32px; padding: 0 16px; border-radius: 4px;">Cancel</button>
                    <button id="restart-confirm" class="button" style="height: 32px; line-height: 32px; padding: 0 16px; border-radius: 4px; background: #dc2626; color: white; border: none;">
                        ${restartMode.autoRestart ? 'Restart' : 'Shut Down'}
                    </button>
                </div>
            </div>
        </div>
    `);
    
    // Store restart command for later use
    $overlay.data('restartCommand', restartMode.restartCommand);
    
    $('body').append($overlay);
    
    $overlay.find('#restart-cancel').on('click', function() {
        $overlay.remove();
    });
    
    $overlay.find('#restart-confirm').on('click', async function() {
        const $btn = $(this);
        $btn.prop('disabled', true).text(restartMode.autoRestart ? 'Restarting...' : 'Shutting down...');
        
        try {
            const response = await fetch(`${apiOrigin}/api/system/restart`, {
                method: 'POST',
                headers: { 
                    'Authorization': `Bearer ${puter.authToken}`,
                    'Content-Type': 'application/json'
                }
            });
            
            if (response.ok) {
                const data = await response.json();
                
                if (data.autoRestart) {
                    // Server will auto-restart
                    $overlay.find('p').html('<span style="color: #16a34a;">Restart initiated. Please wait...</span><br><span style="font-size: 12px; color: #999;">The page will reload automatically.</span>');
                    $overlay.find('#restart-cancel').hide();
                    $btn.hide();
                    
                    // Wait and reload
                    setTimeout(() => {
                        window.location.reload();
                    }, 5000);
                } else {
                    // Local mode - server won't auto-restart
                    const restartCmd = $overlay.data('restartCommand') || 'cd ~/pc2.net/pc2-node && npm start';
                    const escapedCmd = window.html_encode(restartCmd);
                    
                    $overlay.find('p').html(`
                        <span style="color: #16a34a; font-weight: 500;">Server shut down successfully.</span>
                        <div style="margin-top: 16px; font-size: 13px; color: #666;">
                            To restart, run this command in your terminal:
                        </div>
                        <div style="
                            margin-top: 10px;
                            background: #1e1e1e;
                            border-radius: 6px;
                            padding: 12px 14px;
                            display: flex;
                            align-items: center;
                            gap: 10px;
                        ">
                            <code id="restart-cmd" style="
                                flex: 1;
                                font-family: 'SF Mono', Monaco, Consolas, monospace;
                                font-size: 12px;
                                color: #e0e0e0;
                                word-break: break-all;
                            ">${escapedCmd}</code>
                            <button id="copy-restart-cmd" style="
                                background: #3b82f6;
                                color: white;
                                border: none;
                                padding: 6px 12px;
                                border-radius: 4px;
                                cursor: pointer;
                                font-size: 11px;
                                font-weight: 500;
                                white-space: nowrap;
                            ">Copy</button>
                        </div>
                    `);
                    
                    // Copy button handler
                    $overlay.find('#copy-restart-cmd').on('click', function() {
                        const cmd = restartCmd;
                        navigator.clipboard.writeText(cmd).then(() => {
                            $(this).text('Copied!').css('background', '#16a34a');
                            setTimeout(() => {
                                $(this).text('Copy').css('background', '#3b82f6');
                            }, 2000);
                        }).catch(() => {
                            // Fallback for older browsers
                            const textarea = document.createElement('textarea');
                            textarea.value = cmd;
                            document.body.appendChild(textarea);
                            textarea.select();
                            document.execCommand('copy');
                            document.body.removeChild(textarea);
                            $(this).text('Copied!').css('background', '#16a34a');
                            setTimeout(() => {
                                $(this).text('Copy').css('background', '#3b82f6');
                            }, 2000);
                        });
                    });
                    
                    $btn.hide();
                    $overlay.find('#restart-cancel').text('Close');
                }
            } else {
                const data = await response.json();
                $overlay.find('p').html(`<span style="color: #dc2626;">Failed to restart: ${data.error || 'Unknown error'}</span>`);
                $btn.prop('disabled', false).text('Try Again');
            }
        } catch (error) {
            console.error('[System] Restart error:', error);
            $overlay.find('p').html('<span style="color: #dc2626;">Network error. Is the server running?</span>');
            $btn.prop('disabled', false).text('Try Again');
        }
    });
    
    // Close on overlay click
    $overlay.on('click', function(e) {
        if (e.target === $overlay[0]) {
            $overlay.remove();
        }
    });
    
    // Close on escape
    $(document).one('keydown', function(e) {
        if (e.key === 'Escape') {
            $overlay.remove();
        }
    });
}

// Export to window for global access
window.checkForUpdates = checkForUpdates;
window.showUpdateToast = showUpdateToast;
window.showUpdateModal = showUpdateModal;
window.showRestartConfirmation = showRestartConfirmation;

export { checkForUpdates, showUpdateToast, showUpdateModal, showRestartConfirmation };

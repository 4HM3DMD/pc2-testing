/*
 * Copyright (C) 2024-present Elacity
 *
 * Mint/Publish Toolbar Button
 * 
 * Adds a publish button to the toolbar with a drag-and-drop file upload dropdown
 * and a "Ready to sign" queue showing saved drafts.
 */

import launch_app from '../helpers/launch_app.js';

const ACCEPTED_HINT = 'Video, Audio, Images, PDF, 3D, Models — up to 4 GB';

const mintIconSvg = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>')}`;

const uploadCloudSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="#888" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>`;

const MIME_ICONS = { 'video': '🎬', 'audio': '🎵', 'image': '🖼️', 'application/pdf': '📄', 'model': '🧊' };

function mimeIcon(mime) {
    if (!mime) return '📦';
    for (const [prefix, icon] of Object.entries(MIME_ICONS)) {
        if (mime.startsWith(prefix)) return icon;
    }
    return '📦';
}

function timeAgo(dateStr) {
    if (!dateStr) return '';
    const seconds = Math.floor((Date.now() - new Date(dateStr + 'Z').getTime()) / 1000);
    if (seconds < 60) return 'just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
}

function formatSize(bytes) {
    if (!bytes) return '';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return (bytes / Math.pow(k, i)).toFixed(1) + ' ' + sizes[i];
}

function initMintButton() {
    if ($('#mint-btn-styles').length) return;

    $('head').append(`
        <style id="mint-btn-styles">
            .mint-dropdown {
                position: fixed;
                z-index: 2147483647;
                background: rgba(26, 26, 26, 0.92);
                backdrop-filter: blur(20px);
                -webkit-backdrop-filter: blur(20px);
                border: 1px solid rgba(255,255,255,0.12);
                border-radius: 12px;
                padding: 16px;
                width: 280px;
                box-sizing: border-box;
                box-shadow: 0 8px 32px rgba(0,0,0,0.5);
                font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', sans-serif;
                user-select: none;
            }
            .mint-dropdown-header {
                display: flex;
                align-items: center;
                gap: 6px;
                margin-bottom: 12px;
                color: #fff;
                font-size: 13px;
                font-weight: 600;
                letter-spacing: -0.01em;
            }
            .mint-drop-zone {
                border: 1.5px dashed rgba(255,255,255,0.18);
                border-radius: 10px;
                padding: 24px 16px;
                display: flex;
                flex-direction: column;
                align-items: center;
                justify-content: center;
                gap: 8px;
                cursor: pointer;
                transition: all 0.2s ease;
            }
            .mint-drop-zone:hover,
            .mint-drop-zone.drag-over {
                border-color: rgba(255,255,255,0.35);
                background: rgba(255,255,255,0.04);
            }
            .mint-drop-zone.drag-over svg { stroke: #fff; }
            .mint-drop-zone-text {
                color: #999;
                font-size: 12px;
                text-align: center;
                line-height: 1.4;
            }
            .mint-drop-zone-browse { color: #6b9fff; cursor: pointer; }
            .mint-hint {
                color: #555;
                font-size: 10px;
                text-align: center;
                margin-top: 10px;
                line-height: 1.4;
            }
            .mint-queue-divider {
                height: 1px;
                background: rgba(255,255,255,0.08);
                margin: 14px 0 10px;
            }
            .mint-queue-header {
                display: flex;
                align-items: center;
                justify-content: space-between;
                margin-bottom: 8px;
                color: #aaa;
                font-size: 11px;
                font-weight: 500;
            }
            .mint-queue-count {
                background: rgba(255,255,255,0.1);
                color: #ccc;
                font-size: 10px;
                padding: 1px 6px;
                border-radius: 8px;
            }
            .mint-queue-list {
                max-height: 180px;
                overflow-y: auto;
                display: flex;
                flex-direction: column;
                gap: 6px;
            }
            .mint-queue-item {
                display: flex;
                align-items: center;
                gap: 10px;
                padding: 8px;
                border-radius: 8px;
                cursor: pointer;
                transition: background 0.15s;
            }
            .mint-queue-item:hover { background: rgba(255,255,255,0.06); }
            .mint-queue-icon { font-size: 20px; flex-shrink: 0; width: 28px; text-align: center; }
            .mint-queue-info { flex: 1; min-width: 0; }
            .mint-queue-title {
                color: #fff;
                font-size: 12px;
                font-weight: 500;
                white-space: nowrap;
                overflow: hidden;
                text-overflow: ellipsis;
            }
            .mint-queue-meta { color: #666; font-size: 10px; margin-top: 2px; }
            .mint-queue-actions {
                display: flex;
                flex-direction: column;
                align-items: flex-end;
                gap: 4px;
                flex-shrink: 0;
            }
            .mint-queue-sign {
                color: #6b9fff;
                font-size: 11px;
                font-weight: 500;
                display: flex;
                align-items: center;
                gap: 2px;
                cursor: pointer;
            }
            .mint-queue-cancel {
                color: #666;
                font-size: 10px;
                cursor: pointer;
                transition: color 0.15s;
            }
            .mint-queue-cancel:hover { color: #ef4444; }
            .mint-badge {
                position: absolute;
                top: -2px;
                right: -2px;
                min-width: 14px;
                height: 14px;
                border-radius: 7px;
                background: #3b82f6;
                color: #fff;
                font-size: 9px;
                font-weight: 700;
                display: flex;
                align-items: center;
                justify-content: center;
                padding: 0 3px;
                line-height: 1;
                z-index: 1;
            }
        </style>
    `);

    let cachedDraftCount = 0;

    const createButton = () => {
        return $(`
            <div class="mint-toolbar-btn toolbar-btn" role="button" aria-label="Publish" tabindex="0" title="Publish" style="background-image: url('${mintIconSvg}'); position: relative;"></div>
        `);
    };

    const updateBadge = (count) => {
        cachedDraftCount = count;
        $('.mint-toolbar-btn .mint-badge').remove();
        if (count > 0) {
            $('.mint-toolbar-btn').append(`<span class="mint-badge">${count}</span>`);
        }
    };

    const fetchBadgeCount = async () => {
        try {
            const resp = await fetch(`${window.api_origin}/api/drafts/count`, {
                headers: { 'Authorization': `Bearer ${window.auth_token}` }
            });
            if (resp.ok) {
                const data = await resp.json();
                updateBadge(data.count || 0);
            }
        } catch (_) {}
    };

    const insertButton = () => {
        const $toolbar = $('.toolbar');
        if ($toolbar.length === 0) {
            setTimeout(insertButton, 200);
            return;
        }

        const $aiBtn = $toolbar.find('.ai-toolbar-btn');
        if ($aiBtn.length === 0) {
            setTimeout(insertButton, 200);
            return;
        }

        $('.mint-toolbar-btn').remove();
        const $mintBtn = createButton();
        $aiBtn.after($mintBtn);

        const $topbarAi = $('.topbar .ai-toolbar-btn');
        if ($topbarAi.length > 0) {
            const $topbarMint = createButton();
            $topbarAi.after($topbarMint);
        }

        fetchBadgeCount();
        setInterval(fetchBadgeCount, 30000);
    };

    insertButton();

    const closeDropdown = () => { $('.mint-dropdown').remove(); };

    $(document).on('mousedown', function (e) {
        if ($(e.target).closest('.mint-dropdown, .mint-toolbar-btn').length === 0) {
            closeDropdown();
        }
    });

    const handleFile = (file) => {
        if (!file) return;
        closeDropdown();
        window.__mintFile = file;
        launch_app({
            name: 'elacity-creator',
            window_title: 'Elacity Creator',
            args: { fromToolbar: true, fileName: file.name },
        });
    };

    const handleResumeDraft = (draftId) => {
        closeDropdown();
        launch_app({
            name: 'elacity-creator',
            window_title: 'Elacity Creator',
            args: { resumeDraft: draftId },
        });
    };

    // Build queue section HTML from drafts list
    const buildQueueHtml = (drafts) => {
        if (!drafts || drafts.length === 0) return '';

        let html = `<div class="mint-queue-divider"></div>`;
        html += `<div class="mint-queue-header"><span>Ready to sign</span><span class="mint-queue-count">${drafts.length}</span></div>`;
        html += `<div class="mint-queue-list">`;

        for (const d of drafts) {
            const icon = mimeIcon(d.mime_type);
            const meta = [timeAgo(d.created_at), formatSize(d.file_size)].filter(Boolean).join(' · ');
            html += `<div class="mint-queue-item" data-draft-id="${d.id}">
                <div class="mint-queue-icon">${icon}</div>
                <div class="mint-queue-info">
                    <div class="mint-queue-title">${$('<span>').text(d.title || 'Untitled').html()}</div>
                    <div class="mint-queue-meta">${meta}</div>
                </div>
                <div class="mint-queue-actions">
                    <div class="mint-queue-sign" data-action="sign">Sign ›</div>
                    <div class="mint-queue-cancel" data-action="cancel" data-draft-id="${d.id}">Cancel</div>
                </div>
            </div>`;
        }

        html += `</div>`;
        return html;
    };

    $(document).on('click', '.mint-toolbar-btn', async function (e) {
        e.stopPropagation();
        e.preventDefault();

        if ($('.mint-dropdown').length > 0) {
            closeDropdown();
            return;
        }

        const pos = this.getBoundingClientRect();

        // Fetch drafts
        let drafts = [];
        try {
            const resp = await fetch(`${window.api_origin}/api/drafts`, {
                headers: { 'Authorization': `Bearer ${window.auth_token}` }
            });
            if (resp.ok) {
                drafts = (await resp.json()).filter(d => d.status === 'ready');
            }
        } catch (_) {}

        updateBadge(drafts.length);

        const $dropdown = $(`
            <div class="mint-dropdown">
                <div class="mint-dropdown-header">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
                    Publish
                </div>
                <div class="mint-drop-zone">
                    ${uploadCloudSvg}
                    <div class="mint-drop-zone-text">
                        Drop file to publish<br>
                        <span class="mint-drop-zone-browse">or browse</span>
                    </div>
                </div>
                <div class="mint-hint">${ACCEPTED_HINT}</div>
                <input type="file" class="mint-file-input" style="display:none;">
                ${buildQueueHtml(drafts)}
            </div>
        `);

        const dropdownWidth = 280;
        const rightEdge = pos.right;
        const left = Math.max(8, Math.min(rightEdge - dropdownWidth, window.innerWidth - dropdownWidth - 8));
        $dropdown.css({ top: pos.bottom + 10, left });

        $('body').append($dropdown);

        // Drop zone click
        $dropdown.find('.mint-drop-zone').on('click', function () {
            $dropdown.find('.mint-file-input').trigger('click');
        });

        $dropdown.find('.mint-file-input').on('change', function () {
            if (this.files && this.files.length > 0) handleFile(this.files[0]);
        });

        // Drag and drop
        $dropdown.find('.mint-drop-zone').on('dragover', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            $(this).addClass('drag-over');
        });
        $dropdown.find('.mint-drop-zone').on('dragleave', function (ev) {
            ev.preventDefault();
            $(this).removeClass('drag-over');
        });
        $dropdown.find('.mint-drop-zone').on('drop', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();
            $(this).removeClass('drag-over');
            if (ev.originalEvent.dataTransfer.files.length > 0) {
                handleFile(ev.originalEvent.dataTransfer.files[0]);
            }
        });

        // Clicking the row (or Sign) opens the signing flow
        $dropdown.find('.mint-queue-item').on('click', function (ev) {
            if ($(ev.target).closest('.mint-queue-cancel').length) return;
            const draftId = $(this).data('draft-id');
            if (draftId) handleResumeDraft(draftId);
        });

        // Cancel button deletes the draft
        $dropdown.find('.mint-queue-cancel').on('click', async function (ev) {
            ev.stopPropagation();
            const draftId = $(this).data('draft-id');
            if (!draftId) return;
            try {
                await fetch(`${window.api_origin}/api/drafts/${draftId}`, {
                    method: 'DELETE',
                    headers: { 'Authorization': `Bearer ${window.auth_token}` }
                });
                $(this).closest('.mint-queue-item').fadeOut(200, function () {
                    $(this).remove();
                    const remaining = $dropdown.find('.mint-queue-item').length;
                    $dropdown.find('.mint-queue-count').text(remaining);
                    updateBadge(remaining);
                    if (remaining === 0) {
                        $dropdown.find('.mint-queue-divider, .mint-queue-header, .mint-queue-list').remove();
                    }
                });
            } catch (_) {}
        });
    });

    $(document).on('keydown', function (e) {
        if (e.key === 'Escape') closeDropdown();
    });
}

export default initMintButton;

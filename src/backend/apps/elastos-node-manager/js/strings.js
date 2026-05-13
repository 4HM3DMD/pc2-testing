/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * STRINGS — every user-facing string the UI displays.
 *
 * Why a flat object instead of inline literals?
 *   PC2's GUI ships its own i18n at src/gui/src/i18n/i18n.js (38 languages).
 *   v0.1 is English-only (matches PC2's setup wizard precedent), but we keep
 *   strings centralized so v0.2 can drop in by:
 *     1. Pasting STRINGS keys into PC2's translation files
 *     2. Replacing references with `window.i18n('enm.<key>')`
 *
 * Convention: hierarchical dot-keys mirror the UI region.
 * Format helpers: use {placeholder} tokens — services/format.js fills them.
 */

(function (root) {
    'use strict';

    /**
     * Recursively freeze an object so deep mutations throw in strict mode.
     * Object.freeze only freezes the top level — nested objects stay mutable
     * unless we walk them.
     *
     * @param {object} o
     * @returns {object}
     */
    function deepFreeze(o) {
        Object.freeze(o);
        for (var k in o) {
            if (Object.prototype.hasOwnProperty.call(o, k)
                && o[k] && typeof o[k] === 'object'
                && !Object.isFrozen(o[k])) {
                deepFreeze(o[k]);
            }
        }
        return o;
    }

    var STRINGS = deepFreeze({
        // Friendly vocabulary — eli5 + "your ElastOS" framing.
        // Used by v0.4 components (welcome-screen, setup-conversation,
        // hero-card, settings-drawer, milestone-toast). The technical
        // strings below are still consumed by the v0.3 components that
        // live inside the technical-view drawer.
        friendly: {
            app_title: 'Welcome to your ElastOS',

            welcome: {
                title:  'Turn your ElastOS into a node',
                body:   'In a few minutes, your ElastOS will be helping secure '
                      + 'the network — and earning ELA while it does.',
                cta:    "Let's go",
            },

            setup: {
                progress: 'Step {n} of {total}',
                back:     'Back',
                next:     'Next',
                cancel:   'Cancel setup',

                card_a: {
                    title:      'What kind of node?',
                    // ENM is positioned for BPoS supernode + Council node operators only.
                    // "Full node" is NOT a primary option — the chain can run as a
                    // follower technically, but ENM the product targets the two
                    // governance roles. (See feedback_enm_vocabulary memory entry.)
                    bpos_title: 'BPoS supernode',
                    bpos_sub:   'Validate blocks, earn ELA',
                    bpos_meta:  '~17% APR*',
                    council_title:   'Council node',
                    council_sub:     'CR governance role',
                    council_meta:    'Coming soon',
                    council_disabled: true,
                    footer:     "* Rewards depend on votes from the community. We'll show you how after setup.\n"
                              + "Council node setup will land in a later release.",
                },
                card_b: {
                    title_idle:        'Ready when you are',
                    title_active:      'Setting your ElastOS up',
                    title_done:        'All set up — almost there',
                    sub_idle:          'When you tap the button below, your ElastOS will download and install the chain software. Takes about 2 minutes.',
                    sub_active:        'Grab a coffee while we get things ready ☕',
                    sub_done:          'Everything is installed and ready.',
                    cta_install:       'Install now',
                    cta_retry:         'Try again',
                    cta_continue:      'Continue',
                    phase_preparing:   'Getting ready…',
                    phase_downloading: 'Downloading…',
                    phase_verifying:   'Making sure everything works…',
                    phase_installing:  'Almost ready…',
                    phase_done:        'Done',
                    phase_failed:      "Something didn't work",
                    failed_help:       'Tap "Try again". If it keeps failing, check your internet connection.',
                },
                card_b2: {
                    title_idle:                 'Speed up first sync?',
                    sub_idle:                   "Your node can either download the official Elastos snapshot (~15 min) or sync block-by-block from scratch (1–3 days). The snapshot is what most operators pick — the chain still verifies everything as it catches up to today.",
                    badge_recommended:          'Recommended',
                    tile_bootstrap_title:       'Use official snapshot',
                    tile_bootstrap_sub:         'Skip the wait. Your node will be ready in roughly 15 minutes.',
                    tile_bootstrap_meta:        '~10 GB download · needs ~40 GB free',
                    tile_genesis_title:         'Sync from scratch',
                    tile_genesis_sub:           'Verify every block from genesis. Slower, but no trust in anyone else’s files.',
                    tile_genesis_meta:          '1–3 days, depending on hardware',
                    cancel:                     'Cancel download',
                    advancing:                  'Saving your choice…',
                    advance_failed:             'Could not save your choice: {error}',
                    title_running:              'Downloading the snapshot',
                    sub_running:                "Leave this open. We’ll move you on as soon as it’s ready.",
                    title_failed:               "Snapshot didn’t finish",
                    sub_failed:                 'Network or disk problem during the download.',
                    title_done:                 'Snapshot ready',
                    sub_done:                   'Your node has the official chain data. Continue to the next step.',
                    cta_retry:                  'Try again',
                    cta_fallback_genesis:       'Skip and sync from scratch instead',
                    cta_continue:               'Continue',
                    genesis_picked_title:       'Genesis sync chosen',
                    genesis_picked_sub:         'Your node will sync from block 0. This can take 1–3 days.',
                    phase_preparing:            'Getting ready…',
                    phase_resolving:            'Checking the snapshot…',
                    phase_downloading:          'Downloading',
                    phase_extracting:           'Unpacking…',
                    phase_applying:             'Moving files into place…',
                    phase_verifying:            'Verifying…',
                    phase_done:                 'Done',
                    phase_failed:               'Failed',
                },
                card_c: {
                    title_initial:    'Save your secret password',
                    title_generated:  '🔑 Here is your secret password',
                    sub_initial:      "We'll generate a strong password for you. It protects your earnings.",
                    sub_generated:    'Save it somewhere safe — a password manager is best. We won\'t be able to show it again.',
                    cta_generate:     'Generate my password',
                    cta_continue:     'Continue',
                    cta_copy:         'Copy',
                    cta_copied:       'Copied!',
                    ack:              "I've saved it somewhere safe",
                    skip_full:        'No password needed for follower nodes — moving on.',
                },
                card_d: {
                    title_starting:  'Starting your ElastOS up…',
                    title_done:      "🎉 You're all set!",
                    sub_starting:    'Almost there.',
                    sub_done:        'Your ElastOS is now a node and is starting up.',
                    cta:             'Take me home',
                },
            },

            // v0.5 reset notes:
            //   - Removed the friendly state vocabulary (healthy_earn,
            //     syncing, stalled, etc.) — those were inferred from
            //     partial backend data and frequently lied. The
            //     post-setup home view is now the technical dashboard,
            //     which renders only fields the API explicitly returns.
            //   - Removed the stat-strip vocabulary (earned/running/peers)
            //     for the same reason: the strip hard-coded a "votes as
            //     proxy for earned ELA" lie. v0.6+ will reintroduce
            //     stats once a real earned-ELA tracker exists.
            //   - Removed the milestone celebrations — they pivoted on
            //     the same fragile inference layer.
            //   - notif.* is preserved because the toast texts are still
            //     used by the proposal pipeline (CRITICAL prompts pop on
            //     top of the dashboard).
            // alpha.28.1 batch 46 — `friendly.notif` (3 keys) and the
            // friendly.settings.section_* / opt_* sub-blocks (~12 keys)
            // dropped. Round-7 i18n audit acbcec6b verified zero JS
            // callers. The settings drawer was rewritten in alpha.13
            // with inline strings; the friendly notification copy was
            // never wired up — the live notification pipeline uses
            // the technical strings under notification.* instead.

            // Errors that surface to the user.
            error: {
                backend_offline:  "Can't reach your node manager",
                backend_offline_sub: "Try refreshing this page in a moment.",
                forbidden:        "Only the owner can manage this node",
                forbidden_sub:    "Sign in as the operator who set up this PC2.",
                generic:          'Something went wrong',
            },
        },

        app: {
            // alpha.28.1 batch 47 — title / connecting / reconnecting
            // dropped. The PC2 window chrome shows the app name (see
            // technical-view.js:155 comment); the spinner text is
            // static in index.html:115 and the reconnecting state
            // surfaces via inline pills in chain-card and log-viewer.
            // Round-7 i18n audit acbcec6b.
            backendUnreachable: 'ENM backend unavailable',
            backendHelp:
                'The enm-server sidecar at :4180 is not responding. On the host, run '
                + '`docker compose logs enm-server` to investigate.',
            // alpha.28.1 — offline override surfaced by app._showError when
            // navigator.onLine === false. Kept in the same family so the
            // copy can move together when localised.
            offlineTitle: 'You appear to be offline',
            offlineHelp: 'Your browser reports no network connection. Reconnect and click Retry.',
            unauthenticatedHelp:
                'Your PC2 session has expired. Reload the dashboard and sign in again.',
            forbiddenHelp:
                'This PC2 node has a different owner. Only the operator who claimed this '
                + 'node can manage chains.',
            generic_error: 'Something went wrong',
            // alpha.28.1 batch 40 — error pane recovery buttons +
            // skip-link text. index.html ships English defaults; app
            // boot replaces them with these keys when strings.js loads.
            retry:      'Retry',
            reload:     'Reload page',
            skip_link:  'Skip to main content',
            // alpha.28.1 batch 80 (Round-22 finding #4) — spinner-text
            // initial boot label. index.html ships the English literal
            // ("Connecting to Node Manager…"); the app boot replaces it
            // with this key once strings.js loads. Matches the existing
            // retry/reload/skip_link pattern.
            connecting: 'Connecting to Node Manager…',
        },

        // alpha.28.1 batch 44 — `nav:` namespace dropped (~7 lines).
        // No JS caller references nav.dashboard / nav.logs etc. The
        // top-level tabs were hidden in v0.4 (app.js:467 marks them
        // hidden = true); technical-view's sub-tabs use inline
        // English labels defined in the TABS array, not strings.js.
        // (Round-7 i18n audit acbcec6b.)

        chain_state: {
            healthy:    'Healthy',
            syncing:    'Syncing',
            stalled:    'Stalled',
            stopped:    'Stopped',
            error:      'Error',
            recovering: 'Recovering',
            unconfigured: 'Not configured',
            disabled:   'Disabled',
        },

        chain_actions: {
            start:      'Start',
            stop:       'Stop',
            restart:    'Restart',
            configure:  'Configure',
            // alpha.28.1 batch 46 — dropped confirm_stop, confirm_restart,
            // cooldown. Round-7 i18n audit acbcec6b verified zero JS
            // callers. The chain-card uses a click-and-busy pattern
            // (enmRunOnce) rather than a confirm() dialog.
            starting:   'Starting...',
            stopping:   'Stopping...',
            restarting: 'Restarting...',
        },

        chain_card: {
            version:    'Version',
            height:     'Height',
            peers:      'Peers',
            uptime:     'Uptime',
            // alpha.28.1 batch 45 — dropped: no_chains, details_show,
            // details_hide. Round-7 i18n audit acbcec6b verified zero
            // callers — no_chains is unreachable copy (setup auto-routes
            // before this state can render); details_*  was for a
            // never-shipped expand/collapse affordance.
            // 0.2.0-alpha.1 — Apple Hero pattern: big number alone on
            // the primary value line, small lowercase caption below.
            // primary_metric_* drive the number (or em-dash placeholder
            // when not applicable); primary_label_* drive the caption.
            // When unconfigured/stopped, the caption carries the action
            // hint so the operator knows where to click.
            primary_metric_synced:       '{height}',
            primary_metric_syncing:      '{local} / {network}',
            primary_metric_height:       '{height}',
            primary_metric_off:          '—',
            primary_metric_unconfigured: '—',
            primary_label_height:        'block height',
            primary_label_off:           'tap power to start',
            primary_label_unconfigured:  'tap to configure',
            // 0.2.0-alpha.4 — caption swap during initial peer
            // handshake. Reassures the operator that the empty
            // "block height: —" state lasts about a minute and
            // resolves itself.
            primary_label_connecting:    'connecting to peers',
            sparkline_aria:              'Block height, last hour',
            sse_reconnecting:            'Reconnecting…',
            tap_circle_aria:             'Status of {chainName}',
            // alpha.28.1 batch 45 — dropped bpos_* (5 keys) and sync_*
            // (8 keys). The chain-card never renders a "BPoS details"
            // sub-panel and the sync line uses inline copy with
            // enmFormatNumber. (Round-7 i18n audit acbcec6b.)
        },

        system_status: {
            // alpha.15 — labels carry the context that moved out of the
            // value formatters (the "free" / "of N GB" suffixes) so the
            // value text stays narrow and the cell doesn't truncate.
            cpu:        'cpu load',
            mem:        'ram used',
            disk:       'disk free',
            os:         'os',
            uptime:     'uptime',
        },

        log_viewer: {
            heading:    'Logs',
            live:       'Live',
            paused:     'Paused (auto-resume on new line)',
            empty:      'No log lines yet. The chain may not have started, or its log file is empty.',
            // alpha.28.1 batch 44 — dropped: connection_lost,
            // filter_placeholder, level_all/info/warn/error. No JS
            // caller; the filter UI was never built and the
            // connection-lost state surfaces via the inline pill
            // string in log-viewer.js:91 ('reconnecting…').
            // (Round-7 i18n audit acbcec6b.)
        },

        // alpha.28.1 batch 43 — `wizard:` namespace dropped (~50 keys).
        // The v0.4 "Welcome Home" rewrite replaced the 9-step wizard
        // with setup-conversation; the strings sat orphan ever since.
        // Round-7 i18n audit (acbcec6b) verified zero JS callers.
        // Batch 29 already deleted the matching CSS cluster.

        notification: {
            severity_info:    'Info',
            severity_warning: 'Warning',
            severity_critical: 'Critical',
            severity_healing: 'Self-healing',
            // alpha.28.1 batch 38 — SR-only severity prefix (batch 7
            // introduced these inline in notifications.js renderToast).
            // Kept distinct from severity_* above because the SR
            // version reads more naturally aloud ("Notice: …" beats
            // "Info: …") and "Action needed" is clearer than the
            // technical "Self-healing" when announced to a user who
            // can't see the visual amber stripe.
            sr_info:     'Notice',
            sr_warning:  'Warning',
            sr_critical: 'Critical',
            sr_healing:  'Action needed',
            dismiss: 'Dismiss',
            ack: 'Acknowledge',
        },

        proposal: {
            heading:           'Confirmation needed',
            cooldown_pending:  'Hold {seconds}s before confirming...',
            confirm_label:     'I understand: {summary}',
            confirm_button:    'Confirm',
            reject_button:     'Reject',
            reject_reason_placeholder: 'Optional reason',
            // alpha.28.1 batch 37 — anti-snipe input label moved from
            // inline English. Both placeholder + aria-label use the
            // same string for visible/AT parity.
            anti_snipe_label:  'Anti-snipe password',
            expires_in:        'Expires in {minutes} min',
            expired:           'Expired',
            executed:          'Executed',
            rejected:          'Rejected',
            // alpha.28.1 batch 69 — fallback when both summary_action
            // and summaryAction are absent on the proposal payload.
            // Prevents the ack-checkbox ceremony from silently
            // degrading to "I understand: " with a blank trailing
            // value, and the post-action notification from posting
            // an empty body.
            fallback_action:   'this operation',
        },

        owner: {
            forbidden: 'Only the node owner can perform this action.',
            unauthenticated: 'Authentication required',
        },

        common: {
            close: 'Close',
            cancel: 'Cancel',
            save: 'Save',
            edit: 'Edit',
            apply: 'Apply',
            details: 'Details',
            yes: 'Yes',
            no: 'No',
            loading: 'Loading...',
            // alpha.28.1 — referenced by enmRunOnce labels in settings-tab
            // save handlers and by validator-registration-card's activate
            // failure branch via `t('common.failed')`; previously slipped
            // through enmT and only survived because of `|| 'Saving…'`
            // fallbacks scattered through callers.
            saving: 'Saving…',
            failed: 'Failed',
            empty: 'Empty',
            // alpha.28.1 batch 76 — "Done" transient button label used
            // by technical-view's _runMaintenance success branch (1.5s
            // flash before reverting to the original "Run" label).
            done:   'Done',
        },

        settings: {
            heading_network: 'Network',
            heading_advanced: 'Mainchain Advanced',
            heading_general:  'General preferences',
            ip_label:         'External IP / hostname',
            ip_mode_auto:     'Auto-detect',
            ip_mode_manual:   'Manual override',
            ip_help:          'BPoS peers dial this address — leave blank for auto.',
            ip_detect_btn:    'Detect now',
            ip_save_btn:      'Save network settings',
            adv_log_level:    'Log level',
            adv_archive_mode: 'Archive mode (full history)',
            adv_memory_limit: 'Memory limit (MB)',
            adv_rpc_user:     'RPC user',
            adv_rpc_password: 'RPC password',
            adv_white_ip:     'WhiteIPList (comma-separated)',
            adv_white_ip_help: 'Default 127.0.0.1 only. Add LAN IPs (e.g. 192.168.1.42) or CIDR ranges (e.g. 192.168.1.0/24) to let other machines reach the RPC. The RPC is HTTP Basic-auth protected — anyone in this list still needs the user/password below.',
            adv_save_btn:     'Save mainchain settings',

            heading_rpc_creds:  'RPC access',
            rpc_creds_intro:    'External apps connect via JSON-RPC. Off by default — toggle on once you\'ve set the allow-list. Treat the password like a key.',
            // alpha.28.1 batch 47 — rpc_reveal_btn dropped (alpha.17 RPC
            // redesign removed the reveal-on-click affordance; password
            // visibility now lives in the rpc_show_pw / rpc_hide_pw
            // toggle below). Round-7 i18n audit acbcec6b.
            rpc_hide_btn:       'Hide',
            rpc_show_pw:        'Show password',
            rpc_hide_pw:        'Hide password',
            rpc_copy:           'Copy',
            rpc_copied:         'Copied',
            rpc_field_user:     'RPC user',
            rpc_field_pw:       'RPC password',
            // alpha.28.1 batch 47 — rpc_field_local / lan / white +
            // rpc_url_group_heading dropped. Alpha.17 redesigned the
            // RPC access tab to use rpc_url_same_machine / rpc_url_
            // private_network / rpc_url_public_internet (still live
            // below); the older "Connection URLs" group heading +
            // per-row labels are no longer rendered.
            rpc_url_same_machine:   'For apps on this server',
            rpc_url_private_network:'For apps on your local network',
            rpc_url_public_internet:'For apps over the internet',
            rpc_url_public_warn:    'Open your firewall + whitelist the IP. Anyone with this URL + password can submit transactions.',
            rpc_white_apply_btn:    'Apply changes',
            rpc_white_help:         'Clients can connect ONLY from these. 127.0.0.1 is locked (needed for ENM). Add IPs or CIDR ranges.',
            // alpha.28.1 batch 39 — chipInput format-hint error string
            // (was inline English in settings-tab.js:1238 flashInvalid).
            rpc_white_invalid:      'Not a valid IPv4 or CIDR (try 192.168.1.5 or 192.168.1.0/24).',
            rpc_white_apply_failed: 'Whitelist save failed: {error}',
            rpc_white_applied:      'Whitelist saved.',
            rpc_toggle_section:     'RPC server',
            rpc_toggle_off:         'Off',
            rpc_toggle_on:          'On',
            rpc_toggle_off_help:    'External apps cannot connect. Apps on this server still work.',
            rpc_toggle_on_help:     'Whitelisted IPs can connect.',
            rpc_toggle_save_btn:    'Save',
            rpc_toggle_saved:       'Restart mainchain to apply.',
            rpc_toggle_save_failed: 'Save failed: {error}',
            rpc_allow_section:      'Allowed IPs',
            rpc_urls_section:       'URLs to share',
            rpc_creds_section:      'Credentials',
            rpc_white_no_change:    'No changes to apply.',
            rpc_no_lan:         'No non-loopback interfaces detected.',
            rpc_load_failed:    'Failed to load credentials: {error}',
            general_auto_safe: 'Auto-execute AUTOMATED-SAFE healings',
            general_audit_retention: 'Audit retention (days)',
            general_critical_ack: 'CRITICAL notifications must be acknowledged',
            general_save_btn: 'Save preferences',
            saved:            'Saved.',
            save_failed:      'Save failed: {error}',
            // alpha.28.1 batch 36 — three validation error messages
            // previously inline-English in settings-tab._saveAdvanced /
            // _saveGeneral. Moved into strings.js so a locale swap
            // covers them.
            err_memory_range: 'Memory limit must be between 512 MB and 32 GB.',
            err_rpc_user:     'RPC user must be letters and numbers only (no spaces or symbols).',
            err_retention:    'Audit retention must be between 0 and 3650 days (0 keeps audit logs forever).',

            heading_danger:    'Danger zone',
            danger_intro:      'Permanently wipe this app and all its data from your PC2.',
            danger_show_btn:   'Show wipe controls',
            danger_hide_btn:   'Hide',
            danger_kept_h:     'WHAT IS KEPT',
            danger_kept_li1:   'keystore.dat — your BPoS supernode key. Auto-backed up to:',
            danger_kept_path:  '/var/lib/pc2/data/backups/elastos-node-manager/keystore-<timestamp>.dat',
            danger_kept_li2:   'Restore by copying it back into the new install’s keystore path after reinstall.',
            danger_wiped_h:    'WHAT IS WIPED',
            danger_wiped_li1:  'The Elastos Node Manager app itself (its files and code on disk).',
            danger_wiped_li2:  'Chain blocks (resync will take 1–3 days after reinstall).',
            danger_wiped_li3:  'Settings, RPC user/password, audit log, healing history.',
            danger_confirm_h:  'Type WIPE to confirm',
            danger_confirm_ph: 'WIPE',
            danger_wipe_btn:   'Wipe and uninstall',
            danger_in_progress: 'Backing up keystore and uninstalling…',
            danger_done:       'Done. Your keystore was preserved at {path}. Redirecting to PC2 home in 5…',
            danger_failed:     'Wipe failed: {error}. The app has NOT been uninstalled.',
        },

        validator_card: {
            eyebrow:    'Next step',
            title:      'Register as a BPoS validator',
            sub:        'Your node is fully caught up with the network. Three quick steps and it can start earning ELA rewards.',

            step1_title: 'Copy your producer public key',
            step1_help:  "Your keystore was generated during setup and lives on this server. This is its public half — share it freely; the secret half never leaves the server.",
            copy:        'Copy',
            copied:      'Copied',

            step2_title: 'Sign the registration in Elastos Essentials',
            step2_help:  'The 5,000 ELA registration deposit must be signed by the wallet that owns it. This server has no signing key for that wallet on purpose — you do it on your phone.',
            step2_a:     'Open Elastos Essentials → Wallet → Voting → BPoS supernodes.',
            step2_b:     'Tap "Register as new supernode".',
            step2_c:     'Fill in the form:',
            step2_d:     'Confirm and sign. The 5,000 ELA deposit moves to a lockup address. Wait about 6 blocks (≈12 minutes) for the chain to confirm — you can leave this page open.',

            field_name:       'Node name',
            field_name_help:  'A public-facing display name. Up to 30 characters.',
            field_pubkey:     'Node public key',
            field_pubkey_help:'Paste the value you copied in step 1.',
            field_addr:       'Node IP / URL',
            field_addr_help:  "Your server's public address so other peers can dial you (your domain or external IP).",
            field_url:        'Website (optional)',
            field_url_help:   'Public page voters can read to learn who you are.',

            deposit_note: 'The 5,000 ELA deposit is refundable — you get it back when you unregister, minus chain fees. It is NOT a payment.',

            step3_title:        'Activate your supernode',
            step3_help:         "Once the registration is confirmed on chain, tap below to send the activation transaction. This server signs it with your producer key (the same one we manage during normal operation — no separate keystore to manage here).",
            activate_btn:       'Activate BPoS supernode',
            activate_btn_active:'Activating…',
            activate_ok:        'Activation submitted — wait a block or two for chain confirmation.',
        },

        audit: {
            heading:        'Audit log',
            filter_chain:   'Chain',
            filter_tier:    'Tier',
            filter_from:    'From',
            filter_to:      'To',
            apply_filter:   'Apply',
            export_btn:     'Export JSON',
            empty:          'No audit entries match these filters.',
            col_ts:         'Time',
            col_chain:      'Chain',
            col_rule:       'Rule',
            col_tier:       'Tier',
            col_decision:   'Decision',
            col_executor:   'Executor',
            col_outcome:    'Outcome',
            tier_any:       'Any tier',
            load_more:      'Load more',
            load_more_capped: 'Cap reached — narrow filters or export to see more.',
            // alpha.28.1 batch 39 — row-count suffix moved from inline
            // English. ICU plurals still deferred (audit-tab.js audit
            // acbcec6b flagged "1 rows" as the cosmetic bug).
            // alpha.28.1 batch 74 (Round-20A audit finding #3) — split
            // singular vs plural so "1 rows" stops being printed. The
            // ICU plural shim is still deferred; for now the audit-tab
            // caller picks between the two keys based on count.
            row_count:      '{n} rows',
            row_count_one:  '{n} row',
        },

        // alpha.28.1 batch 59 — producer-identity on-chain binding strings
        // moved out of inline English in components/producer-identity.js so
        // a locale swap covers them. The previous shape had ~7 untranslated
        // strings in _renderBinding (heading, four state chips, two notes,
        // mismatch detail), making the on-chain binding section the largest
        // remaining English-only block on the dashboard. Round-3 i18n
        // coverage audit (aef9c321) flagged this.
        producer_binding: {
            heading:          'On-chain binding',
            chip_bound:       'Bound',
            chip_bound_state: 'Bound — {state}',
            chip_unregistered:'Not yet registered on chain',
            chip_mismatch:    'MISMATCH — chain reports a different node key',
            chip_unknown:     'Status unknown',
            owner_compare_note:
                'Compare the owner public key below to what Essentials '
              + 'shows under your BPoS deposit. If they differ you '
              + 'registered under a different wallet — votes and '
              + 'rewards will flow there, not here.',
            owner_label:      'Owner public key (chain)',
            split_key_note:   'V2 split-key producer: owner and node keys differ. Normal post-DPoSV2.',
            mismatch_detail:  'ENM holds node pubkey {ours} but the chain returned {theirs}. This is rare — open the audit log and contact support.',
        },

        // alpha.28.1 batch 76 — technical-view Maintenance section moved
        // out of inline English. Round-3 i18n coverage audit (aef9c321)
        // listed the technical-view maintenance card as one of the four
        // remaining hardcoded blocks. Strings cover title/sub, the three
        // action rows (label + help), the disabled-reason strings the
        // gate() helper renders, the "Run" button label, and the
        // operator-facing toast titles emitted by _runMaintenance.
        tech_maintenance: {
            title:                 'Maintenance',
            sub:                   'Mirrors the node.sh helpers operators used to run by hand. Each action runs on this server with the keystore + binaries we already manage; nothing leaves this PC2.',
            run_btn:               'Run',
            running_btn:           'Running…',
            compact_label:         'Compact logs',
            compact_help:          'Gzip + purge ela.log per the rotation policy. Same as the daily cron — exposed for "free space now".',
            compact_ok_title:      'Logs compacted',
            compact_fail_title:    'Compaction failed',
            activate_label:        'Reactivate BPoS supernode',
            activate_help:         'Sends a <code>producer activate</code> transaction so the chain flips your producer state from Inactive back to Active. Requires a keystore + funded deposit address.',
            activate_confirm:      "This sends a 'producer activate' transaction on-chain using your keystore. Continue?",
            activate_ok_title:     'Reactivation submitted — wait a block or two for chain confirmation',
            activate_fail_title:   'Reactivation rejected',
            rebootstrap_label:     'Re-bootstrap chain data',
            rebootstrap_help:      'Wipes the local chain DB and re-downloads the official Elastos snapshot (~10 GB, ~15 min) so a stuck or corrupt sync can recover without reinstalling. The chain must be stopped first. Existing settings + keystore are kept.',
            rebootstrap_prompt:    'Re-bootstrap wipes the local chain DB and downloads the official snapshot (~10 GB). The chain must already be stopped. Existing keystore + settings are kept.\n\nType BOOTSTRAP to confirm:',
            rebootstrap_ok_title:  'Bootstrap started — Settings → Logs to watch progress',
            rebootstrap_fail_title:'Bootstrap failed to start',
            // Gate-reason strings (displayed inline on the row when the
            // action is disabled). Each branch in _applyToolsGates.
            disabled_chain_stopped:    'Chain must be running.',
            disabled_not_registered:   'Not yet registered as a BPoS producer. See the Identity tab for the registration steps.',
            disabled_already_active:   'Producer is already Active — nothing to do.',
            disabled_chain_running:    'Stop the chain first (data dir in use).',
        },

        // alpha.28.1 batch 81 — tools-update CARD strings (the resting
        // and update-available states). Modal-internal strings are
        // deferred to batch 82+ since they're a larger block.
        tools_update: {
            head_resting:          'Binary update',
            head_available:        'Binary update available',
            badge_offline:         'offline',
            badge_offline_title:   'GitHub unreachable; showing last known stable version baked into this ENM build.',
            badge_stale:           'stale',
            badge_stale_title:     'GitHub probe failed; showing the last successful result.',
            // {version} fills with env.current. {time} fills with the
            // relTime <span> HTML — caller splices raw since it includes
            // markup; locale switch only touches the surrounding prose.
            latest_release_one:    "You're on the latest release ({version}).",
            latest_release_with_check:
                "You're on the latest release ({version}). Last checked {time}.",
            fallback_explainer:
                'GitHub unreachable from this server; comparison uses the build-time '
              + '<code>knownGoodElaVersion</code> baked into this ENM bundle.',
            notes_summary:         'Release notes',
            open_on_github:        'Open on GitHub →',
            // {current} → installed version; {latest} → available version.
            // Splices raw `<code>` markup; safe because both values flow
            // through escapeHtml at the call site.
            versions_line:         'Installed {current} → available {latest}',
            update_btn:            'Update via shell',
            update_help:           'Opens a copy-paste-ready command. Apply-in-place (no shell required) lands in alpha.11+.',
            // Relative-time-suffix used by the "Last checked" span.
            // {time} carries the human substring ("5 min ago").
            released_when:         'released {time}',
        },
    });
    // STRINGS is a deeply-frozen tree — see deepFreeze above.

    /**
     * Look up a dot-path in STRINGS and substitute {tokens}. Missing keys
     * return the key itself in brackets so they're visible to QA.
     *
     * @param {string} key   e.g. 'wizard.binary_ok'
     * @param {object} [vars] e.g. { version: 'v0.9.9.5' }
     * @returns {string}
     */
    function t(key, vars) {
        if (typeof key !== 'string' || key.length === 0) {
            return '';
        }
        var parts = key.split('.');
        var cur = STRINGS;
        for (var i = 0; i < parts.length; i += 1) {
            if (cur && typeof cur === 'object' && parts[i] in cur) {
                cur = cur[parts[i]];
            } else {
                return '[' + key + ']';
            }
        }
        if (typeof cur !== 'string') {
            return '[' + key + ']';
        }
        if (!vars) {
            return cur;
        }
        return cur.replace(/\{([a-zA-Z0-9_]+)\}/g, function (match, name) {
            return Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : match;
        });
    }

    root.ENM_STRINGS = STRINGS;
    root.enmT = t;
}(typeof window !== 'undefined' ? window : globalThis));

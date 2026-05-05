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
                    title:      'What do you want to do?',
                    earn_title: 'Earn rewards',
                    // Technical role surfaces in the subtitle so the operator
                    // learns the name they'll encounter in Essentials, on
                    // explorers, and in support docs. "BPoS supernode" is
                    // distinct from "Council member (CR)" — friendly synonyms
                    // would erase that distinction.
                    earn_sub:   'Run a BPoS supernode',
                    earn_meta:  '~17% APR*',
                    help_title: 'Help the network',
                    help_sub:   'Run a full node',
                    help_meta:  'No rewards',
                    footer:     "* Rewards depend on votes from the community. We'll show you how after setup.\n"
                              + "Council member (CR) registration will be available in a later update.",
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
            notif: {
                auto_restart:    'Your ElastOS had a hiccup and restarted itself. All good now.',
                needs_attention: 'Your ElastOS needs a moment — tap to see what happened.',
                back_online:     'Your ElastOS is back online.',
            },

            // Settings drawer.
            settings: {
                title: 'Settings',

                section_notif:     'When to tell me',
                opt_notif_help:    'Tell me when my ElastOS needs help',
                opt_notif_celebrate: 'Celebrate milestones (first reward, etc.)',
                opt_notif_weekly:  'Send me a weekly summary',

                section_behavior:  'How my ElastOS behaves',
                opt_auto_restart:  'Restart automatically if it crashes',
                opt_auto_heal:     'Try to fix problems without asking me',
                opt_auto_heal_help:'Recommended only for experienced operators.',

                section_advanced:  'For the technically curious',
                opt_show_tech:     'Show technical details',
                opt_view_log:      'View activity log',
                opt_reinstall:     'Reinstall my node',

                save:              'Save changes',
                saved:             'Saved.',
                close:             'Close',
            },

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
            title: 'Elastos Node Manager',
            connecting: 'Connecting to Node Manager...',
            reconnecting: 'Reconnecting to Node Manager...',
            backendUnreachable: 'ENM backend unavailable',
            backendHelp:
                'The enm-server sidecar at :4180 is not responding. On the host, run '
                + '`docker compose logs enm-server` to investigate.',
            unauthenticatedHelp:
                'Your PC2 session has expired. Reload the dashboard and sign in again.',
            forbiddenHelp:
                'This PC2 node has a different owner. Only the operator who claimed this '
                + 'node can manage chains.',
            generic_error: 'Something went wrong',
        },

        nav: {
            dashboard: 'Dashboard',
            logs: 'Logs',
            settings: 'Settings',
            audit: 'Audit',
            evm: 'EVM',
        },

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
            confirm_stop:    'Stop {chainName}?',
            confirm_restart: 'Restart {chainName}?',
            cooldown:   'Hold on... {seconds}s',
            starting:   'Starting...',
            stopping:   'Stopping...',
            restarting: 'Restarting...',
        },

        chain_card: {
            version:    'Version',
            height:     'Height',
            peers:      'Peers',
            uptime:     'Uptime',
            no_chains:  'No chains configured. Run the setup wizard to add one.',
            bpos_heading: 'BPoS supernode',
            bpos_state:  'Producer state',
            bpos_votes:  'Votes',
            bpos_rank:   'Rank',
            bpos_inactive_rounds: 'Inactive rounds',
            sync_heading:  'Sync progress',
            sync_caught_up: 'Fully synced',
            sync_unknown:   'Network height unknown',
            sync_behind:    '{blocks} blocks behind',
            sync_velocity:  '{bpm} blocks/min',
            sync_eta:       '~{eta} remaining',
            sync_eta_lt_min: '<1 min remaining',
            sync_no_velocity: 'measuring rate...',
            sync_stale:     'Sync data stale — chain may be stopped',
        },

        system_status: {
            cpu:        'CPU',
            mem:        'RAM',
            disk:       'Disk',
            os:         'OS',
            uptime:     'Uptime',
        },

        log_viewer: {
            heading:    'Logs',
            live:       'Live',
            paused:     'Paused (auto-resume on new line)',
            empty:      'No log lines yet. The chain may not have started, or its log file is empty.',
            connection_lost: 'Live log connection lost. Reconnecting...',
            filter_placeholder: 'Filter...',
            level_all:   'All',
            level_info:  'Info',
            level_warn:  'Warn',
            level_error: 'Error',
        },

        wizard: {
            welcome_heading: 'Welcome to Elastos Node Manager',
            welcome_body:
                'ENM downloads the official Elastos mainchain release from download.elastos.io, '
                + 'generates your producer keystore on this server, writes a config, and runs '
                + 'the node — exactly like the upstream node.sh installer, with a UI on top.',
            step_os:      'Operating system check',
            step_disk:    'Disk space check',
            step_wallet:  'Wallet check',
            step_binary:  'Locate the ela binary',
            step_keystore: 'Import your keystore',
            step_complete: 'Confirm and start',
            os_ok:        'Detected {distroId} {version}.',
            os_fail:      '{reason}',
            disk_ok:      '{freeGb} GB free — plenty of room.',
            disk_warn:    '{freeGb} GB free — recommended minimum is 100 GB.',
            disk_fail:    'Less than 50 GB free — Mainnet sync needs ~80 GB.',
            wallet_ok:    'Owner wallet detected: {wallet}.',
            wallet_fail:  'No tethered wallet. Connect one in PC2 first.',
            binary_label: 'Path to your ela binary',
            binary_placeholder: '/home/op/Elastos.ELA/ela',
            binary_help:
                'You can let ENM build ela for you (recommended), or paste a path you already built.',
            binary_validating: 'Running --version to verify...',
            binary_ok:    'Detected {version}.',
            binary_fail:  '{reason}',
            binary_auto_btn:    'Install ela for me (auto)',
            binary_manual_btn:  'I already have ela built',
            binary_manual_verify_btn: 'Verify path',
            build_phase_idle:        'Ready',
            build_phase_preparing:   'Preparing...',
            build_phase_fetching_go: 'Setting up Go toolchain...',
            build_phase_cloning:     'Downloading Elastos.ELA source...',
            build_phase_building:    'Compiling ela (5-10 min)...',
            build_phase_verifying:   'Verifying the new binary...',
            build_phase_done:        'Done — ela ready',
            build_phase_failed:      'Build failed',
            build_phase_cancelled:   'Build cancelled',
            build_cancel_btn:        'Cancel build',
            build_retry_btn:         'Retry',
            build_log_heading:       'Build output',
            build_continue_btn:      'Continue',

            step_keystore: 'Import keystore',
            step_network:  'Network',
            step_confirm:  'Confirm and start',

            keystore_arbiter_label:  'Run as BPoS supernode (requires keystore)',
            keystore_path_label:     'Path to keystore.dat',
            keystore_path_placeholder: '/home/op/.elastos/keystore.dat',
            keystore_password_label: 'Keystore password',
            keystore_help:
                'BPoS mode requires the keystore that holds your producer signing key. '
                + 'Full-node mode skips this. Keep arbiter mode disabled if you only want '
                + 'to follow the chain.',
            keystore_save_btn:       'Save keystore',
            keystore_skip_btn:       'Skip (full-node mode)',
            keystore_ok:             'Keystore imported.',
            keystore_fail:           'Failed to import keystore: {reason}',

            network_help:
                'BPoS peers dial this address to reach you. Auto-detect uses '
                + 'checkip.amazonaws.com; pick manual if you have a static IP or DDNS.',
            network_save_btn:        'Save network',
            network_detect_btn:      'Detect now',

            confirm_heading:         'Review and start',
            confirm_role_arbiter:    'Role: BPoS supernode',
            confirm_role_full:       'Role: Full node',
            confirm_binary:          'Binary: {path}',
            confirm_ip:              'External IP: {value}',
            confirm_start_btn:       'Start mainchain',
            confirm_finishing:       'Generating config and starting node...',
            confirm_complete_no_start: 'Setup recorded. Click "Start" on the dashboard when ready.',
        },

        notification: {
            severity_info:    'Info',
            severity_warning: 'Warning',
            severity_critical: 'Critical',
            severity_healing: 'Self-healing',
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
            expires_in:        'Expires in {minutes} min',
            expired:           'Expired',
            executed:          'Executed',
            rejected:          'Rejected',
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
            empty: 'Empty',
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
            adv_save_btn:     'Save mainchain settings',
            general_auto_safe: 'Auto-execute AUTOMATED-SAFE healings',
            general_audit_retention: 'Audit retention (days)',
            general_critical_ack: 'CRITICAL notifications must be acknowledged',
            general_save_btn: 'Save preferences',
            saved:            'Saved.',
            save_failed:      'Save failed: {error}',
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

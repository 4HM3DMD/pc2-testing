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
                    bpos_sub:   'Run as a producer and sign blocks for the DPoS consensus. Earns block rewards once your wallet is voted in by the community.',
                    // 0.5.0 audit Session 1 — dropped the unanchored "~17% APR"
                    // claim. Actual rewards depend on community votes + total stake
                    // and can vary widely operator-to-operator (and change every
                    // voting cycle). A specific percentage on a welcome card invites
                    // complaint and misleads operators who join right before a
                    // voting cycle. Footer's "depends on votes" stays.
                    bpos_meta:  'Voted-in rewards*',
                    // 0.2.0-beta.3.6 — phase-06 mock spec is a three-line
                    // meta list (Requires / Wallet / Auto-installs) per
                    // role-card. Pre-beta.3.6 only had bpos_meta = "APR";
                    // these are the missing companions.
                    bpos_requires_label:  'Requires',
                    bpos_requires_value:  'producer keystore (signing key)',
                    bpos_wallet_label:    'Wallet',
                    bpos_wallet_value:    'paired in the next step',
                    bpos_install_label:   'Auto-installs',
                    bpos_install_value:   'ela mainchain only',
                    // beta.0.4.3 — Council node is a DISTINCT role from
                    // BPoS supernode (operator directive: "BPoS owners
                    // don't become Council nodes; Council nodes always
                    // run all services"). Picking Council triggers the
                    // full multi-chain sequential install (M1-M6 work):
                    // Mainchain → ESC/EID/PG → Oracles → Arbiter.
                    // (CR governance voting on treasury proposals
                    // happens via the operator's wallet app, NOT via
                    // node setup; this card is about the infrastructure,
                    // not the voting.)
                    council_title:   'Council node',
                    // 0.5.0 audit Session 1 — replaced stale "3 inputs" copy.
                    // The 7-card redesign (v0.4.7) collapsed user-supplied inputs
                    // to ONE: the EVM wallet address. The master password is
                    // generated client-side (no operator typing) and the Arbiter
                    // mining uses the same EVM address. Promising "3 inputs" then
                    // showing 1 field on Card 4 was a trust gap.
                    council_sub:     'Run the full multi-chain operator stack — Main chain, EVM sidechains (ESC/EID/PG), their Oracles, and Arbiter for cross-chain signing. ENM installs everything in sequence; you provide one wallet address — your master password is generated for you.',
                    // 0.5.0 audit Session 1 — Council's economic story is
                    // "many small streams" (PBFT block rewards on ESC/EID/PG +
                    // Arbiter mining heartbeats + the mainchain BPoS rewards if
                    // the operator's also a producer). We don't quote a number
                    // for the same reason BPoS no longer does — depends on stake
                    // + chain activity. "Multi-chain rewards*" anchors the role.
                    council_meta:    'Multi-chain rewards*',
                    council_meta_compact: 'Multi-chain',
                    council_status_label: 'Includes',
                    council_status_value: 'mainchain + 3 EVM sidechains + 3 oracles + arbiter',
                    // beta.0.4.3 — Council card is now ENABLED. The
                    // backend install endpoints (install-class-b /
                    // install-node-runtime / install-class-c /
                    // install-class-d) all exist as of v0.4.1. The
                    // CouncilSetupWizard component (M6.2 wizard surface)
                    // walks the operator through sequentially.
                    council_disabled: false,
                    council_requires_label: 'Requires',
                    council_requires_value: 'mainchain keystore (signing key, shared across chains)',
                    // 0.5.0 audit Session 1 CRITICAL — Council install hardcodes
                    // dpos.enableArbiter=true in install-mainchain-cfg (setup.js:
                    // 2079). That activates the ela binary's --enable-arbiter
                    // flag which puts the mainchain into BPoS PRODUCER mode
                    // (separate from the Class D Arbiter binary). Operators MUST
                    // see this disclosure before clicking — a CR Council seat
                    // and a BPoS producer slot are different elections with
                    // different responsibilities. Today the Council card silently
                    // enrolls them in producer mode.
                    council_includes_bpos_label: 'Also enables',
                    council_includes_bpos_value: 'BPoS producer mode on Main chain (separate community vote required to earn block rewards)',
                    council_wallet_label:   'Wallet',
                    council_wallet_value:   'paired in the next step',
                    // 0.5.0 audit Session 1 — separated footnote from help copy.
                    // Pre-0.5.0 the * "rewards depend on votes" line and the
                    // "Council vs BPoS" comparison ran together as one
                    // paragraph; visually + semantically distinct concerns
                    // belong on separate lines.
                    footer:     "Council node is the full multi-chain operator role; BPoS supernode runs Main chain only. Pick whichever matches the role you want to run.",
                    footnote:   "* Rewards depend on community votes + chain activity. Both roles earn only when active.",
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
                    sub_generated:    "We just generated a strong password that unlocks the keystore signing your DPoS rounds. Save it before continuing.",
                    // beta.3.38 — explicit warning callout above the password
                    // block + a row label so the operator's eye lands on the
                    // value, not on the surrounding chrome.
                    warning:          "This password is shown ONCE. If you lose it, you can't recover the keystore — you'd have to re-register the supernode from scratch. A password manager is the safest place.",
                    password_label:   'Password',
                    cta_generate:     'Generate my password',
                    cta_continue:     'Continue',
                    cta_copy:         'Copy',
                    cta_copied:       'Copied!',
                    ack:              "I've saved it somewhere safe",
                    skip_full:        'No password needed for follower nodes — moving on.',
                    // alpha.28.1 batch 88 (Round-28 finding #2) — UX
                    // parity with validator-card (batch 87): tell the
                    // operator the API failed and how to recover via
                    // manual select-and-copy. Previous shape selected
                    // the password silently with no toast.
                    copy_fail_title:  'Copy unavailable',
                    copy_fail_body:   'Browser blocked clipboard access. The password is selected — press Ctrl-C (or ⌘-C on Mac) to copy.',
                },
                card_d: {
                    title_starting:  'Starting your ElastOS up…',
                    title_done:      "🎉 You're all set!",
                    sub_starting:    'Almost there.',
                    sub_done:        'Your ElastOS is now a node and is starting up.',
                    cta:             'Take me home',
                },
                // beta.0.4.6 — Card D2: pre-flight checks. Sits
                // between Card D (mainchain up) and Card E (inputs)
                // on the Council path. Surfaces blockers UPFRONT so
                // the operator doesn't watch the install fail at
                // step 3 of 8 because GitHub is unreachable or disk
                // is full. The Re-run button retries after the
                // operator fixes the underlying issue without
                // restarting the wizard.
                card_d2: {
                    title:  'Pre-flight checks',
                    sub:    'Quick check that everything Council install needs is ready before we '
                          + 'start. Re-run if something fails after fixing it (e.g. firewall, '
                          + 'disk).',
                    cta:    'Continue',
                    rerun:  'Re-run checks',
                    running: 'Running checks…',
                    error_prefix: 'Pre-flight call failed: ',
                },
                // beta.0.4.5 — Card E redesigned per operator
                // directive 2026-05-18 ("too many steps and doesn't
                // actually understand what is it doing"). Collapsed
                // 3 inputs (password + reward + arbiter mining) down
                // to ONE (the wallet address). The mainchain keystore
                // password from Card C is reused for all sidechain
                // signing (H23). The Arbiter's mining address is the
                // same wallet address (schema accepts EVM or ELA).
                card_e: {
                    title:        'Your wallet address',
                    sub:          'ENM uses this for everything: ESC, EID, PG block rewards AND '
                                + 'the Arbiter’s cross-chain signing. One address from your '
                                + 'wallet — that’s it.',
                    reward_label: 'Your wallet address',
                    reward_hint:  'Paste your Ethereum-style address from Essentials. '
                                + 'Same address is used for ESC, EID, PG, and the Arbiter — '
                                + 'one wallet, one input.',
                    note_mining_off: 'Heads up: mining is OFF by default on the EVM sidechains. '
                                + 'Most Council rewards come from BPoS mainchain blocks and Arbiter '
                                + 'SideChainPow heartbeats. You can turn sidechain mining on later via '
                                + 'Settings → Mining & Rewards if you want the extra (small) rewards.',
                    cta:          'Install Council stack',
                },
                card_f: {
                    title:           'Installing Council stack',
                    sub:             'ENM is installing the remaining services. '
                                   + 'This usually takes 5–10 minutes depending on your network speed. '
                                   + 'Each step is real progress — not a spinner.',
                    cta_done:        'Open dashboard',
                    cta_retry:       'Retry',
                    cta_working:     'Working…',
                    summary_done:    'All chains installed. Click Continue to open the dashboard.',
                    summary_error:   'Install failed at one of the steps above. '
                                   + 'Click Retry to resume from where it stopped — '
                                   + 'completed steps are skipped on retry.',
                },

                // beta.0.4.7 — Card 2..7 keys for the redesigned 7-card
                // flow. Card A (welcome / role chooser) is reused as
                // Card 1 — its strings stay under `card_a.*` above.
                // The new flow collapses Card B / B2 / B3 / C / D / E /
                // F into a leaner sequence that's identical in shape
                // for Council and BPoS-only paths (the difference is
                // the per-card backend payload, not the UI). Mainchain
                // keystore password lives inside Card 3's master
                // password (BPoS path covers only mainchain; Council
                // path covers mainchain + ESC + EID + PG EVM keystores
                // + Arbiter wallet).
                card_2: {
                    title:           'System check',
                    sub:             'ENM verifies your hardware can actually run this workload before '
                                   + 'we touch anything. CPU cores, RAM, disk space and the OS get '
                                   + 'checked against the {path} thresholds. This step cannot be skipped.',
                    rerun:           'Re-run checks',
                    cta:             'Continue',
                    running:         'Running system checks…',
                    blocked_help:    'Fix the blocker, then press Re-run checks. Your host needs to meet '
                                   + 'the required thresholds before setup can proceed.',
                    add_swap_label:  'Your server has exactly 8 GB RAM. ENM can create a 4 GB swapfile '
                                   + 'so mainchain doesn\'t OOM during initial sync.',
                    add_swap_btn:    'Add swap automatically',
                    add_swap_working:'Creating swapfile…',
                    add_swap_done:   'Swap is active ({freeGbAfter} GB free including swap). Re-running checks…',
                    add_swap_failed: 'Could not add swap: {error}',
                    err_prefix:      'System check call failed: ',
                },
                card_3: {
                    title:           '🔑 Master password',
                    sub:             'This password unlocks every keystore on your node — save it ONCE.',
                    sub_council:     'One password protects every keystore on your node: mainchain '
                                   + 'producer key, ESC + EID + PG EVM keystores, and the Arbiter '
                                   + 'wallet. Save it once and you\'re done.',
                    sub_bpos:        'One password protects your mainchain producer keystore. Save it '
                                   + 'once — there\'s no recovery if it\'s lost.',
                    // 0.5.3 audit Session 3 — warning rewritten for accuracy.
                    // Pre-0.5.3 "shown ONCE" was misleading: localStorage stash
                    // re-displays it on refresh until install completes. The
                    // real catastrophic states are (a) clearing localStorage
                    // before install finishes, (b) generating on one origin
                    // then accessing from a different URL (per-origin
                    // localStorage means the password is missing on the new
                    // origin → wizard regenerates → mismatch with the
                    // existing keystore.dat). Copy now reflects both.
                    warning:         'Save this NOW to your password manager. If you lose it before the '
                                   + 'install completes, regenerating creates a different password that '
                                   + 'won\'t match the keystore — full wipe + reinstall needed. Stick to '
                                   + 'ONE access URL (IP or domain, not both) until install finishes; '
                                   + 'browsers keep the password separately per URL.',
                    show:            'Show',
                    hide:            'Hide',
                    password_label:  'Master password',
                    cta_generate:    'Generate my master password',
                    cta_continue:    'Continue',
                    cta_copy:        'Copy',
                    cta_copied:      'Copied!',
                    ack:             'I\'ve saved it somewhere safe',
                    copy_fail_title: 'Copy unavailable',
                    copy_fail_body:  'Browser blocked clipboard access. The password is selected — '
                                   + 'press Ctrl-C (or ⌘-C on Mac) to copy.',
                },
                card_4: {
                    title:           'Your wallet address',
                    // Heads up: operator directive 2026-05-19 — explainer
                    // MUST mention ESC, EID, PG mining rewards AND the
                    // Arbiter's cross-chain signing role. One wallet for
                    // everything; no separate inputs.
                    sub:             'ENM uses this one address for everything: block-mining rewards '
                                   + 'on ESC (Smart Chain), EID (Identity Chain), PG (private chain) '
                                   + 'AND the Arbiter\'s cross-chain signing on the mainchain. One '
                                   + 'wallet from Essentials — one input.',
                    sub_bpos:        'ENM uses this address as your producer\'s reward destination '
                                   + 'on the mainchain. Paste the same Essentials owner-address you '
                                   + 'will register with later.',
                    reward_label:    'Wallet address (Ethereum-style, from Essentials)',
                    reward_hint:     'Paste your Ethereum-style address from Essentials. '
                                   + 'Same address is used for ESC, EID, PG mining and the Arbiter — '
                                   + 'one wallet, one input.',
                    reward_hint_bpos:'Paste your Essentials owner-address. This is the address that '
                                   + 'will eventually appear on your producer registration.',
                    confirm_label:   'Confirm: retype the LAST 4 characters',
                    confirm_hint:    'Anti-typo gate: a wrong reward address means lost rewards '
                                   + 'forever. Retype the last 4 characters of the address above to '
                                   + 'confirm.',
                    err_format:      'Must start with 0x followed by 40 hex characters.',
                    // 0.5.4 audit Session 4 — operators paste from Essentials /
                    // MetaMask / explorer pages and sometimes capture the 40
                    // hex chars without the 0x prefix. Pre-0.5.4 they hit the
                    // generic format error and didn't know what was wrong;
                    // suggesting the fix preempts the support question.
                    err_missing_0x:  'Address is missing the "0x" prefix. Did you mean "{suggested}"?',
                    err_last4_empty: 'Retype the last 4 characters of the address above.',
                    err_last4_match: 'Mismatch — expected "{expected}".',
                    cta:             'Continue',
                },
                card_5: {
                    title:           'Confirm and install',
                    sub:             'A quick pre-flight then we kick everything off. Council always '
                                   + 'installs Mainchain + ESC + EID + PG + 3 oracles + Arbiter — no '
                                   + 'optional add-ons. Use the snapshot option to skip 1–3 days of '
                                   + 'block-by-block sync.',
                    sub_bpos:        'A quick pre-flight then we kick the mainchain install off.',
                    rerun:           'Re-run pre-flight',
                    snapshot_label:  'Use official snapshots for all 4 chains',
                    snapshot_hint:   'Default ON. Downloads ~50 GB of verified snapshots so the chains '
                                   + 'are ready in minutes instead of days. Needs ~200 GB free disk.',
                    cta:             'Install everything',
                    cta_bpos:        'Install mainchain',
                    cta_working:     'Starting install…',
                    running:         'Running pre-flight…',
                    blocked:         'Fix the blocking check above, then press Re-run pre-flight.',
                    err_prefix:      'Pre-flight call failed: ',
                    err_install:     'Could not start install: {error}',
                },
                card_6: {
                    title:           'Installing your node',
                    sub:             'ENM is installing all 4 chains, 3 oracles and the Arbiter. '
                                   + 'Real progress below — not a spinner. Usually 5–10 minutes if '
                                   + 'snapshots are on, 1–3 days if not.',
                    sub_bpos:        'ENM is installing the mainchain binary and configuration. '
                                   + 'Usually 2–5 minutes.',
                    cta_done:        'Open dashboard',
                    cta_retry:       'Retry from failed step',
                    cta_working:     'Working…',
                    summary_done:    'Everything is installed. Click Continue to open the dashboard.',
                    summary_error:   'Install failed at one of the steps above. Click Retry to resume '
                                   + 'from where it stopped — completed steps are skipped on retry.',
                    // 0.5.6 audit Session 6 — copy for the refresh-recovery
                    // path. If the operator refreshes at Card 6 BEFORE the
                    // install kicks off, _installInputs is null in-memory;
                    // backend would 412. Frontend now redirects to Card 5
                    // with this notification.
                    refresh_recovery_title: 'Re-confirm install settings',
                    refresh_recovery_body:  'You refreshed before the install started. Confirm your '
                                          + 'settings on the previous step and click Install everything '
                                          + 'again.',
                },
                card_7: {
                    title:           '🎉 Your Council node is live',
                    title_bpos:      '🎉 Your BPoS supernode is ready',
                    sub:             'All chains are installed and the services are starting up. Head '
                                   + 'to the dashboard to watch the chains come online and register '
                                   + 'your wallet when you\'re ready.',
                    sub_bpos:        'Mainchain is installed and starting up. Head to the dashboard '
                                   + 'to watch it sync and register your wallet when you\'re ready.',
                    cta:             'Open dashboard',
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
            // alpha.29 batch 98 — offline/recovery banner strings used
            // by the EnmOnlineWatcher service. Falls back to hardcoded
            // English inside the service if strings.js missed loading.
            offline_banner:  'You appear to be offline. The dashboard will refresh when your connection returns.',
            offline_retry:   'Retry now',
            online_restored: 'Connection restored. Refreshing data.',
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
            // beta.3.83 — Wave D — process alive but RPC not bound yet
            // (typical first ~30s after each chain start). chain-card.js
            // already handles 'starting' state with a hero-spinner.
            starting:   'Starting',
            // beta.3.90 (Wave M2.2) — additional coarse-state buckets
            // surfaced by CouncilOverviewService (lightweight aggregator
            // that doesn't run RPC). The richer healthy/syncing/stalled
            // analysis lives in the per-chain endpoint; overview uses
            // 'running' to mean "alive and past the startup grace window
            // — fine-grained sync state unknown at this layer".
            running:    'Running',
        },

        // beta.3.94 (Wave M2.6) — operator-facing display names for
        // every known chainId. Centralized here so chain-card (M2.4),
        // multi-chain-overview (M2.3), chain-selector, and settings-tab
        // (M2.5) all surface the SAME name. Strings used to live in
        // three CHAIN_DISPLAY_FALLBACK maps spread across the
        // components; M2.6 collapses them into a single source of truth.
        //
        // No ECO entry per H3 — ECO chain is permanently out-of-scope.
        chain_name: {
            mainchain:    'Main chain',
            esc:          'Smart Chain',
            'esc-oracle': 'ESC Oracle',
            eid:          'Identity Chain',
            'eid-oracle': 'EID Oracle',
            pg:           'PG Chain',
            'pg-oracle':  'PG Oracle',
            arbiter:      'Arbiter Service',
            spv:          'SPV Module',
        },

        // beta.3.94 (Wave M2.6) — section labels for the multi-chain
        // overview pane (M2.3) class-grouped sections. Five buckets
        // matching the 5-class taxonomy (plan §2). The '?' bucket is a
        // safety net for unknown/legacy chain ids — used to live in
        // CLASS_LABEL['?'] = 'Other' inside multi-chain-overview.js.
        chain_class_label: {
            A: 'Mainchain',
            B: 'EVM sidechains',
            C: 'Oracles',
            D: 'Cross-chain',
            E: 'Light clients',
            unknown: 'Other',
        },

        // beta.3.94 (Wave M2.6) — operator-facing labels for the M2.2
        // CouncilOverviewService coarseState values. Distinct from
        // chain_state above which is for the per-chain endpoint's full
        // analysis. Overview values: running / starting / stopped /
        // disabled / unconfigured (server-side enum, no 'syncing' etc).
        overview_state: {
            running:      'Running',
            starting:     'Starting',
            stopped:      'Stopped',
            disabled:     'Disabled',
            unconfigured: 'Not configured',
        },

        // beta.3.94 (Wave M2.6) — multi-chain overview pane copy.
        overview_pane: {
            title:                'Council overview',
            // Summary line uses {running}/{stopped}/{disabled}/{total}
            // placeholders so locales can reorder.
            summary_no_chains:    'No chains yet.',
            // Operator-facing "section is loading" copy.
            loading:              'Loading Council overview…',
            empty_title:          'No chains configured yet.',
            empty_body:           'Use the setup wizard to install your first chain. Once Mainchain is running you can add EVM sidechains, Oracles, and Arbiter from the same wizard.',
            error_title:          'Overview unavailable',
            error_malformed:      'Overview snapshot is malformed.',
            // Per-row aria-label "Open <chainName> dashboard".
            row_aria_open:        'Open {chainName} dashboard',
            // SR announcer message after row click.
            announce_switched_to: 'Switched to {chainName}',
        },

        // beta.3.94 (Wave M2.6) — non-mainchain dashboard pane stub
        // (M2.1) copy + per-class settings stub (M2.5) copy. The stub
        // is shown when a chain is selectable but its per-class
        // dashboard / settings layout hasn't shipped yet.
        pane_stub: {
            // Dashboard stub title is "{chainName} dashboard".
            dashboard_title:      '{chainName} dashboard',
            dashboard_body:       'This chain is not yet wired in the operator UI. Per-class dashboards land in upcoming milestones (M3 — EVM sidechains, M4 — Oracles, M6 — Arbiter). For now, use the chain selector above to return to Main chain.',
            // Multi-chain overview stub (shown only when the real
            // EnmMultiChainOverviewPane component fails to load).
            overview_title:       'Multi-chain overview',
            overview_body:        'Aggregate status for every configured chain lands in M2.3 (MultiChainOverviewPane). Until then this pane is a placeholder so the chain-selector wiring (M2.1) is reachable. Use the selector above to switch back to Main chain.',
        },

        // beta.3.94 (Wave M2.6) — Class B/C/D/E settings stubs (M2.5).
        // Each stub explains the milestone path so operators selecting
        // a non-mainchain chain see the right "coming in MX.Y" copy
        // rather than an empty pane.
        settings_class_stub: {
            // Class B (ESC/EID/PG)
            evm_title:      '{chainName} settings',
            evm_body:       'Class B (EVM sidechain) settings land in M3.3 (beta.3.97). The layout will include Mining & Rewards (miner address, sync mode), the PBFT keystore reference (read-only — points at the mainchain keystore), and per-chain Danger Zone actions.',
            evm_fallback:   'For now use the chain selector above to return to Main chain.',
            // Class C (Oracles)
            oracle_title:   '{chainName} settings',
            oracle_body:    'Class C (Oracle) settings land in M4.2. Oracles are normally surfaced inside their parent chain’s pane as a sub-status panel rather than a top-level row (plan §3). The Class C layout will include the Node.js runtime version pin, oracle script path, and per-oracle restart controls.',
            // Class D (Arbiter)
            arbiter_title:  'Arbiter settings',
            arbiter_body:   'Class D (Arbiter cross-chain signer) settings land in M6.4. The layout will include Wallet & Mining (wallet password, mining address, ELA balance), the Cross-chain Status reachability matrix, and a Danger Zone with reset controls.',
            // Class E (SPV)
            spv_title:      'SPV settings',
            spv_body:       'Class E (SPV light client) is likely deferred indefinitely (plan §12 Q8). If shipped (M6.7) the layout will be minimal: RPC port and filter type.',
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
            // beta.3.16 — dynamic aria-label per coarse state. Stopped
            // / error make the circle a real start-button affordance;
            // alive states just announce the role (Stop / Restart are
            // separate, visible buttons).
            tap_circle_aria_start:       'Start {chainName}',
            tap_circle_aria_configure:   'Configure {chainName}',
            tap_circle_aria_running:     '{chainName} status — currently running',
            // Visible caption that appears below the power icon when
            // the chain is stopped, telling the operator the circle
            // is tappable. Hidden in other states.
            tap_to_start_caption:        'Tap to start',
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
            // beta.3.15 a11y — visually-hidden region label so screen-
            // reader users get a name for this strip (the strip has no
            // visible heading).
            region_label: 'System status',
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
            // alpha.28.1 batch 85 (Round-25 finding #1) — Detect-now
            // result text moved out of inline English. The four states
            // mirror _detectIp's promise paths:
            //   detecting     → before the GET resolves
            //   detected      → ok+ip path
            //   detect_failed → ok=false path or .catch with a reason
            //   detect_unknown→ ok=false with no reason / generic error
            ip_detecting:     'Detecting…',
            ip_detected:      'Detected: {ip}',
            ip_detect_failed: 'Detection failed: {reason}',
            ip_detect_unknown:'unknown',
            // alpha.28.1 batch 85 (Round-25 finding #2) — client-side
            // validation parity for the Network save path. Sibling
            // handlers _saveAdvanced/_saveGeneral validate before the
            // PUT; _saveNetwork was the outlier letting the manual-mode
            // empty value reach the backend.
            err_ip_required:  'Enter an external IP or hostname (or switch to Auto-detect).',
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
            // alpha.28.1 batch 88 (Round-28 finding #2) — UX parity with
            // validator-card (batch 87): tell the operator when the
            // clipboard API was blocked so they know the value is
            // selected for manual copy. Previous shape selected silently
            // with no toast.
            rpc_copy_fail_title:'Copy unavailable',
            rpc_copy_fail_body: 'Browser blocked clipboard access. The value is selected — press Ctrl-C (or ⌘-C on Mac) to copy.',
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

            // beta.3.18 — Phase 1 IA reshape. The 3-section schema-dump
            // (Network / Mainchain Advanced / General) became 5 task-
            // oriented sections (Access / Security / Network / Storage /
            // Advanced). New copy throughout to explain WHY each knob
            // matters to a BPoS supernode operator, not just WHAT it
            // writes. See project_settings_phase_plan in memory.
            heading_access:   'Access',
            heading_identity: 'Identity',
            heading_security: 'Security',
            heading_storage:  'Storage',
            // Per-section one-line intros rendered as help under the heading.
            access_intro:     'Allow specific tools to reach this node’s JSON-RPC. Loopback (127.0.0.1) is always allowed so ENM itself can talk to ela.',
            security_intro:   'Defense-in-depth for your BPoS supernode.',
            network_intro:    'How DPoS peers reach this node. Set once at first boot; only change if your public IP moves.',
            storage_intro:    'How much history ENM keeps locally before pruning.',
            advanced_intro:   'Runtime tuning for the ela chain process. Defaults are correct for almost every operator.',
            // Advanced warning banner — operator chose option (b): always
            // visible at the bottom of Settings with this banner above the
            // controls explaining the risk of changing them.
            advanced_warn_title: 'Don’t change these unless you know why.',
            advanced_warn_body:  'Defaults are right for almost every BPoS supernode. Changing these can degrade chain performance or cost you blocks. Each change here needs a chain restart to apply.',
            // "What this protects" callouts surfaced inside the Security
            // section so operators understand the WHY behind the toggle/
            // password they’re configuring.
            anti_snipe_what:        'What this protects',
            anti_snipe_what_body:   'High-stakes healing actions (restart-on-crash, reactivate producer, rebootstrap chain) won’t execute without this password — even if your owner token leaks. A leaked-token attacker could only do safe read actions.',
            healing_what:           'What this controls',
            healing_what_body:      'When ENM detects a known-safe issue (process crashed, log file too big, RPC unresponsive), it can fix it without asking. Off = every action waits for your explicit OK.',
            critical_ack_what:      'What this controls',
            critical_ack_what_body: 'Slashing-risk alerts (sync drift, peer drop, BPoS state change) stay visible until you click to dismiss. Off = critical events auto-clear after 5 seconds like normal toasts.',
            // Save-button labels per new section. "Save General" is gone.
            save_access:     'Save Access',
            save_security:   'Save Security',
            save_storage:    'Save Storage',
            // Restart modal — fired after a save when the section requires
            // a chain restart for the change to take effect. Operator option
            // (3): don’t put lifecycle controls in Settings, but surface a
            // restart prompt when one is needed.
            restart_modal_title:      'Restart mainchain to apply',
            restart_modal_body:       'Your changes are saved, but the running node still uses the old values. Restart the chain now to apply them.',
            restart_modal_now:        'Restart now',
            restart_modal_later:      'Restart later',
            restart_modal_restarting: 'Restarting…',
            restart_modal_done:       'Mainchain restarted.',
            restart_modal_failed:     'Restart failed: {error}',
            restart_modal_close_aria: 'Close restart prompt',
            restart_modal_chain_stopped: 'The chain isn’t currently running, so there’s nothing to restart. Your settings will apply on next start.',
            // Migration of hardcoded English strings flagged by the
            // settings inventory audit. Same wording, just routed through
            // the i18n layer.
            nav_label_config:               'Configuration',
            ip_manual_placeholder:          'e.g. 203.0.113.14',
            rpc_user_tooltip:               'Letters and numbers only (no spaces or symbols).',
            rpc_password_placeholder_set:   '(leave blank to keep current)',
            rpc_white_add_placeholder:      'add IP or CIDR…',
            anti_snipe_placeholder_unset:   'unset · type a new password to set',
            anti_snipe_placeholder_set:     'set · type a new password to change',
            anti_snipe_set_btn:             'Set password',
            anti_snipe_clear_btn:           'Clear',
            anti_snipe_min_length:          'Password must be at least 8 characters.',
            anti_snipe_saved:               '✓ Anti-snipe password set',
            anti_snipe_clear_confirm:       'Disable anti-snipe password? Healing proposals that require it will fail until you set a new one.',
            anti_snipe_cleared:             '✓ Anti-snipe disabled',
            revert_btn:                     'Revert',

            // beta.3.19 — Phase 2 Alerts section. Operator-tunable
            // thresholds that drive HealthChecker's F3/F4/F5 detectors.
            // No restart needed — HealthChecker picks the new values
            // up on its next _loadConfigSafe tick (≤5 s).
            heading_alerts:           'Alerts',
            alerts_intro:             'When the dashboard should warn you. These thresholds drive the health detectors that decide what counts as a problem worth surfacing.',
            save_alerts:              'Save Alerts',
            // Disk-space pair (warn comes before critical so the operator
            // reads it in increasing-severity order).
            alerts_disk_warn_label:   'Disk space — warn at',
            alerts_disk_warn_help:    'Show a warning when free disk on the chain data dir drops below this. Default 20 GB.',
            alerts_disk_critical_label: 'Disk space — critical at',
            alerts_disk_critical_help:  'Escalate to a critical alert when free disk drops below this. Must be less than the warn value. Default 5 GB.',
            // Peer + sync timers. Both are "grace periods" — how long the
            // bad condition has to persist before the alert fires.
            alerts_peer_grace_label:  'Peer-count alert after',
            alerts_peer_grace_help:   'Wait this long with zero peers before alerting. Short values (1–2 min) catch real network issues fast but trip during normal handshake flutter. Default 5 min.',
            alerts_sync_grace_label:  'Sync-stall alert after',
            alerts_sync_grace_help:   'Alert when block height hasn’t advanced for this long despite peers being connected. Default 10 min — well above the ~2-minute block cadence on mainnet.',
            // Inline validation errors.
            alerts_err_disk_warn:     'Disk-warn threshold must be between 10 and 10,000 GB.',
            alerts_err_disk_critical: 'Disk-critical threshold must be between 1 and 10,000 GB and strictly less than the warn threshold.',
            alerts_err_peer_grace:    'Peer-zero grace must be between 1 and 120 minutes.',
            alerts_err_sync_grace:    'Sync-stall grace must be between 1 and 240 minutes.',

            // beta.3.20 — Phase 3 Storage section expansion. Two
            // operator-tunable policies (log retention + keystore
            // backup interval) drive the EnmStorageMaintenance 24h
            // cron. No manual buttons (operator directive #4 — "no
            // manual, everything automatic"). The section also shows
            // a read-only disk-usage breakdown + last-backup info.
            storage_disk_label:       'Disk usage on this server',
            storage_disk_help:        'Live snapshot. Auto-refreshes when you open this section.',
            storage_disk_chain_data:  'Chain data',
            storage_disk_logs:        'Logs',
            storage_disk_audit:       'Audit log',
            storage_disk_backups:     'Backups',
            storage_disk_total:       'Total',
            storage_disk_loading:     'Reading disk usage…',
            storage_disk_failed:      'Couldn’t read disk usage. Retrying.',
            // Log retention.
            storage_log_gzip_label:   'Compress old logs after',
            storage_log_gzip_help:    'Closed log files older than this get gzipped in place. Default 7 days.',
            storage_log_retention_label: 'Delete old logs after',
            storage_log_retention_help:  'Compressed *.log.gz files older than this are removed automatically. Must be greater than the compress-age. Default 30 days.',
            // Keystore backup.
            storage_backup_section_label: 'Keystore auto-backup',
            storage_backup_section_help:  'ENM copies your keystore.dat to a separate backup directory on a fixed schedule. No action needed — restore is just copying the .dat back into place if the install is ever lost.',
            storage_backup_interval_label: 'Backup every',
            storage_backup_interval_help:  'Auto-backup cadence. The job runs on a 24-hour timer; it backs up only when this many days have passed since the last copy. Default 7 days.',
            storage_backup_keep_label:   'Keep latest',
            storage_backup_keep_help:    'How many backup copies to retain. Older copies are deleted automatically. Default 4.',
            storage_backup_status_label: 'Status',
            storage_backup_last:         'Last backup: <strong>{when}</strong> at <code>{path}</code>',
            storage_backup_last_never:   'No automatic backup yet. The next 24-hour cycle will create one.',
            storage_backup_no_keystore:  'No keystore on disk yet. Auto-backup will start once you finish the setup wizard.',
            storage_backup_dir_hint:     'All backups live in <code>{dir}</code>. Restore by copying a .dat back into the keystore path.',
            // Validation errors.
            storage_err_log_gzip:       'Log compress-age must be between 1 and 365 days.',
            storage_err_log_retention:  'Log retention must be between 1 and 3,650 days and greater than the compress-age.',
            storage_err_backup_interval:'Backup interval must be between 1 and 90 days.',
            storage_err_backup_keep:    'Backup keep-count must be between 1 and 50.',
            // Time-ago.
            storage_relative_just_now:  'just now',
            storage_relative_minutes:   '{n} min ago',
            storage_relative_hours:     '{n} h ago',
            storage_relative_days:      '{n} d ago',

            // beta.3.21 — Phase 4: Healing visibility. Sits inside the
            // Security section, below the auto-execute-safe-healing
            // toggle. Two panels:
            //   1. "What auto-runs" — list of AUTOMATED_SAFE rules.
            //   2. "Recent activity" — last N rows from GET /healing/history.
            // No manual-trigger buttons (operator directive #4 —
            // everything stays automatic).
            healing_rules_heading:        'What auto-runs',
            healing_rules_help:           'These are the healing actions ENM is allowed to run on its own when the toggle above is on. Anything not on this list waits for the operator to confirm.',
            healing_rules_load_failed:    'Couldn’t load the rule list.',
            healing_rules_owner_heading:  'What needs your confirmation',
            healing_rules_owner_help:     'Detected issues in this group surface as proposals on the dashboard — they never run without you saying yes. Auto-execute does not apply here.',
            healing_rules_critical_heading: 'Critical alerts (notify only)',
            healing_rules_critical_help:    'These detectors raise an alert but never propose an automatic fix. Action is always operator-driven.',
            healing_activity_heading:     'Recent healing activity',
            healing_activity_help:        'What ENM did or proposed across the last 30 days. Loaded from the audit log; expires automatically per your retention setting.',
            healing_activity_empty:       'No healing activity yet. The list will populate as ENM detects and acts on issues.',
            healing_activity_load_failed: 'Couldn’t load activity. Retrying.',
            // beta.3.78 — settings.snapshot_* string keys removed with
            // the snapshot UI panel.
            healing_activity_col_when:    'When',
            healing_activity_col_rule:    'Rule',
            healing_activity_col_action:  'Action',
            healing_activity_col_outcome: 'Outcome',
            // Status badges on the activity rows.
            healing_status_executed:      'executed',
            healing_status_approved:      'approved',
            healing_status_rejected:      'rejected',
            healing_status_expired:       'expired',
            healing_status_pending:       'pending',
            healing_status_failed:        'failed',
            // Tier badges (matches the chain’s tier names).
            healing_tier_auto:            'auto',
            healing_tier_owner:           'owner',
            healing_tier_critical:        'critical',
            healing_tier_manual:          'manual',

            // beta.3.33 — Danger Zone. Four destructive actions backed
            // by /api/enm/maintenance/*. The copy here is operator-
            // facing: short labels on buttons, longer explanations in
            // help text so an operator pressed for time can scan the
            // titles, and one who's about to type the confirmation
            // word has the consequences in front of them.
            heading_danger:                 'Danger Zone',
            danger_intro:                   'Destructive actions. Each one has a typed-confirmation gate. There is no undo.',

            // Update card (least destructive — top of section).
            danger_update_title:            'Update ENM',
            danger_update_help:             'Install the latest ENM extension from GitHub. Your chain data, keystore, and settings are preserved — only the extension code is replaced. The chain restarts after the new version comes up.',
            danger_update_current_label:    'Current',
            danger_update_latest_label:     'Latest available',
            danger_update_btn:              'Update now',
            danger_update_uptodate:         'You are running the latest version.',
            danger_update_available:        'A newer version is available.',
            danger_update_error:            'Update check failed:',
            danger_update_confirm_dialog:   'Install the latest ENM version? The chain will restart automatically and may briefly disconnect.',
            danger_update_in_progress:      'Update in progress — ENM will restart in a few seconds…',
            danger_update_queued:           '✓ Update queued. Reload this page after ~30 seconds to see the new version.',

            // Chain resync card.
            danger_resync_title:            'Chain resync (keep keystore)',
            danger_resync_help:             'Wipe the chain database and re-sync from the network. Your keystore and settings are preserved. Use this if the chain is stuck, corrupted, or stuck on a forked tip. A re-sync from genesis can take 4–8 hours.',
            danger_resync_confirm_label:    'Type the chain name to confirm:',
            danger_resync_btn:              'Resync chain',
            danger_resync_confirm_dialog:   'This will delete all chain data and start a fresh sync. Your keystore is backed up first and stays on disk. Continue?',
            danger_resync_in_progress:      'Stopping chain, wiping data, restarting…',
            danger_resync_ok:               '✓ Chain data wiped. Re-sync started — may take 4–8 hours.',

            // App removal card (uninstall extension only).
            danger_remove_title:            'Remove app (keep chain data + keystore)',
            danger_remove_help:             'Uninstall the ENM extension from PC2. Your chain data, keystore, and audit log stay on disk at /var/lib/pc2/data/extensions/elastos-node-manager so you can reinstall later and pick up where you left off.',
            danger_remove_confirm_label:    'Type "remove" to confirm:',
            danger_remove_btn:              'Remove app',
            danger_remove_confirm_dialog:   'Uninstall the ENM extension? Your chain data, keystore, and audit log stay on disk so reinstall can recover them.',
            danger_remove_in_progress:      'Uninstalling ENM in a few seconds…',
            danger_remove_queued:           '✓ Uninstall queued. ENM will be removed shortly. Chain data + keystore stay on disk.',

            // Nuclear card (uninstall AND wipe everything).
            danger_nuke_title:              'Nuclear — remove app AND wipe everything',
            danger_nuke_help:               'Uninstall the ENM extension AND delete every piece of ENM data, including your keystore. This is the truly-start-from-zero option. There is no recovery without an off-server backup of the keystore.',
            danger_nuke_warning:            'This deletes your keystore. If you re-register as a BPoS supernode after this, you do so as a new producer with a new node identity. Any stake delegated to your current owner public key remains under your control in Elastos Essentials.',
            danger_nuke_confirm_label:      'Type WIPE EVERYTHING (uppercase) to confirm:',
            danger_nuke_btn:                'Wipe everything',
            danger_nuke_confirm_dialog:     'This will DELETE your keystore. There is no undo. Continue?',
            danger_nuke_in_progress:        'Wiping everything in a few seconds…',
            danger_nuke_queued:             '✓ Nuclear wipe queued. ENM and all its data will be removed shortly.',

            // beta.3.43 — Identity tab. Five cards: current identity
            // view, unlock-and-cache, backup, import, reset.
            identity_intro:                 'Your node’s consensus-signing identity (the keystore) and the on-chain producer it’s bound to. Reset, restore, or back up here.',

            identity_current_title:         'Current identity',
            identity_current_help:          'What this node signs DPoS messages with. Share the public key with Essentials; never share the keystore.',
            identity_pubkey_label:          'Node public key',
            identity_address_label:         'Node signing address',
            identity_producer_label:        'On-chain status',
            identity_producer_unregistered: 'Not registered yet',

            identity_unlock_title:          'Unlock & cache identity',
            identity_unlock_help:           'A keystore exists on disk but we can’t see its public key without the password. Enter the password you saved during setup to refresh the cached identity — the password is not stored.',
            identity_unlock_label:          'Keystore password',
            identity_unlock_placeholder:    'enter password',
            identity_unlock_btn:            'Unlock',
            identity_unlock_ok:             '✓ Identity cache refreshed.',

            identity_backup_title:          'Backup keystore',
            identity_backup_help:           'Download the encrypted keystore.dat. Keep this off the server with the password you saved — together they’re the only way to recover this producer if the server dies.',
            identity_backup_btn:            'Download backup',
            identity_backup_running:        'Preparing download…',
            identity_backup_ok:             '✓ Downloaded {name}',

            identity_import_title:          'Restore from backup',
            identity_import_help:           'Replace the current keystore with one you backed up earlier. We validate the password before swapping.',
            identity_import_file_label:     'Backup file (keystore.dat)',
            identity_import_password_label: 'Backup password',
            identity_import_password_placeholder: 'password for the file above',
            identity_import_confirm_label:  'Type "import" to confirm:',
            identity_import_btn:            'Restore keystore',
            identity_import_no_file:        'Pick a backup file first.',
            identity_import_confirm_dialog: 'Replace the current keystore with this backup? The current one is auto-archived.',
            identity_import_running:        'Validating and swapping keystore…',
            identity_import_ok:             '✓ Keystore restored from backup.',

            identity_reset_title:           'Reset keystore (new identity)',
            identity_reset_help:            'Generate a fresh keystore with a new password. The current one is auto-archived. The new public key will NOT match any existing on-chain producer registration.',
            identity_reset_confirm_label:   'Type "reset keystore" to confirm:',
            identity_reset_btn:             'Reset keystore',
            identity_reset_confirm_dialog:  'This generates a new keystore and shows a new password ONCE. Continue?',
            identity_reset_running:         'Stopping chain, generating new keystore, restarting…',
            identity_reset_ok:              '✓ New keystore generated.',
            identity_reset_password_warning:'Save this password somewhere safe — it’s shown only once and unlocks the new keystore.',

            identity_password_required:     'Password is required.',

            // beta.3.46 — Server integrity sub-card. Quiet by default;
            // operator clicks "Run check" to expand details. Honest
            // about scope (tamper-EVIDENCE not tamper-PROOF; can't
            // see hypervisor-level threats).
            identity_integrity_title:       'Server integrity',
            identity_integrity_help:        'Checks for changes to the ela binary, the keystore, and the host environment since this install. Run this if you want to know whether anything has shifted under your feet.',
            identity_integrity_collapsed:   'Not run yet. Click Run check to scan.',
            identity_integrity_run_btn:     'Run check',
            identity_integrity_running:     'Running…',
            identity_integrity_summary_ok:      '✓ All checks pass',
            identity_integrity_summary_warn:    '⚠ Drift detected — review the rows below',
            identity_integrity_summary_fail:    '✗ One or more checks failed',
            identity_integrity_summary_unknown: '? Some checks couldn’t run',
            identity_integrity_scope_note:  'Limits: this catches changes to the ela binary, the keystore.dat file, the system clock, and the host environment after install. It can’t see VPS-level threats like live RAM snapshots or pre-install disk images — those are invisible from inside the guest OS. Your owner key in Essentials remains the strongest protection.',
            identity_integrity_rebaseline_btn:      'Re-baseline (mark current state as trusted)',
            identity_integrity_rebaseline_running:  'Re-capturing baseline…',
            identity_integrity_rebaseline_ok:       '✓ Baseline re-captured.',
            identity_integrity_rebaseline_confirm:  'Mark the current state as the new trusted baseline? Use this AFTER you ran a legitimate change (binary update, keystore reset).',
            // beta.3.45 — audited against Elastos.ELA HEAD. Inactivity
            // does NOT slash the deposit (InactivePenalty = 0 on
            // mainnet, common/config/config.go:193). The risk is lost
            // rewards + identity orphaning, recoverable via an
            // Essentials-signed DPoSV2UpdateProducer + ActivateProducer
            // tx. The 200 ELA penalty (DPoSV2IllegalPenalty) only
            // applies for double-sign of consensus messages — a
            // keystore-swapped node can't even produce a valid sig,
            // let alone a double-sig, so this path is N/A. See
            // memory/feedback_enm_bpos_slashing_truth.md for the full
            // line-walk citations.
            identity_slashing_warning:      '⚠ This node is registered as a BPoS producer. Generating or importing a different keystore creates a new node public key that won’t match your on-chain registration, so ela stops being recognized as your producer’s signer. You’ll miss block-production rewards (no deposit penalty — InactivePenalty is 0 on mainnet) until you sign DPoSV2UpdateProducer in Essentials with the new node public key. After ~1440 missed rounds the chain flips the producer to Inactive; recovery from there is ActivateProducer + UpdateProducer in Essentials. Clicking below acknowledges the lost-rewards window.',
        },

        // beta.3.40 — Dashboard BPoS supernode card. Two visual variants
        // matching enm-design-mocks/v2/phase-03-status.html C (active,
        // "bound to this node's signing key") and D (not registered, "no
        // on-chain producer record matches this node's signing key").
        // Pre-3.40 these keys didn't exist in strings.js and validator-
        // registration-card.js was rendering bracketed placeholders.
        bpos_card: {
            // Variant D (not registered).
            head_title_register:        'BPoS supernode: not yet registered',
            head_sub_register:          'No on-chain producer record matches this node’s signing key.',
            chip_action_required:       'Action needed',
            cta_help_register:          'To start producing blocks and earn rewards, register your validator from your Elastos Essentials wallet. ENM will detect the on-chain record once confirmed and start tracking state automatically.',
            view_guide_btn:             'View registration guide',
            copy_pubkey_btn:            'Copy node public key',
            copy_aria:                  'Copy node public key',
            copied:                     'Copied!',
            copy_fail_title:            'Copy unavailable',
            copy_fail_body:             'Browser blocked clipboard access. The key is selected — press Ctrl-C (or ⌘-C on Mac) to copy.',
            signing_key_label:          'This node’s signing key',
            note_after_confirm:         'Paste this into the Producer Registration form in Essentials.',
            open_essentials_btn:        'View registration guide',

            // Variant C (active).
            head_title_active:          'BPoS supernode',
            head_sub_active:            'On-chain producer record bound to this node’s signing key.',
            head_sub_active_narrow:     'Bound to your wallet',
            chip_active:                'Active',
            chip_active_rank:           'Active · Rank #{rank}',
            stat_votes:                 'Votes',
            stat_votes_meta:            'Current snapshot',
            stat_inactive_rounds:       'Inactive rounds',
            stat_inactive_rounds_meta_safe: 'No slashing risk',
            stat_inactive_rounds_meta_warn: 'Near slashing threshold',
            note_active:                'Rewards and voting are managed in Elastos Essentials. ENM tracks on-chain producer status; claim, stake, and update operations require a signed transaction from your wallet.',

            // Variant B (needs activation). The render path uses
            // head_title_activation / head_sub_activation as key names;
            // duplicated under needs_activation_* aliases for clarity.
            head_title_activation:      'BPoS supernode: ready to activate',
            head_sub_activation:        'On-chain producer record found. Activate to start signing blocks.',
            head_title_needs_activation:'BPoS supernode: ready to activate',
            head_sub_needs_activation:  'On-chain producer record found. Activate to start signing blocks.',
            chip_ready_to_activate:     'Ready to activate',
            activate_btn:               'Activate supernode',
            activate_btn_running:       'Activating…',
            activate_ok_title:          'Activation submitted',
            activate_ok_body:           'Wait a block or two for chain confirmation.',

            // Deep-link guide modal copy (variant D's "View registration
            // guide" button). Until the Essentials deep-link integration
            // lands, the button surfaces a notifications.info with
            // step-by-step instructions.
            essentials_guide_title:     'Register your supernode in Elastos Essentials',
            essentials_guide_body:      'Open Elastos Essentials → Wallet → Voting → BPoS supernodes → "Register as new supernode". Paste this node’s public key into the Node Public Key field, sign with the wallet that holds the 2,000 ELA deposit, then wait ~6 blocks (about 12 minutes) for chain confirmation.',
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
            step2_help:  'The 2,000 ELA registration deposit must be signed by the wallet that owns it. This server has no signing key for that wallet on purpose — you do it on your phone.',
            step2_a:     'Open Elastos Essentials → Wallet → Voting → BPoS supernodes.',
            step2_b:     'Tap "Register as new supernode".',
            step2_c:     'Fill in the form:',
            step2_d:     'Confirm and sign. The 2,000 ELA deposit moves to a lockup address. Wait about 6 blocks (≈12 minutes) for the chain to confirm — you can leave this page open.',

            field_name:       'Node name',
            field_name_help:  'A public-facing display name. Up to 30 characters.',
            field_pubkey:     'Node public key',
            field_pubkey_help:'Paste the value you copied in step 1.',
            field_addr:       'Node IP / URL',
            field_addr_help:  "Your server's public address so other peers can dial you (your domain or external IP).",
            field_url:        'Website (optional)',
            field_url_help:   'Public page voters can read to learn who you are.',

            deposit_note: 'The 2,000 ELA deposit is refundable — you get it back when you unregister, minus chain fees. It is NOT a payment.',

            step3_title:        'Activate your supernode',
            step3_help:         "Once the registration is confirmed on chain, tap below to send the activation transaction. Your server signs the activation with the node's signing keystore — the same key it uses to sign block proposals during your on-duty rounds. Your owner key stays in Essentials and is never asked to sign here.",
            activate_btn:       'Activate BPoS supernode',
            activate_btn_active:'Activating…',
            activate_ok:        'Activation submitted — wait a block or two for chain confirmation.',
            // alpha.28.1 batch 87 — copy button aria-label + clipboard
            // fallback strings localised. Previous shape carried inline
            // English in the Copy button's aria-label and in two
            // duplicate hardcoded toast strings inside enmCopyToClipboard
            // opts (Round-26 audit findings #2 + #4).
            copy_aria:          'Copy public key',
            copy_fail_title:    'Copy unavailable',
            copy_fail_body:     'Browser blocked clipboard access. Public key is selected — press Ctrl-C (or ⌘-C on Mac) to copy.',
        },

        audit: {
            // beta.3.48 — renamed "Audit log" → "Activity" for plain-
            // language clarity. "Audit" sounded like compliance jargon;
            // the page is just a chronological list of things that
            // happened on this node.
            heading:        'Activity',
            filter_chain:   'Chain',
            filter_tier:    'Kind',
            filter_from:    'From',
            filter_to:      'To',
            apply_filter:   'Apply',
            export_btn:     'Export JSON',
            empty:          'No activity matches these filters.',
            // Default-friendly columns shown to all operators.
            col_when:       'When',
            col_what:       'What happened',
            col_result:     'Result',
            // Technical columns — surfaced only when the "Show technical
            // details" toggle is on. Keep the names short so the wider
            // table still fits on narrow viewports.
            col_ts:         'Timestamp (UTC)',
            col_chain:      'Chain',
            col_rule:       'Rule / Route',
            col_tier:       'Kind',
            col_decision:   'Decision',
            col_executor:   'Who',
            col_outcome:    'Outcome',
            tier_any:       'Any kind',
            filter_when:    'When',
            copy_filtered:  'Copy filtered rows',
            load_more:      'Load more',
            load_more_capped: 'Cap reached — narrow filters or export to see more.',
            // beta.3.48 — toggle for the technical view.
            show_technical:     'Show technical details',
            hide_technical:     'Hide technical details',
            // beta.3.48 — friendly names for the executor column.
            // beta.3.52 — the executor field is now a role label, not
            // a wallet hex. Possible values: 'operator', 'system',
            // 'F1'/'F2'/'AUTOSTART'/etc. PC2 wallet never appears here
            // anymore (ENM identity = keystore, not PC2 wallet).
            executor_you:       'You', // legacy key — no longer used
            executor_system:    'System',
            executor_operator:  'Operator',
            // beta.3.48 — friendly names for the 5 healing tiers.
            // Mock kept the full codes; operator feedback was that
            // they're internal jargon and don't help a regular user.
            tier_label_AUTOMATED_SAFE:  'Auto-fix',
            tier_label_OWNER_CONFIRMS:  'Awaits you',
            tier_label_CRITICAL_NOTIFY: 'Alert',
            tier_label_NEVER_AUTOMATIC: 'Manual',
            tier_label_HTTP_MUTATION:   'Setting change',
            tier_label_CRITICAL_INFO:   'Note',
            // beta.3.48 — friendly outcome groups.
            // beta.3.66 — restructured: only OWNER-CONFIRMS pending
            // proposals show "Awaits you"; everything else routes to
            // Done / Failed / Auto-resolved by the structured decision
            // field, not by pattern-matching the outcome string. The
            // old "Notified" badge was firing for ANY action whose
            // outcome string didn't match success/error patterns —
            // turned routine boots into a wall of alarming red badges.
            outcome_friendly_done:           'Done',
            outcome_friendly_failed:         'Failed',
            outcome_friendly_skipped:        'Skipped',
            outcome_friendly_noted:          'Notified', // legacy — kept for back-compat, not emitted by 3.66+
            outcome_friendly_pending:        'Awaits you',
            outcome_friendly_auto_resolved:  'Auto-resolved',
            outcome_friendly_rejected:       'Rejected',
            outcome_friendly_expired:        'Expired',

            // alpha.28.1 batch 39 — row-count suffix moved from inline
            // English. ICU plurals still deferred (audit-tab.js audit
            // acbcec6b flagged "1 rows" as the cosmetic bug).
            // alpha.28.1 batch 74 (Round-20A audit finding #3) — split
            // singular vs plural so "1 rows" stops being printed. The
            // ICU plural shim is still deferred; for now the audit-tab
            // caller picks between the two keys based on count.
            row_count:      '{n} entries',
            row_count_one:  '{n} entry',
        },

        // beta.3.15 — producer_binding.* strings block deleted. Its only
        // consumer was components/producer-identity.js, which was dropped
        // in beta.3.15 (CR Council / DID content on the dashboard violated
        // operator preference; the component was loaded but never mounted
        // on Beta 3's _showDashboard anyway). If a future binding-status
        // card is needed, resurrect these keys from git history.

        // BP-E — tech_maintenance.* string block retired with technical-
        // view.js. The Maintenance section (compact logs / reactivate
        // BPoS / re-bootstrap chain data) is dropped from Beta 3 entirely;
        // BPoS reactivation now goes through .enm-bpos-card. Re-bootstrap
        // + compact-logs may return as standalone Settings actions in a
        // post-beta.3 release. If/when they do, ressurect this block from
        // git history (was at this location pre-BP-E).

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
            // alpha.28.1 batch 82 — tools-update MODAL strings. The
            // modal is the "View update command" overlay that operators
            // open from the Update button on the resting card. Strings
            // cover: heading, lead paragraph, the two action buttons,
            // the explainer disclosure + its four li items, and the
            // release-notes label. {version} fills with env.latest;
            // {githubLink} carries the full <a href> markup so the
            // surrounding prose stays localisable while the link stays
            // intact.
            modal_heading:         'Update to {version}',
            modal_lead:            "Run this on the host that runs your PC2 server (where ENM's files live):",
            modal_close_aria:      'Close',
            modal_auto_fill_btn:   'Auto-fill my token',
            modal_copy_btn:        'Copy command',
            modal_copy_btn_aria:   'Copy update shell command',
            modal_explainer_label: 'What does this do?',
            modal_step_download:   'Downloads ela {version} from GitHub.',
            modal_step_uninstall:  'Uninstalls the old ENM bundle via <code>DELETE /api/installed-apps</code> (chain data + keystore safe under <code>extensions/elastos-node-manager/</code>).',
            modal_step_reinstall:  'Reinstalls with the new binary; pc2-node spawns it under the supervisor.',
            modal_step_healthcheck:"Health-checks for 24s; auto-rollback if the new binary doesn't come up.",
            modal_release_notes:   'Release notes: {githubLink}',
        },

        // alpha.28.1 batch 84 — setup-conversation clock-skew block
        // (the last hardcoded English block on the wizard path).
        // Three visual severities (skipped / out-of-sync / in-sync)
        // each with a title, sub, detail card, and 1-2 action buttons.
        // {skewSeconds}, {direction}, {reason}, {absMs}, {source}
        // tokens carry runtime values.
        clock_skew: {
            skipped_title:     'Clock check skipped',
            skipped_sub:       'We could not reach a time server to verify your host clock. If your host clock is wrong, DPoS signatures will be silently rejected.',
            skipped_card_title:'Could not verify NTP',
            // {reason} carries the network error string already
            // surfaced by the backend; splice raw via escapeHtml at
            // the call site so a malicious shape can't inject markup.
            skipped_card_body: 'Reason: {reason}. Make sure your host has NTP running before going live: <code>sudo timedatectl set-ntp true</code>.',
            skipped_cta_continue: 'Continue anyway',
            skipped_cta_retry: 'Retry check',
            out_of_sync_title: 'Host clock is out of sync',
            out_of_sync_sub:   'Your server clock is {skewSeconds}s {direction} internet time. DPoS will reject your signatures and you will score missed-vote penalties.',
            direction_ahead:   'ahead of',
            direction_behind:  'behind',
            out_card_title:    'Fix this before continuing',
            out_card_body:     'Run this on the host, then press Retry:<pre class="enm-clock-fix"><code>sudo timedatectl set-ntp true</code></pre>After NTP catches up (usually &lt;30s), retry the check.',
            out_cta_retry:     'Retry check',
            out_cta_override:  'Continue anyway (not recommended)',
            ok_title:          'Clock is in sync',
            ok_sub:            'Your host clock matches internet time within the safe window.',
            // {absMs} is the absolute skew in milliseconds (formatted
            // by enmFormatNumber at the call site so locale grouping
            // applies).
            ok_card_title:     '±{absMs}ms',
            // {source} is the upstream time server's hostname.
            ok_card_body:      'Measured against {source}. DPoS signing windows are 4 s wide, so you have plenty of margin.',
            ok_default_source: 'an internet time source',
            ok_cta_continue:   'Continue',
            ok_cta_recheck:    'Recheck',
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

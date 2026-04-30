/*
 * Copyright (C) 2026-present Elacity
 * SPDX-License-Identifier: AGPL-3.0
 *
 * STRINGS + enmT() tests — pure JS, no DOM. Loads the public/js/strings.js
 * file by injecting a globalThis stub and `require`-ing the script via a
 * small wrapper. Mirrors how the file ships in the browser.
 */

/* eslint-disable strict */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

import { describe, it, expect, beforeAll } from 'vitest';
const fs = require('node:fs');
const path = require('node:path');

let enmT;
let STRINGS;

beforeAll(() => {
    // The script attaches to a `root` (window || globalThis). Run it inline.
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'public', 'js', 'strings.js'),
        'utf8',
    );
    // eslint-disable-next-line no-new-func
    const f = new Function('window', src);
    const win = {};
    f(win);
    enmT = win.enmT;
    STRINGS = win.ENM_STRINGS;
});

describe('STRINGS / enmT', () => {
    it('exposes enmT and ENM_STRINGS on the window', () => {
        expect(typeof enmT).toBe('function');
        expect(typeof STRINGS).toBe('object');
        expect(STRINGS.app.title).toBe('Elastos Node Manager');
    });

    it('looks up nested keys', () => {
        expect(enmT('app.title')).toBe('Elastos Node Manager');
        expect(enmT('chain_state.healthy')).toBe('Healthy');
        expect(enmT('common.cancel')).toBe('Cancel');
    });

    it('substitutes {placeholder} tokens', () => {
        const out = enmT('chain_actions.confirm_stop', { chainName: 'mainchain' });
        expect(out).toBe('Stop mainchain?');
    });

    it('leaves unknown placeholders intact', () => {
        const out = enmT('chain_actions.confirm_stop', {});
        expect(out).toBe('Stop {chainName}?');
    });

    it('returns [bracketed-key] on missing key', () => {
        expect(enmT('totally.does.not.exist')).toBe('[totally.does.not.exist]');
    });

    it('returns empty string for non-string key', () => {
        expect(enmT('')).toBe('');
        expect(enmT(null)).toBe('');
        expect(enmT(undefined)).toBe('');
    });

    it('every wizard step has a label', () => {
        // 9 steps after Phase 6 keystore + network + confirm expansion.
        ['os', 'disk', 'wallet', 'binary', 'keystore', 'network', 'confirm', 'complete']
            .forEach((step) => {
                expect(typeof STRINGS.wizard['step_' + step]).toBe('string');
            });
    });

    it('wizard keystore + network + confirm fields are present', () => {
        const required = [
            'keystore_arbiter_label', 'keystore_path_label', 'keystore_path_placeholder',
            'keystore_password_label', 'keystore_help', 'keystore_save_btn',
            'keystore_skip_btn', 'keystore_ok', 'keystore_fail',
            'network_help', 'network_save_btn', 'network_detect_btn',
            'confirm_heading', 'confirm_role_arbiter', 'confirm_role_full',
            'confirm_binary', 'confirm_ip',
            'confirm_start_btn', 'confirm_finishing', 'confirm_complete_no_start',
        ];
        required.forEach((k) => {
            expect(typeof STRINGS.wizard[k]).toBe('string');
        });
    });

    it('every chain state in CHAIN_STATES has a label', () => {
        const states = ['healthy', 'syncing', 'stalled', 'stopped', 'error', 'recovering', 'unconfigured', 'disabled'];
        states.forEach((s) => {
            expect(typeof STRINGS.chain_state[s]).toBe('string');
        });
    });

    it('every system_status field has a label (drives the top status bar)', () => {
        ['cpu', 'mem', 'disk', 'os', 'uptime'].forEach((k) => {
            expect(typeof STRINGS.system_status[k]).toBe('string');
        });
    });

    it('every settings tab field has a label (Phase 5)', () => {
        const required = [
            'heading_network', 'heading_advanced', 'heading_general',
            'ip_label', 'ip_mode_auto', 'ip_mode_manual',
            'ip_help', 'ip_detect_btn', 'ip_save_btn',
            'adv_log_level', 'adv_archive_mode', 'adv_memory_limit',
            'adv_rpc_user', 'adv_rpc_password', 'adv_white_ip', 'adv_save_btn',
            'general_auto_safe', 'general_audit_retention',
            'general_critical_ack', 'general_save_btn',
            'saved', 'save_failed',
        ];
        required.forEach((k) => {
            expect(typeof STRINGS.settings[k]).toBe('string');
        });
    });

    it('every audit tab field has a label (Phase 5)', () => {
        const required = [
            'heading', 'filter_chain', 'filter_tier', 'filter_from', 'filter_to',
            'apply_filter', 'export_btn', 'empty',
            'col_ts', 'col_chain', 'col_rule', 'col_tier', 'col_decision',
            'col_executor', 'col_outcome', 'tier_any',
            'load_more', 'load_more_capped',
        ];
        required.forEach((k) => {
            expect(typeof STRINGS.audit[k]).toBe('string');
        });
    });

    it('chain_card BPoS keys present (Phase 5)', () => {
        ['bpos_heading', 'bpos_state', 'bpos_votes', 'bpos_rank', 'bpos_inactive_rounds']
            .forEach((k) => {
                expect(typeof STRINGS.chain_card[k]).toBe('string');
            });
    });

    it('STRINGS object is frozen (immutable)', () => {
        expect(() => { STRINGS.app.title = 'tampered'; }).toThrow();
    });
});

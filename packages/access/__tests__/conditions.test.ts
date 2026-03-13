import { describe, it, expect } from 'vitest';
import {
  buildAccessTokenCondition,
  buildCreatorOrAccessCondition,
} from '../src/lit/conditions.js';

const MOCK_LEDGER = '0x1234567890abcdef1234567890abcdef12345678';
const MOCK_TOKEN_ID = '42';
const MOCK_CREATOR = '0xABCDEF1234567890ABCDEF1234567890ABCDEF12';

describe('buildAccessTokenCondition', () => {
  it('returns a single ERC-1155 balanceOf condition', () => {
    const conditions = buildAccessTokenCondition(MOCK_LEDGER, MOCK_TOKEN_ID);

    expect(conditions).toHaveLength(1);
    expect(conditions[0].conditionType).toBe('evmContract');
    expect(conditions[0].contractAddress).toBe(MOCK_LEDGER);
    expect(conditions[0].functionName).toBe('balanceOf');
  });

  it('uses Base chain by default', () => {
    const conditions = buildAccessTokenCondition(MOCK_LEDGER, MOCK_TOKEN_ID);
    expect(conditions[0].chain).toBe('base');
  });

  it('accepts a custom chain override', () => {
    const conditions = buildAccessTokenCondition(MOCK_LEDGER, MOCK_TOKEN_ID, 'ethereum');
    expect(conditions[0].chain).toBe('ethereum');
  });

  it('places :userAddress and tokenId as function params', () => {
    const conditions = buildAccessTokenCondition(MOCK_LEDGER, MOCK_TOKEN_ID);
    expect(conditions[0].functionParams).toEqual([':userAddress', MOCK_TOKEN_ID]);
  });

  it('has correct ABI shape for ERC-1155 balanceOf', () => {
    const conditions = buildAccessTokenCondition(MOCK_LEDGER, MOCK_TOKEN_ID);
    const abi = conditions[0].functionAbi;

    expect(abi.name).toBe('balanceOf');
    expect(abi.stateMutability).toBe('view');
    expect(abi.type).toBe('function');
    expect(abi.inputs).toEqual([
      { name: 'account', type: 'address' },
      { name: 'id', type: 'uint256' },
    ]);
    expect(abi.outputs).toEqual([
      { name: 'balance', type: 'uint256' },
    ]);
  });

  it('requires balance > 0', () => {
    const conditions = buildAccessTokenCondition(MOCK_LEDGER, MOCK_TOKEN_ID);
    expect(conditions[0].returnValueTest).toEqual({
      key: '',
      comparator: '>',
      value: '0',
    });
  });
});

describe('buildCreatorOrAccessCondition', () => {
  it('returns two conditions (ACCESS_TOKEN + creator wallet)', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    expect(conditions).toHaveLength(2);
  });

  it('first condition is the standard ACCESS_TOKEN check', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    expect(conditions[0].conditionType).toBe('evmContract');
    expect(conditions[0].functionName).toBe('balanceOf');
  });

  it('second condition is an evmBasic wallet ownership check', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    expect(conditions[1].conditionType).toBe('evmBasic');
    expect(conditions[1].returnValueTest.comparator).toBe('=');
  });

  it('lowercases the creator address for comparison', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    expect(conditions[1].returnValueTest.value).toBe(MOCK_CREATOR.toLowerCase());
  });

  it('propagates custom chain to both conditions', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR, 'polygon'
    );
    expect(conditions[0].chain).toBe('polygon');
    expect(conditions[1].chain).toBe('polygon');
  });
});

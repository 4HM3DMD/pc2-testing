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
  it('returns three elements: condition + OR operator + condition', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    expect(conditions).toHaveLength(3);
  });

  it('first element is the standard ACCESS_TOKEN check', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    const first = conditions[0] as ReturnType<typeof buildAccessTokenCondition>[0];
    expect(first.conditionType).toBe('evmContract');
    expect(first.functionName).toBe('balanceOf');
  });

  it('second element is the OR operator (required by Lit Protocol)', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    expect(conditions[1]).toEqual({ operator: 'or' });
  });

  it('third element is an evmBasic wallet ownership check', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    const third = conditions[2] as ReturnType<typeof buildAccessTokenCondition>[0];
    expect(third.conditionType).toBe('evmBasic');
    expect(third.returnValueTest.comparator).toBe('=');
  });

  it('lowercases the creator address for comparison', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR
    );
    const third = conditions[2] as ReturnType<typeof buildAccessTokenCondition>[0];
    expect(third.returnValueTest.value).toBe(MOCK_CREATOR.toLowerCase());
  });

  it('propagates custom chain to both conditions', () => {
    const conditions = buildCreatorOrAccessCondition(
      MOCK_LEDGER, MOCK_TOKEN_ID, MOCK_CREATOR, 'polygon'
    );
    const first = conditions[0] as ReturnType<typeof buildAccessTokenCondition>[0];
    const third = conditions[2] as ReturnType<typeof buildAccessTokenCondition>[0];
    expect(first.chain).toBe('polygon');
    expect(third.chain).toBe('polygon');
  });
});

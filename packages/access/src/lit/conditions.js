import { BASE_CHAIN_NAME } from '../constants.js';
export function buildAccessTokenCondition(ledger, tokenId, chain) {
    return [
        {
            conditionType: 'evmContract',
            contractAddress: ledger,
            chain: chain ?? BASE_CHAIN_NAME,
            functionName: 'balanceOf',
            functionParams: [':userAddress', tokenId],
            functionAbi: {
                name: 'balanceOf',
                inputs: [
                    { name: 'account', type: 'address' },
                    { name: 'id', type: 'uint256' },
                ],
                outputs: [
                    { name: 'balance', type: 'uint256' },
                ],
                stateMutability: 'view',
                type: 'function',
            },
            returnValueTest: {
                key: '',
                comparator: '>',
                value: '0',
            },
        },
    ];
}
export function buildCreatorOrAccessCondition(ledger, tokenId, creatorAddress, chain) {
    const accessCondition = buildAccessTokenCondition(ledger, tokenId, chain);
    return [
        ...accessCondition,
        { operator: 'or' },
        {
            conditionType: 'evmBasic',
            contractAddress: '',
            chain: chain ?? BASE_CHAIN_NAME,
            functionName: '',
            functionParams: [':userAddress'],
            functionAbi: {
                name: '',
                inputs: [],
                outputs: [],
                stateMutability: 'view',
                type: 'function',
            },
            returnValueTest: {
                key: '',
                comparator: '=',
                value: creatorAddress.toLowerCase(),
            },
        },
    ];
}
//# sourceMappingURL=conditions.js.map
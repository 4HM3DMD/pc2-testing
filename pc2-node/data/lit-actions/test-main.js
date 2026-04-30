async function main(params) {
  const info = {
    paramsType: typeof params,
    paramsKeys: params ? Object.keys(params) : [],
    hasJsParams: typeof jsParams !== "undefined",
    hasLit: typeof Lit !== "undefined",
    hasEthers: typeof ethers !== "undefined",
    receivedParams: params
  };
  Lit.Actions.setResponse({ response: JSON.stringify(info) });
}

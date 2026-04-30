(this["webpackJsonpglide-frontend"]=this["webpackJsonpglide-frontend"]||[]).push([[11],{1250:function(e,t,n){"use strict";n.r(t),n.d(t,"default",function(){return Ut});var c=n(1),r=n.n(c),i=n(3),o=n(5),s=n(2),a=n(7),l=n(166),d=n(13),b=n(85),j={"1_20":{native:{1:{contract:"0xf127003ea39878EFeEE89aA4E22248CC6cb7728E",minTx:.1,maxTx:15e5,fee:.1},20:{contract:"0x314dfec1Fb4de1e0Be70F260d0a065E497f7E2eB",minTx:100,maxTx:75e4,fee:.1}},token:{1:{contract:"0xfBec16ac396431162789FF4b5f65F47978988D7f",minTx:.5,maxTx:75e5,fee:0},20:{contract:"0xe6fd75ff38Adca4B97FBCD938c86b98772431867",minTx:.5,maxTx:75e5,fee:0}}},"20_1":{native:{1:{contract:"0x88723077663F9e24091D2c30c2a2cE213d9080C6",minTx:.1,maxTx:75e4,fee:.1},20:{contract:"0xE235CbC85e26824E4D855d4d0ac80f3A85A520E4",minTx:100,maxTx:15e5,fee:.1}},token:{1:{contract:"0x6Ae6B30F6bb361136b0cC47fEe25E44B7d58605c",minTx:.5,maxTx:75e5,fee:1},20:{contract:"0x0054351c99288D37B96878EDC2319ca006c8B910",minTx:.5,maxTx:75e5,fee:1}}},"128_20":{native:{20:{contract:"0x5e071258254c85B900Be01F6D7B3f8F34ab219e7",minTx:.1,maxTx:75e4,fee:.1},128:{contract:"0x4490ee96671855BD0a52Eb5074EC5569496c0162",minTx:.1,maxTx:15e5,fee:.1}},token:{20:{contract:"0x6683268d72eeA063d8ee17639cC9B7C317d1734a",minTx:.5,maxTx:75e4,fee:0},128:{contract:"0x323b5913dadd3e61e5242Fe44781cb7Dd4BE7EB8",minTx:.5,maxTx:75e4,fee:0}}},"20_128":{native:{20:{contract:"0x74efe86928abe5bCD191f2e6C85b01861ea1C17d",minTx:.1,maxTx:4e4,fee:.1},128:{contract:"0x5acCF25F5722A6ed0606C02AA5d8cFe27F346e1B",minTx:.1,maxTx:75e4,fee:.1}},token:{20:{contract:"0x59F65A3913F1FFcE7aB684bd8c24ba3790bD376B",minTx:.5,maxTx:75e4,fee:0},128:{contract:"0x3394577F74B86b9FD4D6e1D8a66c668bC6188379",minTx:.5,maxTx:75e4,fee:0}}},"20_56":{native:{20:{contract:"0x1135BB7CEc7980f0d65741Def1e8Ab054AB4d651",minTx:200,maxTx:75e4,fee:.1},56:{contract:"0x6EA7481f1096E822574a54188578d1708F64C828",minTx:2,maxTx:75e4,fee:.1}},token:{20:{contract:"0xfBeAFe09cC2C3B9A73A8bFDA46896D1302a90F0c",minTx:200,maxTx:75e4,fee:.1},56:{contract:"0x4Ca8abd60D88a0C35071d535e26E1cB2928fC45C",minTx:2,maxTx:75e4,fee:.1}}},"56_20":{native:{20:{contract:"0x680424c82208DB896EdC78DD79a0a352468dd3DF",minTx:200,maxTx:75e4,fee:.1},56:{contract:"0x5a70075aC335c8e99BF8c27760dD1001190A8032",minTx:2,maxTx:75e4,fee:.1}},token:{20:{contract:"0x11262aB418C2d2926F5afb1e3D6e88d86B3C9017",minTx:.5,maxTx:1e6,fee:0},56:{contract:"0x3174937C38ba343faBAC64b51a9C91b3e261BBEd",minTx:.5,maxTx:1e6,fee:0}}}},u=n(142),x=n(6),h=n.n(x),m=n(27),O=n(71),p=n(30),g=n(51),f=n(187);const v=(e,t)=>{if(!e)return window.BigInt(0);const n=Number(e),c=(e=>Math.floor(e)===e?0:e.toString().split(".")[1].length||0)(n),r=window.BigInt(10**Number(t));return window.BigInt(Math.floor(n*10**c))*r/window.BigInt(10**c)},y=async e=>await e.getGasPrice();var T=n(399),w=n(33),C=n(10),k=n(794);const E=e=>new Promise(t=>setTimeout(t,e)),S=async(e,t,n,c,r,i,o)=>{try{const s=await fetch(`${k.b}/faucet/${c}`);if(s.ok){if(!1===(await s.json()).has_use_faucet){const s=await fetch(`${k.b}/faucet`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({txID:e,chainID:n,address:c,type:t})});s.ok?(await s.json(),await E(5e3),r(o("0.01 ELA received from gas faucet!"))):(await s.json(),await E(5e3),i(o("Error receiving faucet distribution")))}}}catch(s){console.error(JSON.stringify(s))}};var I=n(355);const _=e=>new Promise(t=>setTimeout(t,e)),A=async function(e,t,n,c,r,i,o,s,a,l,d,b,j,u,x){const h=new O.a.providers.JsonRpcProvider(T.b[d]),m=await h.getBlockNumber(),g=o,f=o,v=Object(C.e)(n,e.decimals).toString();if("token"===c&&a){const n="relayTokens",h=R(e.address,e.chainId)?r.contract:t.contract,O=R(e.address,e.chainId)?i.contract:b.contract,T=Object(p.x)(h,s.getSigner(o)),w=await y(s.getSigner(o)),C=await T["relayTokens(address,address,uint256)"](e.address,f,v,{from:g,gasPrice:w});await C.wait(1),j(x("Bridging in process. Awaiting relay from mediator.")),20===d&&S(C.hash,n,l,f,j,u,x),await P(o,c,l,d,O,b,C.hash,a,j,u,x,m)}else if("native"===c&&a){const t="transferAndCall",n=Object(p.m)(e.address,s.getSigner(o)),h=await y(s.getSigner(o)),O=await n["transferAndCall(address,uint256,bytes)"](r.contract,v,g,{from:g,gasPrice:h.toString()});await O.wait(1),j(x("Bridging in process. Awaiting relay from mediator.")),20===d&&S(O.hash,t,l,f,j,u,x),await P(o,c,l,d,i.contract,b,O.hash,a,j,u,x,m)}else{const e="relayTokens",n=Object(p.x)(t.contract,s.getSigner(o)),r=await n["relayTokens(address)"](f,{from:g,value:v});await r.wait(1),j(x("Bridging in process. Awaiting relay from mediator.")),20===d&&S(r.hash,e,l,f,j,u,x),await P(o,c,l,d,b.contract,b,r.hash,a,j,u,x,m)}},P=async function(e,t,n,c,r,i,o,s,a,l,d,b){const j=new O.a.providers.JsonRpcProvider(T.b[c]);let u,x,h;"native"===t?(u=Object(p.x)(r,j),x=O.a.utils.id("TokensBridged(address,uint256,bytes32)"),h=0):(u=Object(p.H)(r,j),x=O.a.utils.id("TokensBridged(address,address,uint256,bytes32)"),h=1);const m=Date.now()+w.w;for(;Date.now()<=m;){const t=await j.getBlockNumber();if((await u.queryFilter({address:i.contract,topics:[x]},b,t)).filter(t=>t.args[h]===e).length>0)return void a(d("Transfer complete! You can now use your assets on the destination network."));Date.now()+177e3<m&&Date.now()+183e3>m&&a("Spinning, spinning, spinning..."),Date.now()+117e3<m&&Date.now()+123e3>m&&a("Ugh how long does this take?"),Date.now()+57e3<m&&Date.now()+63e3>m&&a("We'll give it one more minute"),await _(5e3)}Date.now()>m&&l("Bridge completion event not detected within 5 minutes. Please monitor block explorer for receipt.")},R=function(e,t){const n=I.tokens.filter(t=>t.address===e)[0],{origin:c}=n;return c!==t};var U=n(60),B=n(11),N=n(29),$=n(0);const D=i.e.div`
  position: relative;
  padding: 0 1rem 1rem 1rem;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    padding: 0 2rem 2rem 2rem;
  }
`,L=i.e.div`
  padding: 2px;

  ${e=>{let{clickable:t}=e;return t?i.d`
          :hover {
            cursor: pointer;
            opacity: 0.8;
          }
        `:null}}
`;Object(i.e)(s.xb)`
  color: ${e=>{let{theme:t,severity:n}=e;return 3===n||4===n?t.colors.failure:2===n?t.colors.warning:1===n?t.colors.text:t.colors.success}};
`,i.e.button`
  height: 22px;
  width: 22px;
  background-color: ${e=>{let{theme:t}=e;return t.colors.background}};
  border: none;
  border-radius: 50%;
  padding: 0.2rem;
  font-size: 0.875rem;
  font-weight: 400;
  margin-left: 0.4rem;
  cursor: pointer;
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
  display: flex;
  justify-content: center;
  align-items: center;
  float: right;

  :hover {
    background-color: ${e=>{let{theme:t}=e;return t.colors.dropdown}};
  }
  :focus {
    background-color: ${e=>{let{theme:t}=e;return t.colors.dropdown}};
    outline: none;
  }
`,Object(i.e)(s.xb).attrs({ellipsis:!0})`
  width: 220px;
`,i.e.div`
  background-color: ${e=>{let{theme:t}=e;return`${t.colors.failure}33`}};
  border-radius: 1rem;
  display: flex;
  align-items: center;
  font-size: 0.825rem;
  width: 100%;
  padding: 3rem 1.25rem 1rem 1rem;
  margin-top: -2rem;
  color: ${e=>{let{theme:t}=e;return t.colors.failure}};
  z-index: -1;
  p {
    padding: 0;
    margin: 0;
    font-weight: 500;
  }
`,i.e.div`
  background-color: ${e=>{let{theme:t}=e;return`${t.colors.failure}33`}};
  display: flex;
  align-items: center;
  justify-content: center;
  margin-right: 12px;
  border-radius: 12px;
  min-width: 48px;
  height: 48px;
`;Object(i.e)(N.a)`
  background-color: ${e=>{let{theme:t}=e;return`${t.colors.warning}33`}};
  padding: 0.5rem;
  border-radius: 12px;
  margin-top: 8px;
`;const F=i.e.div`
  width: 100%;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0px 16px;
  box-shadow: ${e=>{let{theme:t}=e;return t.shadows.inset}};
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.inputSecondary}};
  border-radius: 16px;
  background: ${e=>{let{theme:t}=e;return t.colors.input}};
  transition: border-radius 0.15s;
`,H=i.e.div`
  min-width: 112px;
  height: 0;
  position: absolute;
  overflow: hidden;
  background: ${e=>{let{theme:t}=e;return t.colors.input}};
  z-index: ${e=>{let{theme:t}=e;return t.zIndices.dropdown}};
  transition: transform 0.15s, opacity 0.15s;
  transform: scaleY(0);
  transform-origin: top;
  opacity: 0;
  width: 100%;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    min-width: 136px;
  }
`,M=i.e.div`
  cursor: pointer;
  width: ${e=>{let{width:t}=e;return t}}px;
  position: relative;
  background: ${e=>{let{theme:t}=e;return t.colors.input}};
  border-radius: 16px;
  height: 40px;
  min-width: 112px;
  user-select: none;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    min-width: 136px;
  }

  ${e=>e.isOpen&&i.d`
      ${F} {
        border-bottom: 1px solid ${e=>{let{theme:t}=e;return t.colors.inputSecondary}};
        box-shadow: ${e=>{let{theme:t}=e;return t.tooltip.boxShadow}};
        border-radius: 16px 16px 0 0;
      }

      ${H} {
        height: auto;
        transform: scaleY(1);
        opacity: 1;
        border: 1px solid ${e=>{let{theme:t}=e;return t.colors.inputSecondary}};
        border-top-width: 0;
        border-radius: 0 0 16px 16px;
        box-shadow: ${e=>{let{theme:t}=e;return t.tooltip.boxShadow}};
      }
    `}

  svg {
    position: absolute;
    right: 16px;
    top: 50%;
    transform: translateY(-50%);
  }
`,W=i.e.ul`
  padding: 0;
  margin: 0;
  box-sizing: border-box;
  z-index: ${e=>{let{theme:t}=e;return t.zIndices.dropdown}};
`,z=i.e.li`
  list-style: none;
  padding: 8px 16px;
  &:hover {
    background: ${e=>{let{theme:t}=e;return t.colors.inputSecondary}};
  }
`;var K=e=>{let{options:t,onChange:n,chainIndex:r}=e;const i=Object(c.useRef)(null),o=Object(c.useRef)(null),[a,l]=Object(c.useState)(!1),[d,b]=Object(c.useState)({width:0,height:0}),j=e=>{l(!a),e.stopPropagation()};return Object(c.useEffect)(()=>{b({width:o.current.offsetWidth,height:o.current.offsetHeight});const e=()=>{l(!1)};return document.addEventListener("click",e),()=>{document.removeEventListener("click",e)}},[]),Object($.jsxs)(M,{isOpen:a,ref:i,...d,children:[0!==d.width&&Object($.jsx)(F,{onClick:j,children:Object($.jsx)(s.xb,{children:t[r].label})}),Object($.jsx)(s.d,{color:"text",onClick:j}),Object($.jsx)(H,{children:Object($.jsx)(W,{ref:o,children:t.map((e,c)=>{return c!==r?Object($.jsx)(z,{onClick:(i=c,()=>{l(!1),n&&n(t[i])}),children:Object($.jsx)(s.xb,{children:e.label})},e.label):null;var i})})})]})},V=n(93),q=n(247),J=n(121),Y=n(49),Q=n(32),G=n(20),X=n(427),Z=n(62),ee=n(43),te=n(189);function ne(e){return e instanceof o.j?e.address:e===o.d?"ETHER":""}const ce=Object(i.e)(s.xb)`
  white-space: nowrap;
  overflow: hidden;
  max-width: 5rem;
  text-overflow: ellipsis;
`;function re(e){let{balance:t}=e;return Object($.jsx)(ce,{title:t.toExact(),children:t.toSignificant(4)})}const ie=Object(i.e)(G.b)`
  padding: 4px 28px;
  height: 56px;
  display: grid;
  grid-template-columns: auto minmax(auto, 1fr) minmax(0, 72px);
  grid-gap: 8px;
  cursor: ${e=>{let{disabled:t}=e;return!t&&"pointer"}};
  pointer-events: ${e=>{let{disabled:t}=e;return t&&"none"}};
  :hover {
    background-color: ${e=>{let{theme:t,disabled:n}=e;return!n&&t.colors.background}};
  }
  opacity: ${e=>{let{disabled:t,selected:n}=e;return t||n?.5:1}};
`;function oe(e){let{origin:t,currency:n,onSelect:c,isSelected:r,otherSelected:i,style:o}=e;const{t:l}=Object(a.b)(),{account:d}=Object(B.a)(),b=ne(n),j=Object(Z.e)(),u=Object(Q.i)(j,n),x=Object(Y.g)(n),h=Object(V.b)(null!==d&&void 0!==d?d:void 0,n),m=n?Object.prototype.hasOwnProperty.call(n,"address"):void 0;return Object($.jsxs)(ie,{style:o,className:`token-item-${b}`,onClick:()=>r?null:c(),disabled:r,selected:i,children:[Object($.jsx)(ee.a,{currency:n,size:"24px",style:{marginRight:"8px"},chain:t}),Object($.jsxs)(N.c,{children:[Object($.jsx)(s.xb,{bold:!0,children:m?n.symbol:20===t?"ELA":1===t?"ETH":128===t?"HT":56===t&&"BNB"}),Object($.jsxs)(s.xb,{color:"textSubtle",small:!0,ellipsis:!0,maxWidth:"200px",children:[!u&&x&&l("Added by user"),"\u2022 ",m?n.name:20===t?"Elastos":1===t?"Ethereum":128===t?"Huobi Token":56===t&&"Binance Coin"]})]}),Object($.jsx)(G.c,{style:{justifySelf:"flex-end"},children:h?Object($.jsx)(re,{balance:h}):d?Object($.jsx)(te.a,{}):null})]})}function se(e){let{origin:t,height:n,currencies:r,selectedCurrency:i,onCurrencySelect:s,otherCurrency:a,fixedListRef:l,showETH:d,breakIndex:b}=e;const j=Object(c.useMemo)(()=>{let e=d?[o.b.ETHER,...r]:r;return void 0!==b&&(e=[...e.slice(0,b),void 0,...e.slice(b,e.length)]),e},[b,r,d]),u=Object(c.useCallback)(e=>{let{data:n,index:c,style:r}=e;const l=n[c],d=Boolean(i&&Object(o.o)(i,l)),b=Boolean(a&&Object(o.o)(a,l));return Object($.jsx)(oe,{origin:t,style:r,currency:l,isSelected:d,onSelect:()=>s(l),otherSelected:b})},[t,s,a,i]),x=Object(c.useCallback)((e,t)=>ne(t[e]),[]);return Object($.jsx)(X.a,{height:n,ref:l,width:"100%",itemData:j,itemCount:j.length,itemSize:56,itemKey:x,children:u})}function ae(e,t){return Object(c.useMemo)(()=>{if(!e)return[];const n=t.toLowerCase().split(/\s+/).filter(e=>e.length>0);if(n.length>1)return e;const c=[],r=[],i=[];return e.map(e=>{var o,s;return(null===(o=e.symbol)||void 0===o?void 0:o.toLowerCase())===n[0]?c.push(e):null!==(s=e.symbol)&&void 0!==s&&s.toLowerCase().startsWith(t.toLowerCase().trim())?r.push(e):i.push(e)}),[...c,...r,...i]},[e,t])}var le=function(e){const t=Object(V.a)(),n=Object(c.useMemo)(()=>function(e){return function(t,n){const c=(r=e[t.address],i=e[n.address],r&&i?r.greaterThan(i)?-1:r.equalTo(i)?0:1:r&&r.greaterThan("0")?-1:i&&i.greaterThan("0")?1:0);var r,i;return 0!==c?c:t.symbol&&n.symbol?t.symbol.toLowerCase()<n.symbol.toLowerCase()?-1:1:t.symbol||n.symbol?-1:0}}(null!==t&&void 0!==t?t:{}),[t]);return Object(c.useMemo)(()=>e?(e,t)=>-1*n(e,t):n,[e,n])};var de=function(e){let{origin:t,destination:n,selectedCurrency:r,onCurrencySelect:i,otherSelectedCurrency:l}=e;const{t:d}=Object(a.b)(),b=Object(c.useRef)(),[j,u]=Object(c.useState)(""),x=Object(J.a)(j,200),[h]=Object(c.useState)(!1),m=Object(Y.c)(t,n),O=Object(c.useMemo)(()=>{const e=x.toLowerCase().trim();return""===e||"e"===e||"el"===e||"ela"===e},[x]),p=le(h),g=Object(c.useMemo)(()=>function(e,t){if(0===t.length)return e;const n=Object(Q.h)(t);if(n)return e.filter(e=>e.address===n);const c=t.toLowerCase().split(/\s+/).filter(e=>e.length>0);if(0===c.length)return e;const r=e=>{const t=e.toLowerCase().split(/\s+/).filter(e=>e.length>0);return c.every(e=>0===e.length||t.some(t=>t.startsWith(e)||t.endsWith(e)))};return e.filter(e=>{const{symbol:t,name:n}=e;return t&&r(t)||n&&r(n)})}(Object.values(m),x),[m,x]),f=ae(Object(c.useMemo)(()=>g.sort(p),[g,p]),x),v=Object(c.useCallback)(e=>{i(e)},[i]),y=Object(c.useRef)();Object(c.useEffect)(()=>{y.current.focus()},[]);const T=Object(c.useCallback)(e=>{var t;const n=e.target.value,c=Object(Q.h)(n);u(c||n),null===(t=b.current)||void 0===t||t.scrollTo(0)},[]),w=Object(c.useCallback)(e=>{if("Enter"===e.key){if("ela"===x.toLowerCase().trim())v(o.d);else if(f.length>0){var t;(null===(t=f[0].symbol)||void 0===t?void 0:t.toLowerCase())!==x.trim().toLowerCase()&&1!==f.length||v(f[0])}}},[f,v,x]),C=Object(Y.e)(x),k=ae(C,x);return Object($.jsx)($.Fragment,{children:Object($.jsxs)("div",{children:[Object($.jsx)(N.a,{gap:"16px",children:Object($.jsx)(G.d,{children:Object($.jsx)(s.V,{id:"token-search-input",placeholder:d("Search by name"),scale:"lg",autoComplete:"off",value:j,ref:y,onChange:T,onKeyDown:w})})}),(null===f||void 0===f?void 0:f.length)>0||(null===k||void 0===k?void 0:k.length)>0?Object($.jsx)(s.j,{margin:"24px -24px",children:Object($.jsx)(se,{height:390,origin:t,showETH:O,currencies:k?f.concat(k):f,breakIndex:C&&f?f.length:void 0,onCurrencySelect:v,otherCurrency:l,selectedCurrency:r,fixedListRef:b})}):Object($.jsx)(N.c,{style:{padding:"20px",height:"100%"},children:Object($.jsx)(s.xb,{color:"textSubtle",textAlign:"center",mb:"20px",children:d("No results found.")})})]})})},be=n(50);var je=function(e){let{tokens:t,handleCurrencySelect:n}=e;const{chainId:r}=Object(B.a)(),{t:i}=Object(a.b)(),[o,l]=Object(c.useState)(!1),d=Object(be.b)(),b=Object(Z.f)();return Object($.jsxs)(N.a,{gap:"lg",children:[Object($.jsx)(s.bb,{variant:"warning",children:Object($.jsxs)(s.xb,{children:[i("Anyone can create an ERC-20 token on ESC with any name, including creating fake versions of existing tokens and tokens that claim to represent projects that do not have a token."),Object($.jsx)("br",{}),Object($.jsx)("br",{}),i("If you purchase an arbitrary token, you may be unable to sell it back.")]})}),t.map(e=>{var t,n;const c=r&&(null===b||void 0===b||null===(t=b[r])||void 0===t||null===(n=t[e.address])||void 0===n?void 0:n.list),o=e.address?`${e.address.substring(0,6)}...${e.address.substring(e.address.length-4)}`:null;return Object($.jsxs)(s.O,{gridTemplateRows:"1fr 1fr 1fr",gridGap:"4px",children:[void 0!==c?Object($.jsxs)(s.wb,{variant:"success",outline:!0,scale:"sm",startIcon:c.logoURI&&Object($.jsx)(ee.c,{logoURI:c.logoURI,size:"12px"}),children:[i("via")," ",c.name]}):Object($.jsx)(s.wb,{variant:"failure",outline:!0,scale:"sm",startIcon:Object($.jsx)(s.J,{color:"failure"}),children:i("Unknown Source")}),Object($.jsxs)(s.M,{alignItems:"center",children:[Object($.jsx)(s.xb,{mr:"8px",children:e.name}),Object($.jsxs)(s.xb,{children:["(",e.symbol,")"]})]}),r&&Object($.jsxs)(s.M,{justifyContent:"space-between",width:"100%",children:[Object($.jsx)(s.xb,{mr:"4px",children:o}),Object($.jsxs)(s.W,{href:Object(Q.e)(e.address,"address",r),external:!0,children:["(",i("View on explorer"),")"]})]})]},e.address)}),Object($.jsxs)(s.M,{justifyContent:"space-between",alignItems:"center",children:[Object($.jsxs)(s.M,{alignItems:"center",onClick:()=>l(!o),children:[Object($.jsx)(s.w,{scale:"sm",name:"confirmed",type:"checkbox",checked:o,onChange:()=>l(!o)}),Object($.jsx)(s.xb,{ml:"8px",style:{userSelect:"none"},children:i("I understand")})]}),Object($.jsx)(s.m,{variant:"danger",disabled:!o,onClick:()=>{t.map(e=>d(e)),n&&n(t[0])},className:".token-dismiss-button",children:i("Import")})]})]})},ue=n(24),xe=n(103),he=n(64),me=n(185),Oe=n(182),pe=n(70),ge=n(146);let fe=function(e){return e[e.search=0]="search",e[e.manage=1]="manage",e[e.importToken=2]="importToken",e[e.importList=3]="importList",e}({});const ve=Object(i.e)(N.c)`
  width: 100%;
  height: 100%;
`,ye=Object(i.e)(G.d)`
  background-color: ${e=>{let{active:t,theme:n}=e;return t?`${n.colors.success}19`:"transparent"}};
  border: solid 1px;
  border-color: ${e=>{let{active:t,theme:n}=e;return t?n.colors.success:n.colors.tertiary}};
  transition: 200ms;
  align-items: center;
  padding: 1rem;
  border-radius: 20px;
`;function Te(e){return`list-row-${e.replace(/\./g,"-")}`}const we=Object(c.memo)(function(e){let{listUrl:t}=e;const n=Object(ue.c)(e=>e.lists.byUrl),r=Object(ue.b)(),{current:i,pendingUpdate:o}=n[t],l=Object(Z.h)(t),{t:d}=Object(a.b)(),b=Object(c.useCallback)(()=>{o&&r(Object(pe.a)(t))},[r,t,o]),j=Object(c.useCallback)(()=>{window.confirm("Please confirm you would like to remove this list")&&r(Object(pe.f)(t))},[r,t]),u=Object(c.useCallback)(()=>{r(Object(pe.d)(t))},[r,t]),x=Object(c.useCallback)(()=>{r(Object(pe.c)(t))},[r,t]),{targetRef:h,tooltip:m,tooltipVisible:O}=Object(s.Qb)(Object($.jsxs)("div",{children:[Object($.jsx)(s.xb,{children:i&&(p=i.version,`v${p.major}.${p.minor}.${p.patch}`)}),Object($.jsx)(s.X,{external:!0,href:`https://tokenlists.org/token-list?url=${t}`,children:d("See")}),Object($.jsx)(s.m,{variant:"danger",scale:"xs",onClick:j,disabled:1===Object.keys(n).length,children:d("Remove")}),o&&Object($.jsx)(s.m,{variant:"text",onClick:b,style:{fontSize:"12px"},children:d("Update list")})]}),{placement:"right-end",trigger:"click"});var p;return i?Object($.jsxs)(ye,{active:l,id:Te(t),children:[O&&m,i.logoURI?Object($.jsx)(ee.c,{size:"40px",style:{marginRight:"1rem"},logoURI:i.logoURI,alt:`${i.name} list logo`}):Object($.jsx)("div",{style:{width:"24px",height:"24px",marginRight:"1rem"}}),Object($.jsxs)(N.c,{style:{flex:"1"},children:[Object($.jsx)(G.d,{children:Object($.jsx)(s.xb,{bold:!0,children:i.name})}),Object($.jsxs)(G.c,{mt:"4px",children:[Object($.jsxs)(s.xb,{fontSize:"12px",mr:"6px",textTransform:"lowercase",children:[i.tokens.length," ",d("Tokens")]}),Object($.jsx)("span",{ref:h,children:Object($.jsx)(s.D,{color:"text",width:"12px"})})]})]}),Object($.jsx)(s.Ab,{checked:l,onChange:()=>{l?x():u()}})]},t):null}),Ce=i.e.div`
  padding: 1rem 0;
  height: 100%;
  overflow: auto;
`;var ke=function(e){let{setModalView:t,setImportList:n,setListUrl:r}=e;const[i,o]=Object(c.useState)(""),{t:l}=Object(a.b)(),d=Object(Z.c)(),b=Object(Z.b)(),[j,u]=Object(c.useState)();Object(c.useEffect)(()=>{!j&&b&&u(b)},[j,b]);const x=Object(c.useCallback)(e=>{o(e.target.value)},[]),h=Object(Oe.a)(),m=Object(c.useMemo)(()=>Object(ge.a)(i).length>0||Boolean(Object(me.a)(i)),[i]),O=Object(c.useMemo)(()=>Object.keys(d).filter(e=>Boolean(d[e].current)&&!he.c.includes(e)).sort((e,t)=>{const{current:n}=d[e],{current:c}=d[t];return null===j||void 0===j||!j.includes(e)||null!==j&&void 0!==j&&j.includes(t)?null!==j&&void 0!==j&&j.includes(e)||null===j||void 0===j||!j.includes(t)?n&&c?n.name.toLowerCase()<c.name.toLowerCase()?-1:n.name.toLowerCase()===c.name.toLowerCase()?0:1:n?-1:c?1:0:1:-1}),[d,j]),[p,g]=Object(c.useState)(),[f,v]=Object(c.useState)();Object(c.useEffect)(()=>{m?async function(){h(i,!1).then(e=>g(e)).catch(()=>v("Error importing list"))}():(g(void 0),""!==i&&v("Enter valid list location")),""===i&&v(void 0)},[h,i,m]);const y=Object.keys(d).includes(i),T=Object(c.useCallback)(()=>{p&&(n(p),t(fe.importList),r(i))},[i,n,r,t,p]);return Object($.jsxs)(ve,{children:[Object($.jsxs)(N.a,{gap:"14px",children:[Object($.jsx)(G.d,{children:Object($.jsx)(s.V,{id:"list-add-input",scale:"lg",placeholder:l("https:// or ipfs:// or ENS name"),value:i,onChange:x})}),f?Object($.jsx)(s.xb,{color:"failure",style:{textOverflow:"ellipsis",overflow:"hidden"},children:f}):null]}),p&&Object($.jsx)(N.a,{style:{paddingTop:0},children:Object($.jsx)(xe.d,{padding:"12px 20px",children:Object($.jsxs)(G.b,{children:[Object($.jsxs)(G.c,{children:[p.logoURI&&Object($.jsx)(ee.c,{logoURI:p.logoURI,size:"40px"}),Object($.jsxs)(N.a,{gap:"4px",style:{marginLeft:"20px"},children:[Object($.jsx)(s.xb,{bold:!0,children:p.name}),Object($.jsxs)(s.xb,{color:"textSubtle",small:!0,textTransform:"lowercase",children:[p.tokens.length," ",l("Tokens")]})]})]}),y?Object($.jsxs)(G.c,{children:[Object($.jsx)(s.y,{width:"16px",mr:"10px"}),Object($.jsx)(s.xb,{children:l("Loaded")})]}):Object($.jsx)(s.m,{width:"fit-content",onClick:T,children:l("Import")})]})})}),Object($.jsx)(Ce,{children:Object($.jsx)(N.a,{gap:"md",children:O.map(e=>Object($.jsx)(we,{listUrl:e},e))})})]})},Ee=n(210),Se=n(123);const Ie=i.e.div`
  padding: 4px 28px;
  height: 56px;
  display: grid;
  grid-template-columns: auto minmax(auto, 1fr) auto;
  grid-gap: 16px;
  align-items: center;

  opacity: ${e=>{let{dim:t}=e;return t?"0.4":"1"}};
`,_e=Object(i.e)(s.x)`
  height: 16px;
  width: 16px;
  margin-right: 6px;
  stroke: ${e=>{let{theme:t}=e;return t.colors.success}};
`,Ae=i.e.div`
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 140px;
  font-size: 12px;
`;function Pe(e){var t,n;let{token:c,style:r,dim:i,showImportView:o,setImportToken:l}=e;const{chainId:d}=Object(B.a)(),{t:b}=Object(a.b)(),j=Object(Z.f)(),u=d&&(null===j||void 0===j||null===(t=j[d])||void 0===t||null===(n=t[c.address])||void 0===n?void 0:n.list),x=Object(Y.g)(c),h=Object(Y.f)(c);return Object($.jsxs)(Ie,{style:r,children:[Object($.jsx)(Se.a,{currency:c,size:"24px",style:{opacity:i?"0.6":"1"}}),Object($.jsxs)(N.a,{gap:"4px",style:{opacity:i?"0.6":"1"},children:[Object($.jsxs)(G.a,{children:[Object($.jsx)(s.xb,{children:c.symbol}),Object($.jsx)(s.xb,{color:"textDisabled",ml:"8px",children:Object($.jsx)(Ae,{title:c.name,children:c.name})})]}),u&&u.logoURI&&Object($.jsxs)(G.c,{children:[Object($.jsxs)(s.xb,{small:!0,mr:"4px",color:"textSubtle",children:[b("via")," ",u.name]}),Object($.jsx)(ee.c,{logoURI:u.logoURI,size:"12px"})]})]}),h||x?Object($.jsxs)(G.c,{style:{minWidth:"fit-content"},children:[Object($.jsx)(_e,{}),Object($.jsx)(s.xb,{color:"success",children:"Active"})]}):Object($.jsx)(s.m,{width:"fit-content",onClick:()=>{l&&l(c),o()},children:b("Import")})]})}const Re=i.e.div`
  width: 100%;
  height: calc(100% - 60px);
  position: relative;
  padding-bottom: 60px;
`,Ue=i.e.div`
  position: absolute;
  bottom: 0;
  width: 100%;
  display: flex;
  justify-content: space-between;
  align-items: center;
`;function Be(e){let{setModalView:t,setImportToken:n}=e;const{chainId:r}=Object(B.a)(),{t:i}=Object(a.b)(),[o,l]=Object(c.useState)(""),d=Object(c.useRef)(),b=Object(c.useCallback)(e=>{const t=e.target.value,n=Object(Q.h)(t);l(n||t)},[]),j=Object(Y.h)(o),u=Object(Ee.a)(),x=Object(be.f)(),h=Object(c.useCallback)(()=>{r&&u&&u.map(e=>x(r,e.address))},[x,u,r]),m=Object(c.useMemo)(()=>r&&u.map(e=>Object($.jsxs)(G.b,{width:"100%",children:[Object($.jsxs)(G.c,{children:[Object($.jsx)(ee.a,{currency:e,size:"20px"}),Object($.jsx)(s.W,{external:!0,href:Object(Q.e)(e.address,"address",r),color:"textSubtle",ml:"10px",children:e.symbol})]}),Object($.jsxs)(G.c,{children:[Object($.jsx)(s.T,{variant:"text",onClick:()=>x(r,e.address),children:Object($.jsx)(s.C,{})}),Object($.jsx)(s.X,{href:Object(Q.e)(e.address,"address",r)})]})]},e.address)),[u,r,x]),O=""===o||Object(Q.h)(o);return Object($.jsx)(Re,{children:Object($.jsxs)(N.c,{style:{width:"100%",flex:"1 1"},children:[Object($.jsxs)(N.a,{gap:"14px",children:[Object($.jsx)(G.d,{children:Object($.jsx)(s.V,{id:"token-search-input",scale:"lg",placeholder:"0x0000",value:o,autoComplete:"off",ref:d,onChange:b,isWarning:!O})}),!O&&Object($.jsx)(s.xb,{color:"failure",children:i("Enter valid token address")}),j&&Object($.jsx)(Pe,{token:j,showImportView:()=>t(fe.importToken),setImportToken:n,style:{height:"fit-content"}})]}),m,Object($.jsxs)(Ue,{children:[Object($.jsxs)(s.xb,{bold:!0,color:"textSubtle",children:[null===u||void 0===u?void 0:u.length," ",1===u.length?i("Custom Token"):i("Custom Tokens")]}),u.length>0&&Object($.jsx)(s.m,{variant:"tertiary",onClick:h,children:i("Clear all")})]})]})})}const Ne=Object(i.e)(s.n)`
  width: 100%;
`;function $e(e){let{setModalView:t,setImportList:n,setImportToken:r,setListUrl:i}=e;const[o,l]=Object(c.useState)(!0),{t:d}=Object(a.b)();return Object($.jsxs)(s.gb,{children:[Object($.jsxs)(Ne,{activeIndex:o?0:1,onItemClick:()=>l(e=>!e),scale:"sm",variant:"subtle",mb:"32px",children:[Object($.jsx)(s.o,{width:"50%",children:d("Lists")}),Object($.jsx)(s.o,{width:"50%",children:d("Tokens")})]}),o?Object($.jsx)(ke,{setModalView:t,setImportList:n,setListUrl:i}):Object($.jsx)(Be,{setModalView:t,setImportToken:r})]})}var De=n(54);const Le=i.e.div`
  position: relative;
  width: 100%;
`,Fe=i.e.div`
  height: 3px;
  width: 3px;
  background-color: ${e=>{let{theme:t}=e;return t.colors.text}};
  border-radius: 50%;
`;var He=function(e){var t;let{listURL:n,list:r,onImport:i}=e;const{theme:o}=Object(De.a)(),l=Object(ue.b)(),{t:d}=Object(a.b)(),[b,j]=Object(c.useState)(!1),u=Object(Z.c)(),x=Object(Oe.a)(),h=Boolean(null===(t=u[n])||void 0===t?void 0:t.loadingRequestId),[m,O]=Object(c.useState)(null),p=Object(c.useCallback)(()=>{h||(O(null),x(n).then(()=>{l(Object(pe.d)(n)),i()}).catch(e=>{O(e.message),l(Object(pe.f)(n))}))},[h,l,x,n,i]);return Object($.jsx)(Le,{children:Object($.jsx)(N.a,{gap:"md",children:Object($.jsxs)(N.a,{gap:"md",children:[Object($.jsx)(xe.d,{padding:"12px 20px",children:Object($.jsx)(G.b,{children:Object($.jsxs)(G.c,{children:[r.logoURI&&Object($.jsx)(ee.c,{logoURI:r.logoURI,size:"40px"}),Object($.jsxs)(N.a,{gap:"sm",style:{marginLeft:"20px"},children:[Object($.jsxs)(G.c,{children:[Object($.jsx)(s.xb,{bold:!0,mr:"6px",children:r.name}),Object($.jsx)(Fe,{}),Object($.jsxs)(s.xb,{small:!0,color:"textSubtle",ml:"6px",children:[r.tokens.length," tokens"]})]}),Object($.jsx)(s.W,{small:!0,external:!0,ellipsis:!0,maxWidth:"90%",href:`https://tokenlists.org/token-list?url=${n}`,children:n})]})]})})}),Object($.jsx)(s.bb,{variant:"danger",children:Object($.jsxs)(s.M,{flexDirection:"column",children:[Object($.jsx)(s.xb,{fontSize:"20px",textAlign:"center",color:o.colors.failure,mb:"16px",children:d("Import at your own risk")}),Object($.jsx)(s.xb,{color:o.colors.failure,mb:"8px",children:d("By adding this list you are implicitly trusting that the data is correct. Anyone can create a list, including creating fake versions of existing lists and lists that claim to represent projects that do not have one.")}),Object($.jsx)(s.xb,{bold:!0,color:o.colors.failure,mb:"16px",children:d("If you purchase a token from this list, you may not be able to sell it back.")}),Object($.jsxs)(s.M,{alignItems:"center",children:[Object($.jsx)(s.w,{name:"confirmed",type:"checkbox",checked:b,onChange:()=>j(!b),scale:"sm"}),Object($.jsx)(s.xb,{ml:"10px",style:{userSelect:"none"},children:d("I understand")})]})]})}),Object($.jsx)(s.m,{disabled:!b,onClick:p,children:d("Import")}),m?Object($.jsx)(s.xb,{color:"failure",style:{textOverflow:"ellipsis",overflow:"hidden"},children:m}):null]})})})};const Me=Object(i.e)(s.jb)`
  background: ${e=>{let{theme:t}=e;return t.colors.gradients.bubblegum}};
`,We=Object(i.e)(s.ib)`
  max-width: 420px;
  width: 100%;
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.input}};
  border-radius: 16px;
`,ze=Object(i.e)(s.gb)`
  padding: 24px;
`;function Ke(e){let{onDismiss:t=()=>null,origin:n,destination:r,onCurrencySelect:i,selectedCurrency:o,otherSelectedCurrency:l}=e;const[d,b]=Object(c.useState)(fe.search),j=Object(c.useCallback)(e=>{t(),i(e)},[t,i]),u=Object(q.a)(d),[x,h]=Object(c.useState)(),[m,O]=Object(c.useState)(),[p,g]=Object(c.useState)(),{t:f}=Object(a.b)(),v={[fe.search]:{title:f("Select a Token"),onBack:void 0},[fe.manage]:{title:f("Manage"),onBack:()=>b(fe.search)},[fe.importToken]:{title:f("Import Tokens"),onBack:()=>b(u&&u!==fe.importToken?u:fe.search)},[fe.importList]:{title:f("Import List"),onBack:()=>b(fe.search)}};return Object($.jsxs)(We,{minWidth:"320px",children:[Object($.jsxs)(Me,{children:[Object($.jsxs)(s.lb,{children:[v[d].onBack&&Object($.jsx)(s.fb,{onBack:v[d].onBack}),Object($.jsx)(s.P,{children:v[d].title})]}),Object($.jsx)(s.hb,{onDismiss:t})]}),Object($.jsx)(ze,{children:d===fe.search?Object($.jsx)(de,{origin:n,destination:r,onCurrencySelect:j,selectedCurrency:o,otherSelectedCurrency:l}):d===fe.importToken&&x?Object($.jsx)(je,{tokens:[x],handleCurrencySelect:j}):d===fe.importList&&m&&p?Object($.jsx)(He,{list:m,listURL:p,onImport:()=>b(fe.manage)}):d===fe.manage?Object($.jsx)($e,{setModalView:b,setImportToken:h,setImportList:O,setListUrl:g}):""})]})}const Ve=i.e.input`
  color: ${e=>{let{error:t,theme:n}=e;return t?n.colors.failure:n.colors.text}};
  width: 0;
  position: relative;
  font-weight: 500;
  outline: none;
  border: none;
  flex: 1 1 auto;
  background-color: transparent;
  font-size: 16px;
  text-align: ${e=>{let{align:t}=e;return t&&t}};
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  padding: 0px;
  -webkit-appearance: textfield;

  ::-webkit-search-decoration {
    -webkit-appearance: none;
  }

  [type='number'] {
    -moz-appearance: textfield;
  }

  ::-webkit-outer-spin-button,
  ::-webkit-inner-spin-button {
    -webkit-appearance: none;
  }

  ::placeholder {
    color: ${e=>{let{theme:t}=e;return t.colors.textSubtle}};
  }
`,qe=RegExp("^\\d*(?:\\\\[.])?\\d*$"),Je=r.a.memo(function(e){let{value:t,onUserInput:n,placeholder:c,...r}=e;const{t:i}=Object(a.b)();return Object($.jsx)(Ve,{...r,value:t,onChange:e=>{var t;(""===(t=e.target.value.replace(/,/g,"."))||qe.test(Object(Q.d)(t)))&&n(t)},inputMode:"decimal",title:i("Token Amount"),autoComplete:"off",autoCorrect:"off",type:"text",pattern:"^[0-9]*[.,]?[0-9]*$",placeholder:c||"0.0",minLength:1,maxLength:79,spellCheck:"false"})});const Ye=i.e.div`
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  padding: ${e=>{let{selected:t}=e;return t?"0.75rem 0.5rem 0.75rem 1rem":"0.75rem 0.75rem 0.75rem 1rem"}};
`,Qe=Object(i.e)(s.m).attrs({variant:"text",scale:"sm"})`
  padding: 0 0.5rem;
`,Ge=i.e.div`
  display: flex;
  flex-flow: row nowrap;
  align-items: center;
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
  font-size: 0.75rem;
  line-height: 1rem;
  padding: 0.75rem 1rem 0 1rem;
`,Xe=i.e.div`
  display: flex;
  flex-flow: column nowrap;
  position: relative;
  border-radius: ${e=>{let{hideInput:t}=e;return t?"8px":"20px"}};
  background-color: ${e=>{let{theme:t}=e;return t.colors.background}};
  z-index: 1;
`,Ze=i.e.div`
  border-radius: 16px;
  box-shadow: ${e=>{let{theme:t}=e;return t.shadows.inset}};
  background: ${e=>{let{theme:t}=e;return t.colors.input}};
`;function et(e){var t;let{value:n,origin:c,destination:r,onUserInput:i,onMax:o,showMaxButton:l,label:d,onCurrencySelect:b,currency:j,disableCurrencySelect:u=!1,hideBalance:x=!1,pair:h=null,hideInput:m=!1,otherCurrency:O,id:p}=e;const{account:g}=Object(B.a)(),f=Object(V.b)(null!==g&&void 0!==g?g:void 0,null!==j&&void 0!==j?j:void 0),{t:v}=Object(a.b)(),y=d||v("Input"),{chainId:T}=Object(B.a)(),w=j?Object.prototype.hasOwnProperty.call(j,"address"):void 0,[C]=Object(s.Ob)(Object($.jsx)(Ke,{origin:c,destination:r,onCurrencySelect:b,selectedCurrency:j,otherSelectedCurrency:O}));return Object($.jsx)(Xe,{id:p,children:Object($.jsxs)(Ze,{hideInput:m,children:[!m&&Object($.jsx)(Ge,{children:Object($.jsxs)(G.b,{children:[Object($.jsx)(s.xb,{fontSize:"14px",children:y}),g&&Object($.jsx)(s.xb,{onClick:o,fontSize:"14px",style:{display:"inline",cursor:"pointer"},children:!x&&j&&f?v("Balance: %amount%",{amount:null!==(t=null===f||void 0===f?void 0:f.toSignificant(6))&&void 0!==t?t:""}):" -"})]})}),Object($.jsxs)(Ye,{style:m?{padding:"0",borderRadius:"8px"}:{},selected:u,children:[!m&&Object($.jsxs)($.Fragment,{children:[Object($.jsx)(Je,{className:"token-amount-input",value:n,onUserInput:e=>{i(e)}}),g&&j&&l&&"To"!==d&&Object($.jsx)(s.m,{onClick:o,scale:"sm",variant:"text",children:"MAX"})]}),Object($.jsx)(Qe,{selected:!!j,className:"open-currency-select-button",onClick:()=>{u||C()},children:Object($.jsxs)(s.M,{alignItems:"center",justifyContent:"space-between",children:[h?Object($.jsx)(ee.b,{currency0:h.token0,currency1:h.token1,size:16,margin:!0}):j?Object($.jsx)(ee.a,{currency:j,size:"24px",style:{marginRight:"8px"},chain:T}):null,h?Object($.jsxs)(s.xb,{id:"pair",children:[null===h||void 0===h?void 0:h.token0.symbol,":",null===h||void 0===h?void 0:h.token1.symbol]}):Object($.jsx)(s.xb,{id:"pair",children:j&&j.symbol?w?j.symbol:1===T&&"ELA"===j.symbol?"ETH":128===T&&"ELA"===j.symbol?"HT":56===T&&"ELA"===j.symbol?"BNB":j.symbol:v("Select a currency")}),!u&&Object($.jsx)(s.z,{})]})})]})]})})}const tt=i.e.div`
  display: flex;
  flex-direction: column;
  align-items: center;
  width: 100%;
  padding: 16px;
  padding-bottom: 0;
  min-height: calc(100vh - 64px);

  ${e=>{let{theme:t}=e;return t.mediaQueries.xs}} {
    background-size: auto;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding: 24px;
    padding-bottom: 0;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    padding-top: 32px;
    min-height: calc(100vh - 64px);
  }
`;var nt=e=>{let{children:t,...n}=e;return Object($.jsxs)(tt,{...n,children:[t,Object($.jsx)(s.M,{flexGrow:1})]})};const ct=Object(i.e)(s.q)`
  margin: 0 auto;
  max-width: 478px;
  width: 100%;
  z-index: 1;
  background: none;
`;function rt(e){let{children:t}=e;return Object($.jsx)(ct,{children:t})}var it=n(179),ot=n(57),st=n(227),at=n(65),lt=n(132),dt=n(167),bt=n(168),jt=(n(413),n(75));function ut(){return Object(ue.c)(e=>e.bridge)}const xt=[];function ht(e,t){return e.route.path.some(e=>e.address===t)||e.route.pairs.some(e=>e.liquidityToken.address===t)}function mt(){var e,t;const{account:n}=Object(B.a)(),{t:c}=Object(a.b)(),{independentField:r,typedValue:i,[at.a.INPUT]:{currencyId:s},[at.a.OUTPUT]:{currencyId:l},recipient:d}=ut(),b=Object(Y.d)(s),j=Object(Y.d)(l),u=Object(dt.a)(null!==d&&void 0!==d?d:void 0),x=null!==(e=null===d?n:u.address)&&void 0!==e?e:null,h=Object(V.c)(null!==n&&void 0!==n?n:void 0,[null!==b&&void 0!==b?b:void 0,null!==j&&void 0!==j?j:void 0]),m=r===at.a.INPUT,O=function(e,t){if(e&&t)try{const n=Object(lt.parseUnits)(e,t.decimals).toString();if("0"!==n)return t instanceof o.j?new o.k(t,o.e.BigInt(n)):o.c.ether(o.e.BigInt(n))}catch(n){console.debug(`Failed to parse input amount: "${e}"`,n)}}(i,null!==(t=m?b:j)&&void 0!==t?t:void 0),p=Object(bt.b)(m?O:void 0,null!==j&&void 0!==j?j:void 0),g=Object(bt.c)(null!==b&&void 0!==b?b:void 0,m?void 0:O),f=m?p:g,v={[at.a.INPUT]:h[0],[at.a.OUTPUT]:h[1]},y={[at.a.INPUT]:null!==b&&void 0!==b?b:void 0,[at.a.OUTPUT]:null!==j&&void 0!==j?j:void 0};let T;var w,C;(n||(T=c("Connect Wallet")),O)||(T=null!==(w=T)&&void 0!==w?w:c("Enter an amount"));y[at.a.INPUT]&&y[at.a.OUTPUT]||(T=null!==(C=T)&&void 0!==C?C:c("Select a token"));const k=Object(Q.h)(x);var E;if(x&&k){if(-1!==xt.indexOf(k)||p&&ht(p,k)||g&&ht(g,k)){var S;T=null!==(S=T)&&void 0!==S?S:c("Invalid recipient")}}else T=null!==(E=T)&&void 0!==E?E:c("Enter a recipient");const[I]=Object(be.k)(),_=f&&I&&Object(jt.a)(f,I),[A,P]=[v[at.a.INPUT],_?_[at.a.INPUT]:null];return A&&P&&A.lessThan(P)&&(T=c("Insufficient %symbol% balance",{symbol:P.currency.symbol})),{currencies:y,currencyBalances:v,parsedAmount:O,v2Trade:null!==f&&void 0!==f?f:void 0,inputError:T}}var Ot=n(252);var pt=()=>{const{t:e}=Object(a.b)();return Object($.jsxs)($.Fragment,{children:[Object($.jsxs)(s.xb,{children:[e("To trade SAFEMOON, you must:")," "]}),Object($.jsxs)(s.xb,{children:["\u2022 ",e("Click on the settings icon")]}),Object($.jsxs)(s.xb,{mb:"24px",children:["\u2022 ",e("Set your slippage tolerance to 12%+")]}),Object($.jsx)(s.xb,{children:e("This is because SafeMoon taxes a 10% fee on each transaction:")}),Object($.jsxs)(s.xb,{children:["\u2022 ",e("5% fee = redistributed to all existing holders")]}),Object($.jsxs)(s.xb,{children:["\u2022 ",e("5% fee = used to add liquidity")]})]})};var gt=()=>{const{t:e}=Object(a.b)();return Object($.jsx)(s.xb,{children:e("Warning: has been compromised. Please remove liqudity until further notice.")})};var ft=e=>{let{handleContinueClick:t}=e;const{t:n}=Object(a.b)(),[r,i]=Object(c.useState)(!1);return Object($.jsx)($.Fragment,{children:Object($.jsxs)(s.M,{justifyContent:"space-between",children:[Object($.jsxs)(s.M,{alignItems:"center",children:[Object($.jsx)(s.w,{name:"confirmed",type:"checkbox",checked:r,onChange:()=>i(!r),scale:"sm"}),Object($.jsx)(s.xb,{ml:"10px",style:{userSelect:"none"},children:n("I understand")})]}),Object($.jsx)(s.m,{disabled:!r,onClick:t,children:n("Continue")})]})})};const vt=Object(i.e)(s.ib)`
  max-width: 440px;
`,yt=Object(i.e)(s.bb)`
  align-items: flex-start;
  justify-content: flex-start;
`;var Tt=e=>{let{swapCurrency:t,onDismiss:n}=e;const{t:r}=Object(a.b)(),{theme:i}=Object(De.a)();Object(c.useEffect)(()=>{const e=e=>(e.stopPropagation(),e.preventDefault(),!1);return document.querySelectorAll('[role="presentation"]').forEach(t=>{t.addEventListener("click",e,!0)}),()=>{document.querySelectorAll('[role="presentation"]').forEach(t=>{t.removeEventListener("click",e,!0)})}},[]);const o={[Object(d.a)(l.a.safemoon.address)]:{symbol:l.a.safemoon.symbol,component:Object($.jsx)(pt,{})},[Object(d.a)(l.a.bondly.address)]:{symbol:l.a.bondly.symbol,component:Object($.jsx)(gt,{})}}[t.address];return Object($.jsxs)(vt,{minWidth:"280px",children:[Object($.jsx)(s.jb,{background:i.colors.gradients.cardHeader,children:Object($.jsx)(s.P,{p:"12px 24px",children:r("Notice for trading %symbol%",{symbol:o.symbol})})}),Object($.jsxs)(s.gb,{p:"24px",children:[Object($.jsx)(yt,{variant:"warning",mb:"24px",children:Object($.jsx)(s.j,{children:o.component})}),Object($.jsx)(ft,{handleContinueClick:n})]})]})};const wt=Object(i.e)(nt)`
  padding-top: 10vh;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    background: radial-gradient(40% 55% at 45% 57.5%, #f2ad6c 0%, rgba(242, 173, 108, 0.4) 25%, rgba(6, 9, 20, 0) 72.5%),
      radial-gradient(40% 45% at 55% 47.5%, #48b9ff 0%, rgba(72, 185, 255, 0.4) 25%, rgba(6, 9, 20, 0) 72.5%);
    filter: drop-shadow(0px 4px 4px rgba(0, 0, 0, 0.25));
    background-position-y: -10vh;
  }
`,Ct=i.e.div`
  align-items: center;
  border-radius: 14px;
`,kt=i.e.div`
  text-align: center;
`,Et=i.e.div`
  text-align: center;
  background: ${e=>{let{theme:t}=e;return t.colors.gradients.inverseBubblegum}};
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.input}};
  border-radius: 14px;
  padding: 10px;
  box-shadow: ${e=>{let{theme:t}=e;return t.card.boxShadow}};
`,St=i.e.div`
  > ${s.xb} {
    font-size: 12px;
  }
`,It=i.e.div`
  display: flex;
  align-items: center;
  width: 100%;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    width: auto;
    padding: 0;
  }
`,_t=i.e.div`
  align-items: center;
  border-radius: 20px;
  padding: 0.25rem;
  margin-bottom: 1.5rem;
  background-color: ${e=>{let{theme:t}=e;return t.colors.input}};
`,At=(Object(i.e)(s.M)`
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.failure}};
  border-radius: 16px;
  margin-bottom: 20px;
  padding: 16px;
  max-width: 478px;
  width: 100%;
`,{0:"Elastos",1:"Ethereum",2:"Heco",3:"Binance"}),Pt={0:20,1:1,2:128,3:56},Rt={20:"ELA",1:"ETH",128:"HT",56:"BNB"};var Ut=()=>{var e,t,n,r,i,x;const{t:y}=Object(a.b)(),[T,w]=Object(c.useState)(0),[C,E]=Object(c.useState)(1),{account:S,chainId:_,library:P}=Object(B.a)(),F=Pt[T]===_;Object(u.b)();const[H]=Object(be.k)(),{independentField:M,typedValue:W}=ut(),{v2Trade:z,currencyBalances:V,parsedAmount:q,currencies:J}=mt(),{wrapType:Y}=Object(st.b)(J[at.a.INPUT],J[at.a.OUTPUT],W),Q=Y!==st.a.NOT_APPLICABLE,X=Q?void 0:z,Z=Q?{[at.a.INPUT]:q,[at.a.OUTPUT]:q}:{[at.a.INPUT]:M===at.a.INPUT?q:null===X||void 0===X?void 0:X.inputAmount,[at.a.OUTPUT]:M===at.a.OUTPUT?q:null===X||void 0===X?void 0:X.outputAmount},{onCurrencySelection:ee,onUserInput:te}=function(){const e=Object(ue.b)(),t=Object(c.useCallback)((t,n)=>{e(Object(at.c)({field:t,currencyId:n instanceof o.j?n.address:n===o.d?"ELA":""}))},[e]);return{onSwitchTokens:Object(c.useCallback)(()=>{e(Object(at.e)())},[e]),onCurrencySelection:t,onUserInput:Object(c.useCallback)((t,n)=>{e(Object(at.f)({field:t,typedValue:n}))},[e]),onChangeRecipient:Object(c.useCallback)(t=>{e(Object(at.d)({recipient:t}))},[e])}}(),ne=M===at.a.INPUT?at.a.OUTPUT:at.a.INPUT,ce=Object(c.useCallback)(e=>{te(at.a.INPUT,e)},[te]),re={[M]:W,[ne]:Q?null!==(e=null===(t=Z[M])||void 0===t?void 0:t.toExact())&&void 0!==e?e:"":null!==(n=null===(r=Z[ne])||void 0===r?void 0:r.toSignificant(6))&&void 0!==n?n:""},[ie]=Object(ot.c)(X,H),[oe,se]=Object(c.useState)(!1);Object(c.useEffect)(()=>{ie===ot.a.PENDING&&se(!0)},[ie,oe]);const ae=Object(Ot.a)(V[at.a.INPUT]),le=Boolean(ae&&(null===(i=Z[at.a.INPUT])||void 0===i?void 0:i.equalTo(ae))),de=Boolean(ae&&(null===(x=Z[at.a.INPUT])||void 0===x?void 0:x.greaterThan(ae))),[je,xe]=Object(c.useState)(null),[he]=Object(s.Ob)(Object($.jsx)(Tt,{swapCurrency:je}));Object(c.useEffect)(()=>{je&&he()},[je]);const me=Object(c.useCallback)(e=>{te(at.a.INPUT,""),se(!1),ee(at.a.INPUT,e);const t=(e=>{const t=Object.entries(l.a).find(t=>{const n=t[1],c=Object(d.a)(n.address);return e.address===c});return Boolean(t)})(e);xe(t?e:null)},[te,ee]),Oe=Object(c.useCallback)(()=>{ae&&te(at.a.INPUT,ae.toExact())},[ae,te]),pe=Object(c.useCallback)(()=>{te(at.a.INPUT,""),ee(at.a.INPUT,void 0)},[te,ee]),ge=J[at.a.INPUT],fe=Number(re[at.a.INPUT])>=0?new h.a(re[at.a.INPUT]):new h.a(0),ve="ETHER"===((ye=ge)instanceof o.j?ye.address:ye===o.d?"ETHER":"")?Rt[_]:ge?ge.symbol:void 0;var ye;const Te=`${Pt[T]}_${Pt[C]}`,we=`${Pt[C]}_${Pt[T]}`,Ce=ge?"ELA"===ge.symbol||"ETH"===ge.symbol||"HT"===ge.symbol||"BNB"===ge.symbol?"native":"token":void 0;let ke=Ce&&_===Pt[T]?j[Te][Ce][_]:void 0;const Ee=Ce&&_===Pt[T]?j[Te][Ce][Pt[C]]:void 0,Se=Ce&&_===Pt[T]?j[we][Ce][_]:void 0,Ie=Ce&&_===Pt[T]?j[we][Ce][Pt[C]]:void 0,_e=void 0!==ke,Ae=((e,t,n,r)=>{const[i,s]=Object(c.useState)(!1),{account:a,library:l}=Object(m.c)(),{lastUpdated:d}=Object(f.a)();return Object(c.useEffect)(()=>{if(!(e instanceof o.j))return void s(!1);if(void 0===t)return void s(!1);const c=Object(p.a)(e.address,l.getSigner(a)),i=R(e.address,e.chainId)?r.contract:t.contract;(async()=>{try{const t=await c.allowance(a,i),r=new h.a(t.toString()),o=new h.a(v(n,e.decimals).toString());s(!r.gt(o))}catch(t){s(!1)}})()},[e,t,l,a,d,n,r]),i})(ge,ke,fe,Se),Pe=((e,t,n)=>{const[r,i]=Object(c.useState)(!1),{account:o}=Object(m.c)();return Object(c.useEffect)(()=>{(async()=>{if(t)if(20===n)try{const e=await fetch(`${k.b}/faucet/${o}`);e.ok&&(!1===(await e.json()).has_use_faucet?i(!0):i(!1))}catch(e){console.error(JSON.stringify(e))}else i(!1);else i(!1)})()},[o,t,n]),r})(0,_e,Pt[C]),{handleApprove:Re,requestedApproval:Ue,approvalComplete:Be}=((e,t,n)=>{const[r,i]=Object(c.useState)(!1),[s,l]=Object(c.useState)(!1),{toastSuccess:d,toastError:b}=Object(g.a)(),{t:j}=Object(a.b)(),{account:u,library:x}=Object(m.c)();return{handleApprove:Object(c.useCallback)(async()=>{if(!(e instanceof o.j))return void i(!1);if(void 0===t)return void i(!1);const c=R(e.address,e.chainId)?n.contract:t.contract,r=Object(p.a)(e.address,x.getSigner(u));try{i(!0);const t=await r.approve(c,O.a.constants.MaxUint256);(await t.wait()).status?(d(j("Contract Enabled"),j("You can now bridge your %symbol%!",{symbol:e.symbol})),i(!1),l(!0)):(b(j("Error"),j("Please try again. Confirm the transaction and make sure you are paying enough gas!")),i(!1))}catch(s){i(!1),console.error(s),b(j("Error"),j("Please try again. Confirm the transaction and make sure you are paying enough gas!"))}},[e,u,x,t,j,b,d,n]),requestedApproval:r,approvalComplete:s}})(ge,ke,Se),{handleBridgeTransfer:Ne,requestedBridgeTransfer:$e}=((e,t,n,r,i,s,l,d,b)=>{const[j,u]=Object(c.useState)(!1),{toastSuccess:x,toastError:h}=Object(g.a)(),{t:O}=Object(a.b)(),{account:p,library:f}=Object(m.c)();return{handleBridgeTransfer:Object(c.useCallback)(async()=>{u(!0);const c=e instanceof o.j;try{await A(e,r,t,n,s,l,p,f,c,d,b,i,x,h,O),u(!1)}catch(a){u(!1),console.error(a),h(O("Error"),O("Please try again. Confirm the transaction and make sure you are paying enough gas!"))}},[e,t,n,r,i,s,l,p,f,d,b,O,h,x]),requestedBridgeTransfer:j}})(ge,fe,Ce,ke,Ee,Se,Ie,Pt[T],Pt[C]);let De=_e?ke.minTx:"0",Le=_e?ke.fee:"0";if(ge instanceof o.j){const e=I.tokens.filter(e=>e.address===ge.address)[0];void 0!==(null===e||void 0===e?void 0:e.minTx)&&(De=e.minTx),void 0!==(null===e||void 0===e?void 0:e.fee)&&(Le=e.fee)}const Fe=_e&&fe.gt(0)?new h.a(Le).div(new h.a(100)).times(fe).toPrecision(3):0,He=_e&&fe>=De&&fe<=ke.maxTx&&!de;return Object($.jsx)($.Fragment,{children:Object($.jsx)(wt,{children:Object($.jsxs)(rt,{children:[Object($.jsx)(it.b,{title:y("Bridge"),subtitle:y("Map tokens to and from the Elastos Smart Chain"),noConfig:!0}),Object($.jsxs)(D,{id:"bridge-page",children:[Object($.jsxs)(G.a,{justify:"center",children:[Object($.jsx)(N.a,{gap:"md",style:{padding:"1rem 0"},children:Object($.jsxs)(Ct,{children:[Object($.jsx)(G.a,{justify:"center",children:Object($.jsx)(s.xb,{color:"textSubtle",children:y("From")})}),Object($.jsx)(G.a,{justify:"center",style:{padding:"0.5rem"},children:Object($.jsx)("img",{src:`images/networks/${At[T]}.png`,alt:At[T],width:75})}),Object($.jsx)(G.a,{justify:"center",children:Object($.jsx)(It,{children:Object($.jsx)(St,{children:Object($.jsx)(K,{chainIndex:T,options:[{label:"Elastos",value:"elastos"},{label:"Ethereum",value:"ethereum"},{label:"Heco",value:"heco"},{label:"Binance",value:"binance"}],onChange:e=>{switch(pe(),e.value){case"elastos":w(0),E(2),Object(b.b)(20,P);break;case"ethereum":w(1),E(0),Object(b.b)(1,P);break;case"heco":w(2),E(0),Object(b.b)(128,P);break;case"binance":w(3),E(0),Object(b.b)(56,P);break;default:w(2),E(0)}}})})})})]})}),Object($.jsx)(N.a,{gap:"md",style:{padding:"1rem 0"},children:Object($.jsx)(_t,{children:Object($.jsx)(L,{clickable:!0,onClick:()=>{pe(),w(C),E(T)},children:Object($.jsx)(s.e,{width:"24px"})})})}),Object($.jsx)(N.a,{gap:"md",style:{padding:"1rem 0"},children:Object($.jsxs)(Ct,{children:[Object($.jsx)(G.a,{justify:"center",children:Object($.jsx)(s.xb,{color:"textSubtle",children:y("To")})}),Object($.jsx)(G.a,{justify:"center",style:{padding:"0.5rem"},children:Object($.jsx)("img",{src:`images/networks/${At[C]}.png`,alt:At[C],width:75})}),Object($.jsx)(G.a,{justify:"center",children:Object($.jsx)(It,{children:Object($.jsx)(St,{children:Object($.jsx)(K,{chainIndex:C,options:[{label:"Elastos",value:"elastos"},{label:"Ethereum",value:"ethereum"},{label:"Heco",value:"heco"},{label:"Binance",value:"binance"}],onChange:e=>{switch(pe(),e.value){case"elastos":if(E(0),1===T||2===T)return;0===T&&w(2);break;case"ethereum":if(E(1),0===T)return;1!==T&&2!==T||w(0);break;case"heco":if(E(2),0===T)return;1!==T&&2!==T||w(0);break;case"binance":if(E(3),0===T)return;1!==T&&2!==T||w(0);break;default:E(0)}}})})})})]})})]}),Object($.jsx)(N.a,{gap:"md",children:Object($.jsx)(et,{label:y("Token to bridge"),origin:Pt[T],destination:Pt[C],value:re[at.a.INPUT],showMaxButton:!le,currency:J[at.a.INPUT],onUserInput:ce,onMax:Oe,onCurrencySelect:me,otherCurrency:J[at.a.OUTPUT],id:"swap-currency-input"})}),_e&&Object($.jsxs)(N.a,{style:{padding:"0.5rem 0.5rem 0 0.5rem"},children:[Object($.jsxs)(s.M,{alignItems:"center",justifyContent:"space-between",children:[Object($.jsx)(s.xb,{color:"textSubtle",children:y("Min Bridge Amount")}),Object($.jsxs)(s.xb,{color:"textSubtle",children:[De.toLocaleString()," ",ve]})]}),Object($.jsxs)(s.M,{alignItems:"center",justifyContent:"space-between",children:[Object($.jsxs)(s.xb,{color:"textSubtle",children:[y("Fee")," (",Le,"%)"]}),Object($.jsxs)(s.xb,{color:"textSubtle",children:[Fe>0?Fe.toLocaleString():0," ",ve]})]})]}),Object($.jsxs)(N.a,{gap:"md",justify:"center",style:{padding:"1rem 0 0 0"},children:[!F&&Object($.jsx)(kt,{children:Object($.jsxs)(s.xb,{color:"failure",mb:"4px",children:["\u2022 ",y("Please connect your wallet to the chain you wish to bridge from!"),"  ",Object($.jsx)(s.m,{scale:"xs",variant:"danger",onClick:()=>{return e=Pt[T],Object(b.b)(e,P),void pe();var e},children:y("Click Here to Switch")})]})}),_e&&fe.lt(De)?Object($.jsx)(kt,{children:Object($.jsxs)(s.xb,{color:"failure",mb:"4px",children:["\u2022 ",y("Below minimum bridge amount")]})}):de&&Object($.jsx)(kt,{children:Object($.jsxs)(s.xb,{color:"failure",mb:"4px",children:["\u2022 ",y("Insufficient balance")]})}),_e&&1===_&&"ELA on Ethereum"!==ge.name&&Object($.jsx)(kt,{children:Object($.jsx)(s.xb,{color:"primary",mb:"4px",children:y("Warning! Bridging assets back to Ethereum includes a fee (1%) to cover gas.")})}),S?Ae&&!Be?Object($.jsx)(s.m,{width:"100%",onClick:Re,disabled:!He,isLoading:Ue,endIcon:Ue?Object($.jsx)(s.f,{color:"currentColor",spin:!0}):null,children:y(Ue?"Approving":"Enable")}):Object($.jsx)(s.m,{width:"100%",onClick:Ne,disabled:!He,isLoading:$e,endIcon:$e?Object($.jsx)(s.f,{color:"currentColor",spin:!0}):null,children:y($e?"Bridging":"Bridge Token")}):Object($.jsx)(U.a,{width:"100%"})]}),He&&Pe&&Object($.jsx)(N.a,{gap:"md",justify:"center",style:{padding:"1rem 0 0 0"},children:Object($.jsx)(Et,{children:Object($.jsx)(s.xb,{mb:"4px",children:y("Faucet available! As part of this transaction you will receive 0.01 ELA for use as gas on ESC")})})})]})]})})})}},794:function(e,t,n){"use strict";n.d(t,"b",function(){return c}),n.d(t,"c",function(){return r}),n.d(t,"a",function(){return i});Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_GRAPH_API_PROFILE,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_GRAPH_API_PREDICTION,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_GRAPH_API_LOTTERY,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_SNAPSHOT_VOTING_API,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_SNAPSHOT_BASE_URL;const c="https://api.glidefinance.io",r="https://api.glidefinance.io/subgraphs/name/glide/exchange",i="https://api.glidefinance.io/subgraphs/name/glide/blocks"}}]);
//# sourceMappingURL=11.2a68e59a.chunk.js.map
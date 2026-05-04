(this["webpackJsonpglide-frontend"]=this["webpackJsonpglide-frontend"]||[]).push([[13],{1251:function(e,t,n){"use strict";n.r(t);var i=n(1),l=n(3),r=n(2),c=n(230),s=n(0);const o=(e,t,n)=>l.d`
  width: 100%;
  height: 20px;
  clip-path: url(${t});

  background: ${()=>e.isDark?(null===n||void 0===n?void 0:n.dark)||(null===n||void 0===n?void 0:n.light)||e.colors.background:(null===n||void 0===n?void 0:n.light)||e.colors.background};

  & svg {
    display: block;
  }
`,a=Object(l.e)(r.j)`
  ${e=>{let{theme:t,clipPath:n,clipFill:i}=e;return o(t,n,i)}}
  transform: ${e=>{let{clipPath:t}=e;return"#bottomConcaveCurve"===t?"translate(0, -13px)":"translate(0, 1px)"}};
`,d=Object(l.e)(r.j)`
  ${e=>{let{theme:t,clipPath:n,clipFill:i}=e;return o(t,n,i)}}
  transform: ${e=>{let{clipPath:t}=e;return"#bottomConvexCurve"===t?"translate(0, -13px)":"translate(0, -1px)"}};
`,j=e=>{let{clipFill:t}=e;return Object(s.jsx)(d,{clipFill:t,clipPath:"#topConvexCurve",children:Object(s.jsx)("svg",{width:"0",height:"0",children:Object(s.jsx)("defs",{children:Object(s.jsx)("clipPath",{id:"topConvexCurve",clipPathUnits:"objectBoundingBox",children:Object(s.jsx)("path",{d:"M 0,1 L 0,0 L 1,0 L 1,1 C 0.75 0, .25 0, 0 1 Z"})})})})})},x=e=>{let{clipFill:t}=e;return Object(s.jsx)(d,{clipFill:t,clipPath:"#bottomConvexCurve",children:Object(s.jsx)("svg",{width:"0",height:"0",children:Object(s.jsx)("defs",{children:Object(s.jsx)("clipPath",{id:"bottomConvexCurve",clipPathUnits:"objectBoundingBox",children:Object(s.jsx)("path",{d:"M 0,0 L 0,1 L 1,1 L 1,0 C .75 1, .25 1, 0 0 Z"})})})})})},b=e=>{let{clipFill:t}=e;return Object(s.jsx)(a,{clipFill:t,clipPath:"#topConcaveCurve",children:Object(s.jsx)("svg",{width:"0",height:"0",children:Object(s.jsx)("defs",{children:Object(s.jsx)("clipPath",{id:"topConcaveCurve",clipPathUnits:"objectBoundingBox",children:Object(s.jsx)("path",{d:"M 0,0 L 0,1 L 1,1 L 1,0 C .75 1, .25 1, 0 0 Z"})})})})})},h=e=>{let{clipFill:t}=e;return Object(s.jsx)(a,{clipFill:t,clipPath:"#bottomConcaveCurve",children:Object(s.jsx)("svg",{width:"0",height:"0",children:Object(s.jsx)("defs",{children:Object(s.jsx)("clipPath",{id:"bottomConcaveCurve",clipPathUnits:"objectBoundingBox",children:Object(s.jsx)("path",{d:"M 0,1 L 0,0 L 1,0 L 1,1 C .75 0.1, .25 0.1, 0 1 Z"})})})})})},u=l.e.div`
  background: ${e=>{let{theme:t,dividerFill:n}=e;return t.isDark?(null===n||void 0===n?void 0:n.dark)||(null===n||void 0===n?void 0:n.light)||"none":(null===n||void 0===n?void 0:n.light)||(null===n||void 0===n?void 0:n.dark)||"none"}};
  z-index: ${e=>{let{index:t}=e;return t}};
  position: relative;
  display: flex;
  align-items: center;
  width: 100%;
`,p=l.e.div`
  z-index: ${e=>{let{index:t}=e;return t+1}};
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
`;var m=e=>{let{index:t,dividerPosition:n,dividerComponent:i,concave:l,clipFill:r,dividerFill:c}=e;const o="top"===n&&!l,a="bottom"===n&&!l,d="top"===n&&l,m="bottom"===n&&l;return Object(s.jsxs)(u,{index:t,dividerFill:c,children:[i&&Object(s.jsx)(p,{index:t,children:i}),Object(s.jsxs)(s.Fragment,{children:[d&&Object(s.jsx)(b,{clipFill:r}),m&&Object(s.jsx)(h,{clipFill:r})]}),Object(s.jsxs)(s.Fragment,{children:[o&&Object(s.jsx)(j,{clipFill:r}),a&&Object(s.jsx)(x,{clipFill:r})]})]})};const O=Object(l.e)(r.M)`
  position: relative;
  flex-direction: column;
  align-items: center;
  z-index: ${e=>{let{index:t}=e;return t-1}};
  background: ${e=>{let{background:t}=e;return t||"none"}};
  padding: ${e=>{let{getPadding:t}=e;return t()}};
`,g=Object(l.e)(c.a)`
  min-height: auto;
  padding-top: 16px;
  padding-bottom: 16px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding-top: 32px;
    padding-bottom: 32px;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    padding-top: 48px;
    padding-bottom: 48px;
  }
`;var f=e=>{let{children:t,background:n,svgFill:i,index:l=1,dividerComponent:c,dividerPosition:o="bottom",hasCurvedDivider:a=!0,concaveDivider:d=!1,clipFill:j,dividerFill:x,containerProps:b,innerProps:h,...u}=e;return Object(s.jsxs)(r.j,{...b,children:[a&&"top"===o&&Object(s.jsx)(m,{svgFill:i,index:l,concave:d,dividerPosition:o,dividerComponent:c,clipFill:j,dividerFill:x}),Object(s.jsx)(O,{background:n,index:l,getPadding:()=>a?"bottom"===o?"48px 0 14px":"top"===o?"14px 0 48px":"48px 0":"48px 0",...u,children:Object(s.jsx)(g,{...h,children:t})}),a&&"bottom"===o&&Object(s.jsx)(m,{svgFill:i,index:l,concave:d,dividerPosition:o,dividerComponent:c,clipFill:j,dividerFill:x})]})},v=n(27),y=n(7),w=n(1005),$=n(60);const C=(e,t)=>l.f`
  from {
    transform: translate(0,  0px);
  }
  50% {
    transform: translate(${e}, ${t});
  }
  to {
    transform: translate(0, 0px);
  }  
`,k=Object(l.e)(r.j)`
  position: relative;
  max-height: ${e=>{let{maxHeight:t}=e;return t}};

  & :nth-child(2) {
    animation: ${C("3px","15px")} 3s ease-in-out infinite;
    animation-delay: 1s;
  }

  & :nth-child(3) {
    animation: ${C("5px","10px")} 3s ease-in-out infinite;
    animation-delay: 0.66s;
  }

  & :nth-child(4) {
    animation: ${C("6px","5px")} 3s ease-in-out infinite;
    animation-delay: 0.33s;
  }

  & :nth-child(5) {
    animation: ${C("4px","12px")} 3s ease-in-out infinite;
    animation-delay: 0s;
  }
`,S=l.e.img`
  max-height: ${e=>{let{maxHeight:t}=e;return t}};
  visibility: hidden;
`,M=Object(l.e)(r.j)`
  height: 100%;
  position: absolute;
  top: 0;
  left: 0;

  img {
    max-height: 100%;
    width: auto;
  }
`;var P=function(e){return e.MD="1.5x",e.LG="2x",e}(P||{});const D=(e,t,n)=>`${e}${t}${n?`@${n}.png`:".png"}`,F=(e,t)=>`${D(e,t)} 512w, \n  ${D(e,t,P.MD)} 768w, \n  ${D(e,t,P.LG)} 1024w,`;var E=e=>{let{path:t,attributes:n,maxHeight:i}=e;return Object(s.jsxs)(k,{maxHeight:i,children:[Object(s.jsx)(S,{src:D(t,n[0].src),maxHeight:i,srcSet:F(t,n[0].src)}),n.map(e=>Object(s.jsx)(M,{children:Object(s.jsx)("img",{src:D(t,e.src),srcSet:F(t,e.src),alt:e.alt})},e.src))]})};const T=()=>l.f`
  from {
    transform: translate(0,  0px);
  }
  50% {
    transform: translate(-7px, -7px);
  }
  to {
    transform: translate(0, 0px);
  }  
`,L=Object(l.e)(r.M)`
  padding: 0;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding: 0 24px;
  }
`,I=l.e.div`
  width: 90%;
  animation: ${T} 4s ease-in-out infinite;
`,z=l.e.div`
  position: absolute;
  top: 0;
  left: 0;
  animation: ${T} 2s ease-in-out infinite;
`,B="/images/home/glider/",N="glider1",Q={path:"/images/home/glider/",attributes:[{src:"butterfly",alt:"Butterfly"}]};var G=()=>{const{t:e}=Object(y.b)(),{account:t}=Object(v.c)();return Object(s.jsx)(s.Fragment,{children:Object(s.jsxs)(L,{position:"relative",flexDirection:["column-reverse",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:[Object(s.jsxs)(r.M,{flex:"1",flexDirection:"column",justifyContent:"flex-start",children:[Object(s.jsx)(r.N,{scale:"xl",mb:"24px",color:"glide",children:e("Glide into a new kind of finance")}),Object(s.jsx)(r.P,{scale:"md",mb:"24px",children:e("The first native farm and exchange on Elastos")}),Object(s.jsxs)(r.M,{children:[!t&&Object(s.jsx)($.a,{mr:"8px"}),Object(s.jsx)(r.W,{mr:"16px",href:"/swap",children:Object(s.jsx)(r.m,{variant:t?"primary":"secondary",children:e("Trade Now")})})]})]}),Object(s.jsxs)(r.M,{flex:[null,null,null,"1"],mb:["24px",null,null,"0"],position:"relative",children:[Object(s.jsx)(I,{children:Object(s.jsx)("img",{src:`${B}${N}.png`,srcSet:F(B,N),alt:e("Glider")})}),Object(s.jsx)(z,{children:Object(s.jsx)(E,{...Q})})]})]})})};const W=()=>l.f`
  from {
    opacity: 0.9;
  }
  50% {
    opacity: 0.1;
  }
  to {
    opacity: 0.9;
  }  
`,H=Object(l.e)(r.M)`
  padding: 0;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    width: 65%;
    margin: 0 auto;
  }
`,A=l.e.div`
  width: 90%;
  animation: ${()=>l.f`
  from {
    transform: translate(0,  0px);
  }
  50% {
    transform: translate(-5px, -5px);
  }
  to {
    transform: translate(0, 0px);
  }  
`} 3.5s ease-in-out infinite;
`,q=l.e.div`
  position: absolute;
  top: 0;
  left: 0;

  & :nth-child(2) {
    animation: ${W} 2s ease-in-out infinite;
    animation-delay: 1s;
  }

  & :nth-child(3) {
    animation: ${W} 4s ease-in-out infinite;
    animation-delay: 0.66s;
  }

  & :nth-child(4) {
    animation: ${W} 2.5s ease-in-out infinite;
    animation-delay: 0.33s;
  }
`,U="/images/home/rocket/",R="rocket1",Z={path:"/images/home/rocket/",attributes:[{src:"star-l",alt:"3D Star"},{src:"star-top-r",alt:"3D Star"},{src:"star-bottom-r",alt:"3D Star"}]};var _=()=>{const{t:e}=Object(y.b)();return Object(s.jsx)(s.Fragment,{children:Object(s.jsx)(H,{position:"relative",flexDirection:["column-reverse",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:Object(s.jsxs)(r.M,{flex:[null,null,null,"1"],mb:["24px"],mt:["10vh"],position:"relative",children:[Object(s.jsx)(A,{children:Object(s.jsx)("img",{src:`${U}${R}.png`,srcSet:F(U,R),alt:e("Glide rocket")})}),Object(s.jsx)(q,{children:Object(s.jsx)(E,{...Z})})]})})})},J=n(54);const V=Object(l.e)(r.q)`
  height: fit-content;
  padding: 1px 1px 4px 1px;
  box-sizing: border-box;

  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    ${e=>{let{rotation:t}=e;return t?`transform: rotate(${t});`:""}}
  }
`,Y=Object(l.e)(r.r)`
  background: ${e=>{let{theme:t}=e;return t.colors.overlay}};
`,K=Object(l.e)(r.j)`
  display: flex;
  justify-content: center;
  align-items: center;
  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    ${e=>{let{rotation:t}=e;return t?`transform: rotate(${t});`:""}}
  }
`;var X=e=>{let{icon:t,background:n,borderColor:i,rotation:l,children:r,...c}=e;return Object(s.jsx)(V,{background:n,borderBackground:i,rotation:l,...c,children:Object(s.jsxs)(Y,{children:[Object(s.jsx)(K,{rotation:l,children:t}),r]})})};var ee=e=>{let{headingText:t,bodyText:n,highlightColor:i}=e;const l=t.split(" "),c=l.pop(),o=l.slice(0,l.length).join(" ");return Object(s.jsxs)(r.M,{flexDirection:"column",alignItems:"center",justifyContent:"center",mt:[null,null,null,"24px"],children:[Object(s.jsx)(r.P,{scale:"xl",children:o}),Object(s.jsx)(r.P,{color:i,scale:"xl",mb:"24px",children:c}),Object(s.jsx)(r.xb,{textAlign:"center",color:"textSubtle",children:n})]})};var te=()=>{const{t:e}=Object(y.b)(),{theme:t}=Object(J.a)(),n={icon:Object(s.jsx)("img",{src:"/images/home/pitch/trade.png",alt:e("Trade")})},i={icon:Object(s.jsx)("img",{src:"/images/home/pitch/wallet.png",alt:e("Trade")})},l={icon:Object(s.jsx)("img",{src:"/images/home/pitch/percent.png",alt:e("Trade")})};return Object(s.jsxs)(r.M,{justifyContent:"center",alignItems:"center",flexDirection:"column",children:[Object(s.jsx)(r.N,{textAlign:"center",scale:"xl",color:"glide",mb:"32px",children:e("Why DeFi?")}),Object(s.jsxs)(r.M,{flexDirection:["column",null,null,"row"],children:[Object(s.jsx)(X,{...n,mr:["16px"],mb:["16px"],children:Object(s.jsx)(ee,{headingText:e("Trade Tokens"),bodyText:e("Swap tokens with minimal fees and arbitrage against other exchanges"),highlightColor:t.colors.secondary})}),Object(s.jsx)(X,{...i,mr:["16px"],mb:["16px"],children:Object(s.jsx)(ee,{headingText:e("Supply Liquidity"),bodyText:e("Contribute to a pool and collect swap fees"),highlightColor:t.colors.primaryBright})}),Object(s.jsx)(X,{...l,mr:["16px"],mb:["16px"],children:Object(s.jsx)(ee,{headingText:e("Earn at Farms"),bodyText:e("Stake your liquidity provider tokens in farms to earn GLIDE!"),highlightColor:t.colors.secondary})})]})]})};const ne=Object(l.e)(r.M)`
  padding: 0;
  margin-bottom: 15vh;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding: 0 24px;
  }
`,ie=l.e.img`
  width: 164px;
  margin-right: 50%;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    width: 324px;
  }
`,le=l.e.div`
  display: flex;
  align-items: center;
  justify-content: center;
  padding-bottom: 20px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
  }

  animation: ${()=>l.f`
  from {
    transform: translate(0,  0px);
  }
  50% {
    transform: translate(100px, 16px);
  }
  to {
    transform: translate(0, 0px);
  }  
`} 4s ease-in-out infinite;
`,re=l.e.div`
  width: 90%;
  animation: ${()=>l.f`
  from {
    transform: translate(0,  0px);
  }
  50% {
    transform: translate(-7px, -7px);
  }
  to {
    transform: translate(0, 0px);
  }  
`} 4s ease-in-out infinite;
`,ce="/images/home/details/";var se=()=>{const{t:e}=Object(y.b)();return Object(s.jsxs)(s.Fragment,{children:[Object(s.jsx)(le,{children:Object(s.jsx)(ie,{src:`${ce}glider2.png`,srcSet:F(ce,"glider2"),alt:e("Glider")})}),Object(s.jsxs)(r.M,{justifyContent:"center",alignItems:"center",flexDirection:"column",children:[Object(s.jsx)(r.N,{textAlign:"center",scale:"xl",color:"glide",mb:"48px",children:e("Why Glide?")}),Object(s.jsxs)(ne,{position:"relative",flexDirection:["column-reverse",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:[Object(s.jsxs)(r.M,{flex:"1",flexDirection:"column",justifyContent:"flex-start",children:[Object(s.jsx)(r.P,{scale:"xl",mb:"24px",color:"secondary",children:e("Elastos Smart Chain")}),Object(s.jsx)(r.P,{scale:"md",mb:"24px",color:"text",children:e("ESC is a sidechain to the Elastos mainchain that supports Solidity smart contracts. Consensus runs on DPoS to deliver a high-performance, scalable smart contract execution solution for the Elastos ecosystem.")}),Object(s.jsx)(r.M,{children:Object(s.jsx)(r.W,{external:!0,mr:"16px",href:"https://www.elastos.org/esc/",children:Object(s.jsx)(r.m,{variant:"secondary",children:e("Learn More")})})})]}),Object(s.jsx)(r.M,{flex:[null,null,null,"1"],mb:["24px",null,null,"0"],position:"relative",children:Object(s.jsx)(re,{children:Object(s.jsx)("img",{src:`${ce}shield.png`,srcSet:F(ce,"shield"),alt:e("Shield")})})})]}),Object(s.jsxs)(ne,{position:"relative",flexDirection:["column",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:[Object(s.jsx)(r.M,{flex:[null,null,null,"1"],mb:["24px",null,null,"0"],position:"relative",children:Object(s.jsx)(re,{children:Object(s.jsx)("img",{src:`${ce}coins.png`,srcSet:F(ce,"coins"),alt:e("Coins")})})}),Object(s.jsxs)(r.M,{flex:"1",flexDirection:"column",justifyContent:"flex-start",children:[Object(s.jsx)(r.P,{scale:"xl",mb:"24px",color:"secondary",children:e("Fully Supports $ELA")}),Object(s.jsx)(r.P,{scale:"md",mb:"24px",color:"text",children:e("Glide was built for Elastos exclusively. 80% of all swap fees on the platform are converted to $ELA and shared with platform users.")}),Object(s.jsx)(r.M,{children:Object(s.jsx)(r.W,{external:!0,mr:"16px",href:"https://www.elastos.org/",children:Object(s.jsx)(r.m,{variant:"secondary",children:e("Explore Elastos")})})})]})]}),Object(s.jsxs)(ne,{position:"relative",flexDirection:["column-reverse",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:[Object(s.jsxs)(r.M,{flex:"1",flexDirection:"column",justifyContent:"flex-start",children:[Object(s.jsx)(r.P,{scale:"xl",mb:"24px",color:"secondary",children:e("Audited by Paladin")}),Object(s.jsx)(r.P,{scale:"md",mb:"24px",color:"text",children:e("We take your asset safety seriously, so we had our contracts reviewed by one of the leading security organizations.")}),Object(s.jsx)(r.M,{children:Object(s.jsx)(r.W,{external:!0,mr:"16px",href:"https://github.com/glide-finance/audits/blob/master/Paladin_Glide_Finance_Final_Report.pdf",children:Object(s.jsx)(r.m,{variant:"secondary",children:e("Read Now")})})})]}),Object(s.jsx)(r.M,{flex:[null,null,null,"1"],mb:["24px",null,null,"0"],position:"relative",children:Object(s.jsx)(re,{children:Object(s.jsx)("img",{src:`${ce}stamp.png`,srcSet:F(ce,"stamp"),alt:e("Audit")})})})]}),Object(s.jsxs)(ne,{position:"relative",flexDirection:["column",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:[Object(s.jsx)(r.M,{flex:[null,null,null,"1"],mb:["24px",null,null,"0"],position:"relative",children:Object(s.jsx)(re,{children:Object(s.jsx)("img",{src:`${ce}thumb.png`,srcSet:F(ce,"thumb"),alt:e("Thumbs up")})})}),Object(s.jsxs)(r.M,{flex:"1",flexDirection:"column",justifyContent:"flex-start",children:[Object(s.jsx)(r.P,{scale:"xl",mb:"24px",color:"secondary",children:e("Fair Launch")}),Object(s.jsx)(r.P,{scale:"md",mb:"24px",color:"text",children:e("No pre-sale or pre-mine. Equal opportunity for all.")}),Object(s.jsx)(r.M,{children:Object(s.jsx)(r.W,{external:!0,mr:"16px",href:"https://docs.glidefinance.io/",children:Object(s.jsx)(r.m,{variant:"secondary",children:e("Tokenomics")})})})]})]})]})]})};const oe=Object(l.e)(r.M)`
  padding: 0;
`,ae=l.e.div`
  width: 90%;
`,de="/images/home/partners/";var je=()=>{const{t:e}=Object(y.b)();return Object(s.jsxs)(r.M,{justifyContent:"center",alignItems:"center",flexDirection:"column",children:[Object(s.jsx)(r.N,{textAlign:"center",scale:"xl",color:"glide",children:e("Our Partners")}),Object(s.jsx)(oe,{position:"relative",flexDirection:["column-reverse",null,null,"row"],alignItems:["flex-end",null,null,"center"],justifyContent:"center",children:Object(s.jsx)(r.M,{flex:[null,null,null,"1"],mb:["0",null,null,"0"],position:"relative",justifyContent:"center",children:Object(s.jsx)(ae,{children:Object(s.jsx)("img",{src:`${de}partners.png`,srcSet:F(de,"partners"),alt:e("Partners")})})})})]})},xe=n(87),be=n(13),he=n(10),ue=n(56),pe=n(31),me=n(98),Oe=n(142),ge=n(6),fe=n.n(ge),ve=n(34),ye=n(806);const we=Object(l.e)(r.M)`
  flex-direction: column;
`,$e=l.e.div`
  display: grid;
  grid-gap: 16px 8px;
  grid-template-columns: repeat(1, auto);
  justify-content: center;

  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    grid-gap: 32px;
    grid-template-columns: repeat(4, auto);
    padding: 0 16px;
    justify-content: space-between;
  }
`;var Ce=()=>{const{t:e}=Object(y.b)(),{currentBlock:t}=Object(Oe.a)(),{pools:n}=Object(ve.l)(),[i]=Object(ye.j)(),l=Object(xe.g)(),c=Object(he.d)(Object(xe.c)(Object(be.f)())),o=Object(he.d)(Object(xe.d)(Object(be.f)())),a=Object(he.d)(Object(xe.h)(Object(be.f)())),d=l?Object(he.d)(l)-c-o-a:0,j=Object(ue.f)().times(d),x=Object(he.a)(j.toNumber()),b=Object(me.a)(new fe.a(t)).toNumber(),h=(i?Math.ceil(i.liquidityUSD):void 0)+Math.ceil(function(e){let t=new fe.a(0);return e.forEach(e=>{if(!e.stakingTokenPrice||!e.totalStaked||!e.stakingToken.decimals)return;const n=Object(he.d)(e.totalStaked,e.stakingToken.decimals);t=new fe.a(n).times(e.stakingTokenPrice).plus(t)}),t}(n).toNumber());return Object(s.jsxs)($e,{children:[Object(s.jsxs)(r.M,{flexDirection:"column",children:[h?Object(s.jsx)(pe.a,{decimals:2,prefix:"$",fontSize:"32px",bold:!0,value:h}):Object(s.jsx)(r.rb,{height:24,width:126,my:"4px"}),Object(s.jsx)(r.xb,{fontSize:"20px",color:"textSubtle",children:e("Total value locked")})]}),Object(s.jsxs)(we,{children:[d?Object(s.jsx)(pe.a,{decimals:0,fontSize:"32px",bold:!0,value:d}):Object(s.jsx)(r.rb,{height:24,width:126,my:"4px"}),Object(s.jsx)(r.xb,{fontSize:"20px",color:"textSubtle",children:e("Circulating GLIDE")})]}),Object(s.jsxs)(we,{children:[null!==j&&void 0!==j&&j.gt(0)&&x?Object(s.jsx)(r.xb,{fontSize:"32px",children:e("$%marketCap%",{marketCap:x})}):Object(s.jsx)(r.rb,{height:24,width:126,my:"4px"}),Object(s.jsx)(r.xb,{fontSize:"20px",color:"textSubtle",children:e("Market cap")})]}),Object(s.jsxs)(we,{children:[Object(s.jsx)(r.xb,{fontSize:"32px",children:e("%cakeEmissions%/block",{cakeEmissions:b.toFixed(3)})}),Object(s.jsx)(r.xb,{fontSize:"20px",color:"textSubtle",children:e("Emission rate")})]})]})},ke=n(51),Se=n(25),Me=n(85),Pe=n(41),De=n(163),Fe=n(33),Ee=n(59),Te=n(35);var Le=()=>{const[e,t]=Object(i.useState)([]),[n,l]=Object(i.useState)(null),{account:r}=Object(v.c)(),{fastRefresh:c}=Object(Ee.a)();return Object(i.useEffect)(()=>{r&&(async()=>{const e=Fe.z.map(e=>({address:Object(be.o)(),name:"pendingGlide",params:[e.pid,r]})),n=await Object(Pe.a)(De,e),i=Fe.z.map((e,t)=>({...e,balance:new fe.a(n[t])})).filter(e=>e.balance.gt(0)),c=i.reduce((e,t)=>{const n=new fe.a(t.balance);return n.eq(0)?e:e+n.div(Te.g).toNumber()},0);t(i),l(c)})()},[r,c]),{farmsWithStakedBalance:e,earningsSum:n}};const Ie=Object(l.e)(r.q)`
  width: 100%;
  height: fit-content;
`;var ze=()=>{const[e,t]=Object(i.useState)(!1),{t:n}=Object(y.b)(),{toastSuccess:l,toastError:c}=Object(ke.a)(),{farmsWithStakedBalance:o,earningsSum:a}=Le(),{chainId:d,library:j}=Object(v.c)(),x=Object(Se.i)(),b=Object(ue.f)(),h=new fe.a(a).multipliedBy(b),u=o.length,p=n("%earningsUsdc% to collect from %count% %farms%",{earningsUsdc:h.toString(),count:u>0?u:"",farms:0===u||u>1?"farms":"farm"}),[m,O]=p.split(h.toString()),g=Object(i.useCallback)(async()=>{t(!0);for(const t of o)try{await Object(me.c)(x,t.pid),l(`${n("Harvested")}!`,n("Your %symbol% earnings have been sent to your wallet!",{symbol:"GLIDE"}))}catch(e){c(n("Error"),n("Please try again. Confirm the transaction and make sure you are paying enough gas!"))}t(!1)},[o,x,l,c,n]);return Object(s.jsx)(Ie,{children:Object(s.jsx)(r.r,{children:Object(s.jsxs)(r.M,{flexDirection:["column",null,null,"row"],justifyContent:"space-between",alignItems:"center",children:[Object(s.jsxs)(r.M,{flexDirection:"column",alignItems:["center",null,null,"flex-start"],children:[m&&Object(s.jsx)(r.xb,{mb:"4px",color:"textSubtle",children:m}),h&&!h.isNaN()?Object(s.jsx)(pe.a,{decimals:h.gt(0)?2:0,fontSize:"24px",bold:!0,prefix:h.gt(0)?"~$":"$",lineHeight:"1.1",value:h.toNumber()}):Object(s.jsx)(r.rb,{width:96,height:24,my:"2px"}),Object(s.jsx)(r.xb,{mb:["16px",null,null,"0"],color:"textSubtle",children:O})]}),u<=0?Object(s.jsx)(r.W,{href:"farms",children:Object(s.jsxs)(r.m,{width:["100%",null,null,"auto"],variant:"secondary",children:[Object(s.jsx)(r.xb,{color:"primary",bold:!0,children:n("Start earning")}),Object(s.jsx)(r.e,{ml:"4px",color:"primary"})]})}):Object(s.jsx)(s.Fragment,{children:20!==d?Object(s.jsx)(r.m,{onClick:()=>{Object(Me.b)(20,j)},children:n("Switch to Elastos")}):Object(s.jsx)(r.m,{width:["100%",null,null,"auto"],id:"harvest-all",isLoading:e,endIcon:e?Object(s.jsx)(r.f,{spin:!0,color:"currentColor"}):null,disabled:e,onClick:g,children:Object(s.jsx)(r.xb,{color:"contrast",bold:!0,children:n(e?"Harvesting":"Harvest all")})})})]})})})};var Be=function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:4,n=arguments.length>2&&void 0!==arguments[2]?arguments[2]:4;return`${e.substring(0,t)}...${e.substring(e.length-n)}`};const Ne=Object(l.e)(r.M)`
  align-items: center;
  display: none;
  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    display: flex;
  }
`;var Qe=()=>{const{t:e}=Object(y.b)(),{account:t}=Object(v.c)(),n=Be(t);return Object(s.jsx)(s.Fragment,{children:Object(s.jsx)(Ne,{children:Object(s.jsx)(r.M,{flexDirection:"column",children:t?Object(s.jsxs)(r.xb,{fontSize:"16px",children:[" ",e("Connected with %address%",{address:n})]}):Object(s.jsx)(r.rb,{width:160,height:16,my:"4px"})})})})};const Ge=Object(l.e)(r.j)`
  border-radius: ${e=>{let{theme:t}=e;return t.radii.card}};
  background: ${e=>{let{theme:t}=e;return t.isDark?"linear-gradient(139.73deg, #0E1730 0%, #173560 100%)":"linear-gradient(180deg, rgba(202, 194, 236, 0.9) 0%,  rgba(204, 220, 239, 0.9) 51.04%, rgba(206, 236, 243, 0.9) 100%)"}};
`;var We=()=>Object(s.jsx)(Ge,{children:Object(s.jsx)(r.j,{p:["16px",null,null,"24px"],children:Object(s.jsxs)(r.M,{alignItems:"center",justifyContent:"center",flexDirection:["column",null,null,"row"],children:[Object(s.jsx)(r.M,{flex:"1",mr:[null,null,null,"32px"],children:Object(s.jsx)(Qe,{})}),Object(s.jsx)(r.M,{flex:"1",width:["100%",null,"auto"],children:Object(s.jsx)(ze,{})})]})})});const He=l.e.div``,Ae=Object(l.e)(f)`
  padding-top: 16px;
  padding-bottom: 0;

  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    padding-top: 0px;
    padding-bottom: 0px;
  }
`,qe=Object(l.e)(f)`
  padding-top: 32px;
  padding-botom: 0;

  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    padding-top: 0px;
    padding-bottom: 10vh;
  }
`,Ue=Object(l.e)(c.a)`
  z-index: 1;
  width: 100%;
  padding-left: 16px;
  padding-right: 16px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    padding-left: 24px;
    padding-right: 24px;
  }
`,Re=l.e.div`
  display: flex;
  justify-content: center;
  padding-top: 5px;
  padding-bottom: 5px;
`;t.default=()=>{const{t:e}=Object(y.b)(),t=Object(i.useRef)(null),{account:n}=Object(v.c)();return Object(s.jsxs)(s.Fragment,{children:[Object(s.jsx)(w.b,{}),Object(s.jsxs)(He,{ref:t,children:[n&&Object(s.jsx)(Ue,{children:Object(s.jsx)(We,{})}),Object(s.jsx)(Ae,{innerProps:{style:{margin:"0",width:"100%"}},index:2,hasCurvedDivider:!1,children:Object(s.jsx)(G,{})}),Object(s.jsxs)(qe,{index:2,hasCurvedDivider:!1,children:[Object(s.jsx)(Ce,{}),Object(s.jsx)(_,{})]}),Object(s.jsx)(qe,{index:2,hasCurvedDivider:!1,children:Object(s.jsx)(te,{})}),Object(s.jsx)(Ae,{innerProps:{style:{margin:"0",width:"100%"}},index:2,hasCurvedDivider:!1,children:Object(s.jsx)(se,{})}),Object(s.jsx)(Ae,{innerProps:{style:{margin:"0",width:"100%"}},index:2,hasCurvedDivider:!1,children:Object(s.jsx)(je,{})}),Object(s.jsx)(Re,{children:Object(s.jsxs)(r.m,{scale:"md",variant:"text",onClick:()=>{t.current.scrollIntoView({behavior:"smooth"})},children:[e("Return To Top"),Object(s.jsx)(r.B,{color:"primary"})]})})]})]})}}}]);
//# sourceMappingURL=13.b50913ae.chunk.js.map
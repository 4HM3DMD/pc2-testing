(this["webpackJsonpglide-frontend"]=this["webpackJsonpglide-frontend"]||[]).push([[14],{1249:function(e,t,s){"use strict";s.r(t);var r=s(1),n=s.n(r),c=s(63),i=s(1005),o=s(3),l=s(58),a=s(2),d=s(7),j=s(795),b=s(794),x=s(806),p=s(799);const h=j.gql`
  query tokens($symbol: String, $name: String, $id: String) {
    asSymbol: tokens(first: 10, where: { symbol_contains: $symbol }, orderBy: tradeVolumeUSD, orderDirection: desc) {
      id
    }
    asName: tokens(first: 10, where: { name_contains: $name }, orderBy: tradeVolumeUSD, orderDirection: desc) {
      id
    }
    asAddress: tokens(first: 1, where: { id: $id }, orderBy: tradeVolumeUSD, orderDirection: desc) {
      id
    }
  }
`,u=j.gql`
  query pools($tokens: [Bytes]!, $id: String) {
    as0: pairs(first: 10, where: { token0_in: $tokens }) {
      id
    }
    as1: pairs(first: 10, where: { token1_in: $tokens }) {
      id
    }
    asAddress: pairs(first: 1, where: { id: $id }) {
      id
    }
  }
`,O=e=>{const t=e.reduce((e,t)=>[...e,...t],[]).map(e=>e.id);return Array.from(new Set(t))};var m=e=>{const[t,s]=Object(r.useState)({tokens:[],pools:[],loading:!1,error:!1}),n=e.length<p.c;Object(r.useEffect)(()=>{s({tokens:[],pools:[],loading:!n,error:!1})},[e,n]),Object(r.useEffect)(()=>{n||(async()=>{try{const t=await Object(j.request)(b.c,h,{symbol:e.toUpperCase(),name:e.charAt(0).toUpperCase()+e.slice(1),id:e.toLowerCase()}),r=O([t.asAddress,t.asSymbol,t.asName]),n=await Object(j.request)(b.c,u,{tokens:r,id:e.toLowerCase()});s({tokens:r,pools:O([n.asAddress,n.as0,n.as1]),loading:!1,error:!1})}catch(t){console.error(`Search failed for ${e}`,t),s({tokens:[],pools:[],loading:!1,error:!0})}})()},[e,n]);const c=Object(x.n)(t.tokens),i=Object(x.f)(t.pools);return{tokens:c,pools:i,tokensLoading:c.length!==t.tokens.length||t.loading,poolsLoading:i.length!==t.pools.length||t.loading,error:t.error}},f=s(32),g=s(35),y=s(0);const v=[];var k=e=>{let{src:t,alt:s,...n}=e;const[,c]=Object(r.useState)(0),i=v.includes(t);return t&&!i?Object(y.jsx)("img",{...n,alt:s,src:t,onError:()=>{t&&v.push(t),c(e=>e+1)}}):Object(y.jsx)(a.R,{...n})};const S=Object(o.e)(k)`
  width: ${e=>{let{size:t}=e;return t}};
  height: ${e=>{let{size:t}=e;return t}};
  border-radius: ${e=>{let{size:t}=e;return t}};
  box-shadow: 0px 6px 10px rgba(0, 0, 0, 0.075);
  background-color: ${e=>{let{theme:t}=e;return t.colors.background}};
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
`,C=e=>{let{address:t,size:s="24px",...n}=e;const c=Object(r.useMemo)(()=>{const e=Object(f.h)(t);return e?`${g.d}/images/tokens/${e}.png`:null},[t]);return Object(y.jsx)(S,{size:s,src:c,alt:"token logo",...n})},w=o.e.div`
  position: relative;
  display: flex;
  flex-direction: row;
  align-items: center;
  width: 32px;
`,D=e=>{let{address0:t,address1:s,size:r=16}=e;return Object(y.jsxs)(w,{children:[t&&Object(y.jsx)(C,{address:t,size:`${r.toString()}px`}),s&&Object(y.jsx)(C,{address:s,size:`${r.toString()}px`})]})};var T=s(1019),$=s.n(T);const M=(e,t)=>{const{notation:s="compact",displayThreshold:r,tokenPrecision:n,isInteger:c}=t||{notation:"compact"};if(0===e)return c?"0":"0.00";if(!e)return"-";if(r&&e<r)return`<${r}`;if(e<1&&!n)return e.toFixed(11).match(/^-?\d*\.?0*\d{0,2}/)[0];let i=2;n&&(i=e<1?3:2);let o=`0.${"0".repeat(i)}a`;"standard"===s&&(o=`0,0.${"0".repeat(i)}`),c&&e<1e3&&(o="0");const l=parseFloat(e.toFixed(i));return $()(l).format(o).toUpperCase()};var z=s(50),L=s(54);const U=o.e.div`
  display: flex;
  justify-content: center;
  align-items: center;
  :hover {
    cursor: pointer;
    opacity: 0.6;
  }
`;var N=e=>{let{fill:t=!1,...s}=e;const{theme:r}=Object(L.a)();return Object(y.jsx)(U,{...s,children:t?Object(y.jsx)(a.tb,{stroke:r.colors.warning,color:r.colors.warning}):Object(y.jsx)(a.ub,{stroke:r.colors.textDisabled})})},P=s(121);const A=o.e.div`
  position: relative;
  z-index: 30;
  width: 100%;
`,I=Object(o.e)(a.V)`
  z-index: 9999;
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.inputSecondary}};
`,E=o.e.div`
  display: flex;
  flex-direction: column;
  z-index: 9999;
  width: 100%;
  top: 50px;
  max-height: 400px;
  overflow: auto;
  right: 0;
  padding: 1.5rem;
  padding-bottom: 2.5rem;
  position: absolute;
  background: ${e=>{let{theme:t}=e;return t.colors.background}};
  border-radius: 8px;
  box-shadow: 0px 0px 1px rgba(0, 0, 0, 0.04), 0px 4px 8px rgba(0, 0, 0, 0.04), 0px 16px 24px rgba(0, 0, 0, 0.04),
    0px 24px 32px rgba(0, 0, 0, 0.04);
  display: ${e=>{let{hide:t}=e;return t&&"none"}};
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.secondary}};
  margin-top: 4px;
  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    margin-top: 0;
    width: 500px;
    max-height: 600px;
  }
  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    margin-top: 0;
    width: 800px;
    max-height: 600px;
  }
`,F=o.e.div`
  position: absolute;
  min-height: 100vh;
  width: 100vw;
  z-index: 10;
  background-color: black;
  opacity: 0.7;
  left: 0;
  top: 0;
`,q=o.e.div`
  display: grid;
  grid-gap: 1em;
  grid-template-columns: 1fr;
  margin: 8px 0;
  align-items: center;
  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    grid-template-columns: 1.5fr repeat(3, 1fr);
  }
`,V=o.e.div`
  height: 1px;
  background-color: ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
  width: 100%;
  margin: 16px 0;
`,H=o.e.div`
  color: ${e=>{let{theme:t}=e;return t.colors.secondary}};
  display: ${e=>{let{hide:t}=e;return t?"none":"block"}};
  margin-top: 16px;
  :hover {
    cursor: pointer;
    opacity: 0.6;
  }
`,W=o.e.div`
  :hover {
    cursor: pointer;
    opacity: 0.6;
  }
`,R=o.e.div`
  width: fit-content;
  padding: 4px 8px;
  border-radius: 8px;
  display: flex;
  font-size: 12px;
  font-weight: 600;
  margin-right: 10px;
  justify-content: center;
  align-items: center;
  background-color: ${e=>{let{theme:t,enabled:s}=e;return s?t.colors.primary:"transparent"}};
  color: ${e=>{let{theme:t,enabled:s}=e;return s?t.card.background:t.colors.secondary}};
  :hover {
    opacity: 0.6;
    cursor: pointer;
  }
`,B=(e,t)=>e.address.toLowerCase().includes(t.toLowerCase())||e.symbol.toLowerCase().includes(t.toLowerCase())||e.name.toLowerCase().includes(t.toLowerCase());var Q=()=>{const e=Object(c.g)(),{isXs:t,isSm:s}=Object(a.Nb)(),{t:n}=Object(d.b)(),i=Object(r.useRef)(null),o=Object(r.useRef)(null),l=Object(r.useRef)(null),[j,b]=Object(r.useState)(!1),[h,u]=Object(r.useState)(""),O=Object(P.a)(h,600),{tokens:f,pools:g,tokensLoading:v,poolsLoading:k,error:S}=m(O),[w,T]=Object(r.useState)(3),[$,L]=Object(r.useState)(3);Object(r.useEffect)(()=>{T(3),L(3)},[O]);const U=e=>{const t=o.current&&o.current.contains(e.target),s=i.current&&i.current.contains(e.target),r=l.current&&l.current.contains(e.target);t||s||r||(L(3),T(3),b(!1))};Object(r.useEffect)(()=>(j?(document.addEventListener("click",U),document.querySelector("body").style.overflow="hidden"):(document.removeEventListener("click",U),document.querySelector("body").style.overflow="visible"),()=>{document.removeEventListener("click",U)}),[j]);const[Q,X]=Object(z.n)(),[Y,K]=Object(z.m)(),G=t=>{b(!1),L(3),T(3),e.push(t)},_=Object(x.n)(Q),J=_.length!==Q.length,Z=Object(x.f)(Y),ee=Z.length!==Y.length,[te,se]=Object(r.useState)(!1),re=Object(r.useMemo)(()=>te?_.filter(e=>B(e,h)):f.sort((e,t)=>e.volumeUSD>t.volumeUSD?-1:1),[te,f,_,h]),ne=Object(r.useMemo)(()=>te?Z.filter(e=>((e,t)=>e.address.toLowerCase().includes(t.toLowerCase())||B(e.token0,t)||B(e.token1,t))(e,h)):g.sort((e,t)=>e.volumeUSD>t.volumeUSD?-1:1),[g,te,Z,h]);return Object(y.jsxs)(y.Fragment,{children:[j?Object(y.jsx)(F,{}):null,Object(y.jsxs)(A,{children:[Object(y.jsx)(I,{type:"text",value:h,onChange:e=>{u(e.target.value)},placeholder:n("Search pools or tokens"),ref:i,onFocus:()=>{b(!0)}}),Object(y.jsxs)(E,{hide:!j,ref:o,children:[Object(y.jsxs)(a.M,{mb:"16px",children:[Object(y.jsx)(R,{enabled:!te,onClick:()=>se(!1),children:n("Search")}),Object(y.jsx)(R,{enabled:te,onClick:()=>se(!0),children:n("Watchlist")})]}),S&&Object(y.jsx)(a.xb,{color:"failure",children:n("Error occurred, please try again")}),Object(y.jsxs)(q,{children:[Object(y.jsx)(a.xb,{bold:!0,color:"secondary",children:n("Tokens")}),!t&&!s&&Object(y.jsx)(a.xb,{textAlign:"end",fontSize:"12px",children:n("Price")}),!t&&!s&&Object(y.jsx)(a.xb,{textAlign:"end",fontSize:"12px",children:n("Volume 24H")}),!t&&!s&&Object(y.jsx)(a.xb,{textAlign:"end",fontSize:"12px",children:n("Liquidity")})]}),re.slice(0,w).map((e,r)=>Object(y.jsx)(W,{onClick:()=>G(`/info/token/${e.address}`),children:Object(y.jsxs)(q,{children:[Object(y.jsxs)(a.M,{children:[Object(y.jsx)(C,{address:e.address}),Object(y.jsx)(a.xb,{ml:"10px",children:Object(y.jsx)(a.xb,{children:`${e.name} (${e.symbol})`})}),Object(y.jsx)(N,{id:"watchlist-icon",style:{marginLeft:"8px"},fill:Q.includes(e.address),onClick:t=>{t.stopPropagation(),X(e.address)}})]}),!t&&!s&&Object(y.jsxs)(a.xb,{textAlign:"end",children:["$",M(e.priceUSD)]}),!t&&!s&&Object(y.jsxs)(a.xb,{textAlign:"end",children:["$",M(e.volumeUSD)]}),!t&&!s&&Object(y.jsxs)(a.xb,{textAlign:"end",children:["$",M(e.liquidityUSD)]})]})},r)),(()=>{const e=te?J:v,t=0===re.length&&!e&&O.length>=p.c,s=0===re.length&&!e,r=te?s:t,c=n(te?"Saved tokens will appear here":"No results");return Object(y.jsxs)(y.Fragment,{children:[e&&Object(y.jsx)(a.rb,{}),r&&Object(y.jsx)(a.xb,{children:c}),!te&&O.length<p.c&&Object(y.jsx)(a.xb,{children:n("Search pools or tokens")})]})})(),Object(y.jsx)(H,{onClick:()=>{T(w+5)},hide:re.length<=w,ref:l,children:n("See more...")}),Object(y.jsx)(V,{}),Object(y.jsxs)(q,{children:[Object(y.jsx)(a.xb,{bold:!0,color:"secondary",mb:"8px",children:n("Pools")}),!t&&!s&&Object(y.jsx)(a.xb,{textAlign:"end",fontSize:"12px",children:n("Volume 24H")}),!t&&!s&&Object(y.jsx)(a.xb,{textAlign:"end",fontSize:"12px",children:n("Volume 7D")}),!t&&!s&&Object(y.jsx)(a.xb,{textAlign:"end",fontSize:"12px",children:n("Liquidity")})]}),ne.slice(0,$).map((e,r)=>Object(y.jsx)(W,{onClick:()=>G(`/info/pool/${e.address}`),children:Object(y.jsxs)(q,{children:[Object(y.jsxs)(a.M,{children:[Object(y.jsx)(D,{address0:e.token0.address,address1:e.token1.address}),Object(y.jsx)(a.xb,{ml:"10px",style:{whiteSpace:"nowrap"},children:Object(y.jsx)(a.xb,{children:`${e.token0.symbol} / ${e.token1.symbol}`})}),Object(y.jsx)(N,{id:"watchlist-icon",style:{marginLeft:"10px"},fill:Y.includes(e.address),onClick:t=>{t.stopPropagation(),K(e.address)}})]}),!t&&!s&&Object(y.jsxs)(a.xb,{textAlign:"end",children:["$",M(e.volumeUSD)]}),!t&&!s&&Object(y.jsxs)(a.xb,{textAlign:"end",children:["$",M(e.volumeUSDWeek)]}),!t&&!s&&Object(y.jsxs)(a.xb,{textAlign:"end",children:["$",M(e.liquidityUSD)]})]})},r)),(()=>{const e=te?ee:k,t=0===ne.length&&!k&&O.length>=p.c,s=0===ne.length&&!e,r=te?s:t,c=n(te?"Saved tokens will appear here":"No results");return Object(y.jsxs)(y.Fragment,{children:[e&&Object(y.jsx)(a.rb,{}),r&&Object(y.jsx)(a.xb,{children:c}),!te&&O.length<p.c&&Object(y.jsx)(a.xb,{children:n("Search pools or tokens")})]})})(),Object(y.jsx)(H,{onClick:()=>{L($+5)},hide:ne.length<=$,ref:l,children:n("See more...")})]})]})]})};const X=Object(o.e)(a.M)`
  background: ${e=>{let{theme:t}=e;return t.colors.gradients.cardHeader}};
  justify-content: space-between;
  padding: 20px 16px;
  margin: 0 24px 16px 24px;
  flex-direction: column;
  gap: 8px;
  border-radius: 16px;
  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding: 20px 40px;
    flex-direction: row;
  }
`;var Y=()=>{const{t:e}=Object(d.b)();let t=0;return Object(c.i)(["/info/pools","/info/pool","/info/pair"])&&(t=1),Object(c.i)(["/info/tokens","/info/token"])&&(t=2),Object(y.jsxs)(X,{children:[Object(y.jsx)(a.j,{children:Object(y.jsxs)(a.n,{activeIndex:t,scale:"sm",variant:"subtle",children:[Object(y.jsx)(a.o,{as:l.a,to:"/info",children:e("Overview")}),Object(y.jsx)(a.o,{as:l.a,to:"/info/pools",children:e("Pools")}),Object(y.jsx)(a.o,{as:l.a,to:"/info/tokens",children:e("Tokens")})]})}),Object(y.jsx)(a.j,{width:["100%","100%","250px"],children:Object(y.jsx)(Q,{})})]})},K=s(783),G=s(1244),_=s(139),J=s(1241),Z=s(1242),ee=s(984),te=s(985),se=s(1230),re=s(1152);var ne=e=>Object(y.jsxs)(a.vb,{width:"100%",height:"100%",preserveAspectRatio:"none",viewBox:"0 0 100 50",...e,children:[Object(y.jsx)("path",{d:"M 0 49 C 1 49 1 45 4 47 C 7 49 7 35 11 37 C 13 38 14 32 16 34 C 18 35.6667 20 40 22 39 C 24 38 24 34 26 34 C 27 34 29 39 32 36 C 33 35 34 32 35 32 C 37 32 37 35 39 34 C 40 33 39 29 43 31 C 46 32 45 28 47 30 C 50 32 49 22 51 24 Q 53 26 55 24 C 56 23 56 25 57 26 C 58 27 59 28 60 28 C 63 28 66 17 67 16 C 68 15 69 17 70 16 C 71 15 71 13 74 13 C 76 13 76 14 77 15 C 79 17 80 18 82 18 C 83 18 83 17 84 17 C 87 17 89 24 91 24 C 93 24 95 20 96 17 C 97.6667 13.3333 98 9 101 6",stroke:"#7645D9",strokeWidth:"0.2",strokeDasharray:"156",strokeDashoffset:"156",fill:"transparent",opacity:"0.5",filter:"url(#glow)",children:Object(y.jsx)("animate",{id:"firstline",attributeName:"stroke-dashoffset",dur:"2s",from:"156",to:"-156",begin:"0s;firstline.end+0.5s"})}),Object(y.jsx)("path",{d:"M 0 49 C 1 49 1 45 4 47 C 7 49 7 35 11 37 C 13 38 14 32 16 34 C 18 35.6667 20 40 22 39 C 24 38 24 34 26 34 C 27 34 29 39 32 36 C 33 35 34 32 35 32 C 37 32 37 35 39 34 C 40 33 39 29 43 31 C 46 32 45 28 47 30 C 50 32 49 22 51 24 Q 53 26 55 24 C 56 23 56 25 57 26 C 58 27 59 28 60 28 C 63 28 66 17 67 16 C 68 15 69 17 70 16 C 71 15 71 13 74 13 C 76 13 76 14 77 15 C 79 17 80 18 82 18 C 83 18 83 17 84 17 C 87 17 89 24 91 24 C 93 24 95 20 96 17 C 97.6667 13.3333 98 9 101 6",stroke:"#7645D9",strokeWidth:"0.2",strokeDasharray:"156",strokeDashoffset:"156",fill:"transparent",opacity:"0.5",filter:"url(#glow)",children:Object(y.jsx)("animate",{id:"secondline",attributeName:"stroke-dashoffset",dur:"2s",from:"156",to:"-156",begin:"1.3s;secondline.end+0.5s"})}),Object(y.jsx)("defs",{children:Object(y.jsxs)("filter",{id:"glow",children:[Object(y.jsx)("feGaussianBlur",{className:"blur",result:"coloredBlur",stdDeviation:"4"}),Object(y.jsxs)("feMerge",{children:[Object(y.jsx)("feMergeNode",{in:"coloredBlur"}),Object(y.jsx)("feMergeNode",{in:"coloredBlur"}),Object(y.jsx)("feMergeNode",{in:"coloredBlur"}),Object(y.jsx)("feMergeNode",{in:"SourceGraphic"})]})]})})]});var ce=e=>Object(y.jsxs)(a.vb,{width:"100%",height:"100%",viewBox:"0 0 50 25",preserveAspectRatio:"none",opacity:"0.1",...e,children:[Object(y.jsxs)("rect",{width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.9s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.9s"})]}),Object(y.jsxs)("rect",{x:"10.222%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.8s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.8s"})]}),Object(y.jsxs)("rect",{x:"20.444%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.7s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.7s"})]}),Object(y.jsxs)("rect",{x:"30.666%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.6s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.6s"})]}),Object(y.jsxs)("rect",{x:"40.888%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.5s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.5s"})]}),Object(y.jsxs)("rect",{x:"51.11%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.4s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.4s"})]}),Object(y.jsxs)("rect",{x:"61.332%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.3s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.3s"})]}),Object(y.jsxs)("rect",{x:"71.554%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.2s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.2s"})]}),Object(y.jsxs)("rect",{x:"81.776%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.1s"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite",begin:"-0.1s"})]}),Object(y.jsxs)("rect",{x:"91.998%",width:"8%",fill:"#1FC7D4",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"0.9s",values:"15%; 90%; 15%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"y",dur:"0.9s",values:"85%; 10%; 85%",keyTimes:"0; 0.55; 1",repeatCount:"indefinite"})]})]});var ie=e=>Object(y.jsxs)(a.vb,{width:"100%",height:"100%",viewBox:"0 0 100 50",opacity:"0.1",...e,children:[Object(y.jsxs)("rect",{width:"5%",fill:"#31D0AA",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"2s",values:"0%; 40%; 40%; 10%; 10%",keyTimes:"0; 0.125; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"y",dur:"2s",from:"50%",to:"30%",values:"30%; 10%; 10%; 25%; 25%",keyTimes:"0; 0.125; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"rx",dur:"2s",values:"0%; 0%; 100%; 100%;",keyTimes:"0; 0.6; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"x",dur:"2s",values:"32.5%; 32.5%; 47.5%; 47.5%;",keyTimes:"0; 0.7; 0.8; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"opacity",dur:"2s",values:"1; 1; 0; 0;",keyTimes:"0; 0.75; 0.9; 1",repeatCount:"indefinite"})]}),Object(y.jsxs)("rect",{width:"5%",fill:"#31D0AA",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"2s",values:"0%; 0%; 20%; 20%; 10%; 10%",keyTimes:"0; 0.125; 0.25; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"y",dur:"2s",values:"15%; 15%; 5%; 5%; 25%; 25%",keyTimes:"0; 0.125; 0.25; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"rx",dur:"2s",values:"0%; 0%; 100%; 100%;",keyTimes:"0; 0.6; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"x",dur:"2s",values:"42.5%; 42.5%; 47.5%; 47.5%;",keyTimes:"0; 0.7; 0.8; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"opacity",dur:"2s",values:"1; 1; 0; 0;",keyTimes:"0; 0.75; 0.9; 1",repeatCount:"indefinite"})]}),Object(y.jsxs)("rect",{width:"5%",fill:"#ED4B9E",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"2s",values:"0%; 0%; 35%; 35%; 10%; 10%",keyTimes:"0; 0.25; 0.375; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"y",dur:"2s",values:"25%; 25%; 10%; 10%; 25%; 25%",keyTimes:"0; 0.25; 0.375; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"rx",dur:"2s",values:"0%; 0%; 100%; 100%;",keyTimes:"0; 0.6; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"x",dur:"2s",values:"52.5%; 52.5%; 47.5%; 47.5%;",keyTimes:"0; 0.7; 0.8; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"opacity",dur:"2s",values:"1; 1; 0; 0;",keyTimes:"0; 0.75; 0.9; 1",repeatCount:"indefinite"})]}),Object(y.jsxs)("rect",{width:"5%",fill:"#31D0AA",children:[Object(y.jsx)("animate",{attributeName:"height",dur:"2s",values:"0%; 0%; 35%; 35%; 10%; 10%",keyTimes:"0; 0.375; 0.5; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"y",dur:"2s",values:"15%; 15%; 0%; 0%; 25%; 25%",keyTimes:"0; 0.375; 0.5; 0.5; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"rx",dur:"2s",values:"0%; 0%; 100%; 100%;",keyTimes:"0; 0.6; 0.625; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"x",dur:"2s",values:"62.5%; 62.5%; 47.5%; 47.5%;",keyTimes:"0; 0.7; 0.8; 1",repeatCount:"indefinite"}),Object(y.jsx)("animate",{attributeName:"opacity",dur:"2s",values:"1; 1; 0; 0;",keyTimes:"0; 0.75; 0.9; 1",repeatCount:"indefinite"})]})]});const oe=Object(o.e)(a.j)`
  position: absolute;
  margin-left: auto;
  margin-right: auto;
  top: 50%;
  left: 0;
  right: 0;
  text-align: center;
`,le=Object(o.e)(a.j)`
  height: 100%;
  position: relative;
`,ae=()=>{const{t:e}=Object(d.b)();return Object(y.jsxs)(le,{children:[Object(y.jsx)(ce,{}),Object(y.jsx)(oe,{children:Object(y.jsx)(a.xb,{color:"textSubtle",fontSize:"20px",children:e("Loading chart data...")})})]})},de=()=>{const{t:e}=Object(d.b)();return Object(y.jsxs)(le,{children:[Object(y.jsx)(ne,{}),Object(y.jsx)(oe,{children:Object(y.jsx)(a.xb,{color:"textSubtle",fontSize:"20px",children:e("Loading chart data...")})})]})},je=()=>{const{t:e}=Object(d.b)();return Object(y.jsxs)(le,{children:[Object(y.jsx)(ie,{}),Object(y.jsx)(oe,{children:Object(y.jsx)(a.xb,{color:"textSubtle",fontSize:"20px",children:e("Loading chart data...")})})]})},be=e=>{let{payload:t,setHoverValue:s,setHoverDate:n}=e;return Object(r.useEffect)(()=>{s(t.value),n(Object(K.default)(t.time,"MMM d, yyyy"))},[t.value,t.time,s,n]),null};var xe=e=>{let{data:t,setHoverValue:s,setHoverDate:r}=e;const{theme:n}=Object(L.a)();return t&&0!==t.length?Object(y.jsx)(J.a,{children:Object(y.jsxs)(Z.a,{data:t,width:300,height:308,margin:{top:5,right:15,left:0,bottom:5},onMouseLeave:()=>{r&&r(void 0),s&&s(void 0)},children:[Object(y.jsx)("defs",{children:Object(y.jsxs)("linearGradient",{id:"gradient",x1:"0",y1:"0",x2:"0",y2:"1",children:[Object(y.jsx)("stop",{offset:"5%",stopColor:n.colors.inputSecondary,stopOpacity:.5}),Object(y.jsx)("stop",{offset:"100%",stopColor:n.colors.secondary,stopOpacity:0})]})}),Object(y.jsx)(ee.a,{dataKey:"time",axisLine:!1,tickLine:!1,tickFormatter:e=>Object(K.default)(e,"dd"),minTickGap:10}),Object(y.jsx)(te.a,{dataKey:"value",tickCount:6,scale:"linear",axisLine:!1,tickLine:!1,fontSize:"12px",tickFormatter:e=>`$${M(e)}`,orientation:"right",tick:{dx:10,fill:n.colors.textSubtle}}),Object(y.jsx)(se.a,{cursor:{stroke:n.colors.secondary},contentStyle:{display:"none"},formatter:(e,t,n)=>Object(y.jsx)(be,{payload:n.payload,setHoverValue:s,setHoverDate:r})}),Object(y.jsx)(re.a,{dataKey:"value",type:"monotone",stroke:n.colors.secondary,fill:"url(#gradient)",strokeWidth:2})]})}):Object(y.jsx)(de,{})};var pe=e=>{let{value:t,...s}=e;if(!t||Number.isNaN(t))return Object(y.jsx)(a.xb,{...s,children:"-"});const r=t<0;return Object(y.jsxs)(a.xb,{...s,color:r?"failure":"success",children:[r?"\u2193":"\u2191",Math.abs(t).toFixed(2),"%"]})};const he=Object(o.e)(a.xb)`
  cursor: pointer;
`,ue=Object(o.e)(a.M)`
  width: 100%;
  padding-top: 16px;
  flex-direction: column;
  gap: 16px;
  background-color: ${e=>{let{theme:t}=e;return t.card.background}};
  border-radius: ${e=>{let{theme:t}=e;return t.radii.card}};
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
`,Oe=o.e.div`
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-top: 0.2em;
  margin-bottom: 1.2em;
`,me=o.e.div`
  color: ${e=>{let{theme:t}=e;return t.colors.primary}};
  padding: 0 20px;
  :hover {
    cursor: pointer;
  }
`,fe=o.e.div`
  height: 1px;
  background-color: ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
  width: 100%;
`,ge=o.e.div`
  display: grid;
  grid-gap: 1em;
  align-items: center;

  padding: 0 24px;

  grid-template-columns: 20px 3fr repeat(4, 1fr);

  @media screen and (max-width: 900px) {
    grid-template-columns: 20px 2fr repeat(3, 1fr);
    & :nth-child(4) {
      display: none;
    }
  }

  @media screen and (max-width: 800px) {
    grid-template-columns: 20px 2fr repeat(2, 1fr);
    & :nth-child(6) {
      display: none;
    }
  }

  @media screen and (max-width: 670px) {
    grid-template-columns: 1fr 1fr;
    > *:first-child {
      display: none;
    }
    > *:nth-child(3) {
      display: none;
    }
  }
`,ye=Object(o.e)(l.a)`
  text-decoration: none;
  :hover {
    cursor: pointer;
    opacity: 0.7;
  }
`,ve=Object(o.e)(C)`
  @media screen and (max-width: 670px) {
    width: 16px;
    height: 16px;
  }
`,ke=()=>{const e=Object(y.jsxs)(ge,{children:[Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{})]});return Object(y.jsxs)(y.Fragment,{children:[e,e,e]})},Se=e=>{let{tokenData:t,index:s}=e;const{isXs:r,isSm:n}=Object(a.Nb)();return Object(y.jsx)(ye,{to:`/info/token/${t.address}`,children:Object(y.jsxs)(ge,{children:[Object(y.jsx)(a.M,{children:Object(y.jsx)(a.xb,{children:s+1})}),Object(y.jsxs)(a.M,{alignItems:"center",children:[Object(y.jsx)(ve,{address:t.address}),(r||n)&&Object(y.jsx)(a.xb,{ml:"8px",children:t.symbol}),!r&&!n&&Object(y.jsxs)(a.M,{marginLeft:"10px",children:[Object(y.jsx)(a.xb,{children:t.name}),Object(y.jsxs)(a.xb,{ml:"8px",children:["(",t.symbol,")"]})]})]}),Object(y.jsxs)(a.xb,{fontWeight:400,children:["$",M(t.priceUSD,{notation:"standard"})]}),Object(y.jsx)(a.xb,{fontWeight:400,children:Object(y.jsx)(pe,{value:t.priceUSDChange,fontWeight:400})}),Object(y.jsxs)(a.xb,{fontWeight:400,children:["$",M(t.volumeUSD)]}),Object(y.jsxs)(a.xb,{fontWeight:400,children:["$",M(t.liquidityUSD)]})]})})},Ce="name",we="volumeUSD",De="tvlUSD",Te="priceUSD",$e="priceUSDChange",Me=10;var ze=e=>{let{tokenDatas:t,maxItems:s=Me}=e;const[c,i]=Object(r.useState)(we),[o,l]=Object(r.useState)(!0),{t:j}=Object(d.b)(),[b,x]=Object(r.useState)(1),[p,h]=Object(r.useState)(1);Object(r.useEffect)(()=>{let e=1;t&&(t.length%s===0&&(e=0),h(Math.floor(t.length/s)+e))},[s,t]);const u=Object(r.useMemo)(()=>t?t.sort((e,t)=>e&&t?e[c]>t[c]?1*(o?-1:1):-1*(o?-1:1):-1).slice(s*(b-1),b*s):[],[t,s,b,o,c]),O=Object(r.useCallback)(e=>{i(e),l(c!==e||!o)},[o,c]),m=Object(r.useCallback)(e=>c===e?o?"\u2193":"\u2191":"",[o,c]);return t?Object(y.jsxs)(ue,{children:[Object(y.jsxs)(ge,{children:[Object(y.jsx)(a.xb,{color:"secondary",fontSize:"12px",bold:!0,children:"#"}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>O(Ce),textTransform:"uppercase",children:[j("Name")," ",m(Ce)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>O(Te),textTransform:"uppercase",children:[j("Price")," ",m(Te)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>O($e),textTransform:"uppercase",children:[j("Price Change")," ",m($e)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>O(we),textTransform:"uppercase",children:[j("Volume 24H")," ",m(we)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>O(De),textTransform:"uppercase",children:[j("Liquidity")," ",m(De)]})]}),Object(y.jsx)(fe,{}),u.length>0?Object(y.jsxs)(y.Fragment,{children:[u.map((e,t)=>e?Object(y.jsxs)(n.a.Fragment,{children:[Object(y.jsx)(Se,{index:(b-1)*Me+t,tokenData:e}),Object(y.jsx)(fe,{})]},e.address):null),Object(y.jsxs)(Oe,{children:[Object(y.jsx)(me,{onClick:()=>{x(1===b?b:b-1)},children:Object(y.jsx)(a.b,{color:1===b?"textDisabled":"primary"})}),Object(y.jsx)(a.xb,{children:j("Page %page% of %maxPage%",{page:b,maxPage:p})}),Object(y.jsx)(me,{onClick:()=>{x(b===p?b:b+1)},children:Object(y.jsx)(a.e,{color:b===p?"textDisabled":"primary"})})]})]}):Object(y.jsxs)(y.Fragment,{children:[Object(y.jsx)(ke,{}),Object(y.jsx)(a.j,{})]})]}):Object(y.jsx)(a.rb,{})};const Le=o.e.div`
  display: grid;
  grid-gap: 1em;
  align-items: center;
  grid-template-columns: 20px 3.5fr repeat(5, 1fr);

  padding: 0 24px;
  @media screen and (max-width: 900px) {
    grid-template-columns: 20px 1.5fr repeat(3, 1fr);
    & :nth-child(4),
    & :nth-child(5) {
      display: none;
    }
  }
  @media screen and (max-width: 500px) {
    grid-template-columns: 20px 1.5fr repeat(1, 1fr);
    & :nth-child(4),
    & :nth-child(5),
    & :nth-child(6),
    & :nth-child(7) {
      display: none;
    }
  }
  @media screen and (max-width: 480px) {
    grid-template-columns: 2.5fr repeat(1, 1fr);
    > *:nth-child(1) {
      display: none;
    }
  }
`,Ue=Object(o.e)(l.a)`
  text-decoration: none;
  :hover {
    cursor: pointer;
    opacity: 0.7;
  }
`,Ne="volumeUSD",Pe="tvlUSD",Ae="volumeUSDWeek",Ie="lpFees24h",Ee="lpApr7d",Fe=()=>Object(y.jsxs)(Le,{children:[Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{})]}),qe=()=>Object(y.jsxs)(y.Fragment,{children:[Object(y.jsx)(Fe,{}),Object(y.jsx)(Fe,{}),Object(y.jsx)(Fe,{})]}),Ve=e=>{let{poolData:t,index:s}=e;return Object(y.jsx)(Ue,{to:`/info/pool/${t.address}`,children:Object(y.jsxs)(Le,{children:[Object(y.jsx)(a.xb,{children:s+1}),Object(y.jsxs)(a.M,{children:[Object(y.jsx)(D,{address0:t.token0.address,address1:t.token1.address}),Object(y.jsxs)(a.xb,{ml:"8px",children:[t.token0.symbol,"/",t.token1.symbol]})]}),Object(y.jsxs)(a.xb,{children:["$",M(t.volumeUSD)]}),Object(y.jsxs)(a.xb,{children:["$",M(t.volumeUSDWeek)]}),Object(y.jsxs)(a.xb,{children:["$",M(t.lpFees24h)]}),Object(y.jsxs)(a.xb,{children:[M(t.lpApr7d),"%"]}),Object(y.jsxs)(a.xb,{children:["$",M(t.liquidityUSD)]})]})})};var He=e=>{let{poolDatas:t,loading:s}=e;const[c,i]=Object(r.useState)(Ne),[o,l]=Object(r.useState)(!0),{t:j}=Object(d.b)(),[b,x]=Object(r.useState)(1),[h,u]=Object(r.useState)(1);Object(r.useEffect)(()=>{let e=1;t.length%p.a===0&&(e=0),u(Math.floor(t.length/p.a)+e)},[t]);const O=Object(r.useMemo)(()=>t?t.sort((e,t)=>e&&t?e[c]>t[c]?1*(o?-1:1):-1*(o?-1:1):-1).slice(p.a*(b-1),b*p.a):[],[b,t,o,c]),m=Object(r.useCallback)(e=>{i(e),l(c!==e||!o)},[o,c]),f=Object(r.useCallback)(e=>c===e?o?"\u2193":"\u2191":"",[o,c]);return Object(y.jsxs)(ue,{children:[Object(y.jsxs)(Le,{children:[Object(y.jsx)(a.xb,{color:"secondary",fontSize:"12px",bold:!0,children:"#"}),Object(y.jsx)(a.xb,{color:"secondary",fontSize:"12px",bold:!0,textTransform:"uppercase",children:j("Pool")}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>m(Ne),textTransform:"uppercase",children:[j("Volume 24H")," ",f(Ne)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>m(Ae),textTransform:"uppercase",children:[j("Volume 7D")," ",f(Ae)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>m(Ie),textTransform:"uppercase",children:[j("LP reward fees 24H")," ",f(Ie)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>m(Ee),textTransform:"uppercase",children:[j("LP reward APR")," ",f(Ee)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>m(Pe),textTransform:"uppercase",children:[j("Liquidity")," ",f(Pe)]})]}),Object(y.jsx)(fe,{}),O.length>0?Object(y.jsxs)(y.Fragment,{children:[O.map((e,t)=>e?Object(y.jsxs)(n.a.Fragment,{children:[Object(y.jsx)(Ve,{index:(b-1)*p.a+t,poolData:e}),Object(y.jsx)(fe,{})]},e.address):null),s&&Object(y.jsx)(Fe,{}),Object(y.jsxs)(Oe,{children:[Object(y.jsx)(me,{onClick:()=>{x(1===b?b:b-1)},children:Object(y.jsx)(a.b,{color:1===b?"textDisabled":"primary"})}),Object(y.jsx)(a.xb,{children:j("Page %page% of %maxPage%",{page:b,maxPage:h})}),Object(y.jsx)(me,{onClick:()=>{x(b===h?b:b+1)},children:Object(y.jsx)(a.e,{color:b===h?"textDisabled":"primary"})})]})]}):Object(y.jsxs)(y.Fragment,{children:[Object(y.jsx)(qe,{}),Object(y.jsx)(a.j,{})]})]})},We=s(1243),Re=s(1007);const Be=e=>{let{x:t,y:s,width:r,height:n,fill:c}=e;return Object(y.jsx)("g",{children:Object(y.jsx)("rect",{x:t,y:s,fill:c,width:r,height:n,rx:"2"})})},Qe=e=>{let{payload:t,setHoverValue:s,setHoverDate:n}=e;return Object(r.useEffect)(()=>{s(t.value),n(Object(K.default)(t.time,"MMM d, yyyy"))},[t.value,t.time,s,n]),null};var Xe=e=>{let{data:t,setHoverValue:s,setHoverDate:r}=e;const{theme:n}=Object(L.a)();return t&&0!==t.length?Object(y.jsx)(J.a,{width:"100%",height:"100%",children:Object(y.jsxs)(We.a,{data:t,margin:{top:5,right:15,left:0,bottom:5},onMouseLeave:()=>{r(void 0),s(void 0)},children:[Object(y.jsx)(ee.a,{dataKey:"time",axisLine:!1,tickLine:!1,tickFormatter:e=>Object(K.default)(e,"dd"),minTickGap:10}),Object(y.jsx)(te.a,{dataKey:"value",tickCount:6,scale:"linear",axisLine:!1,tickLine:!1,color:n.colors.textSubtle,fontSize:"12px",tickFormatter:e=>`$${M(e)}`,orientation:"right",tick:{dx:10,fill:n.colors.textSubtle}}),Object(y.jsx)(se.a,{cursor:{fill:n.colors.backgroundDisabled},contentStyle:{display:"none"},formatter:(e,t,n)=>Object(y.jsx)(Qe,{payload:n.payload,setHoverValue:s,setHoverDate:r})}),Object(y.jsx)(Re.a,{dataKey:"value",fill:n.colors.primary,shape:e=>Object(y.jsx)(Be,{height:e.height,width:e.width,x:e.x,y:e.y,fill:n.colors.primary})})]})}):Object(y.jsx)(ae,{})},Ye=s(1252);var Ke=function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:4,s=arguments.length>2&&void 0!==arguments[2]?arguments[2]:4;return`${e.substring(0,t)}...${e.substring(e.length-s)}`},Ge=s(892);const _e=o.e.div`
  width: 100%;
`,Je=o.e.div`
  display: grid;
  grid-gap: 1em;
  align-items: center;
  grid-template-columns: 2fr 0.8fr repeat(4, 1fr);
  padding: 0 24px;
  @media screen and (max-width: 940px) {
    grid-template-columns: 2fr repeat(4, 1fr);
    & > *:nth-child(5) {
      display: none;
    }
  }
  @media screen and (max-width: 800px) {
    grid-template-columns: 2fr repeat(2, 1fr);
    & > *:nth-child(5) {
      display: none;
    }
    & > *:nth-child(3) {
      display: none;
    }
    & > *:nth-child(4) {
      display: none;
    }
  }
  @media screen and (max-width: 500px) {
    grid-template-columns: 2fr 1fr;
    & > *:nth-child(5) {
      display: none;
    }
    & > *:nth-child(3) {
      display: none;
    }
    & > *:nth-child(4) {
      display: none;
    }
    & > *:nth-child(2) {
      display: none;
    }
  }
`,Ze=Object(o.e)(a.M)`
  align-items: center;
  margin-right: 16px;
  margin-top: 8px;
  cursor: pointer;
`,et="amountUSD",tt="timestamp",st="sender",rt="amountToken0",nt="amountToken1",ct=()=>{const e=Object(y.jsxs)(Je,{children:[Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{}),Object(y.jsx)(a.rb,{})]});return Object(y.jsxs)(y.Fragment,{children:[e,e,e]})},it=e=>{let{transaction:t}=e;const{t:s}=Object(d.b)(),r=Math.abs(t.amountToken0),n=Math.abs(t.amountToken1),c=t.amountToken0<0?t.token0Symbol:t.token1Symbol,i=t.amountToken1<0?t.token0Symbol:t.token1Symbol;return Object(y.jsxs)(Je,{children:[Object(y.jsx)(a.X,{href:Object(f.e)(t.hash,"transaction"),children:Object(y.jsx)(a.xb,{children:t.type===Ge.a.MINT?s("Add %token0% and %token1%",{token0:t.token0Symbol,token1:t.token1Symbol}):t.type===Ge.a.SWAP?s("Swap %token0% for %token1%",{token0:i,token1:c}):s("Remove %token0% and %token1%",{token0:t.token0Symbol,token1:t.token1Symbol})})}),Object(y.jsxs)(a.xb,{children:["$",M(t.amountUSD)]}),Object(y.jsx)(a.xb,{children:Object(y.jsx)(a.xb,{children:`${M(r)} ${t.token0Symbol}`})}),Object(y.jsx)(a.xb,{children:Object(y.jsx)(a.xb,{children:`${M(n)} ${t.token1Symbol}`})}),Object(y.jsx)(a.X,{href:Object(f.e)(t.sender,"address"),children:Ke(t.sender)}),Object(y.jsx)(a.xb,{children:Object(Ye.a)(1e3*parseInt(t.timestamp,10))})]})};var ot=e=>{let{transactions:t}=e;const[s,c]=Object(r.useState)(tt),[i,o]=Object(r.useState)(!0),{t:l}=Object(d.b)(),[j,b]=Object(r.useState)(1),[x,h]=Object(r.useState)(1),[u,O]=Object(r.useState)(void 0),m=Object(r.useMemo)(()=>t?t.slice().sort((e,t)=>e&&t?e[s]>t[s]?1*(i?-1:1):-1*(i?-1:1):-1).filter(e=>void 0===u||e.type===u).slice(p.a*(j-1),j*p.a):[],[t,j,s,i,u]);Object(r.useEffect)(()=>{if(t){const e=t.filter(e=>void 0===u||e.type===u);e.length%p.a===0?h(Math.floor(e.length/p.a)):h(Math.floor(e.length/p.a)+1)}},[t,u]);const f=Object(r.useCallback)(e=>{e!==u&&(O(e),b(1))},[u]),g=Object(r.useCallback)(e=>{c(e),o(s!==e||!i)},[i,s]),v=Object(r.useCallback)(e=>s===e?i?"\u2193":"\u2191":"",[i,s]);return Object(y.jsxs)(_e,{children:[Object(y.jsxs)(a.M,{mb:"16px",children:[Object(y.jsxs)(a.M,{flexDirection:["column","row"],children:[Object(y.jsxs)(Ze,{onClick:()=>f(void 0),children:[Object(y.jsx)(a.ob,{onChange:()=>null,scale:"sm",checked:void 0===u}),Object(y.jsx)(a.xb,{ml:"8px",children:l("All")})]}),Object(y.jsxs)(Ze,{onClick:()=>f(Ge.a.SWAP),children:[Object(y.jsx)(a.ob,{onChange:()=>null,scale:"sm",checked:u===Ge.a.SWAP}),Object(y.jsx)(a.xb,{ml:"8px",children:l("Swaps")})]})]}),Object(y.jsxs)(a.M,{flexDirection:["column","row"],children:[Object(y.jsxs)(Ze,{onClick:()=>f(Ge.a.MINT),children:[Object(y.jsx)(a.ob,{onChange:()=>null,scale:"sm",checked:u===Ge.a.MINT}),Object(y.jsx)(a.xb,{ml:"8px",children:l("Adds")})]}),Object(y.jsxs)(Ze,{onClick:()=>f(Ge.a.BURN),children:[Object(y.jsx)(a.ob,{onChange:()=>null,scale:"sm",checked:u===Ge.a.BURN}),Object(y.jsx)(a.xb,{ml:"8px",children:l("Removes")})]})]})]}),Object(y.jsxs)(ue,{children:[Object(y.jsxs)(Je,{children:[Object(y.jsx)(a.xb,{color:"secondary",fontSize:"12px",bold:!0,textTransform:"uppercase",children:l("Action")}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>g(et),textTransform:"uppercase",children:[l("Total Value")," ",v(et)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>g(rt),textTransform:"uppercase",children:[l("Token Amount")," ",v(rt)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>g(nt),textTransform:"uppercase",children:[l("Token Amount")," ",v(nt)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>g(st),textTransform:"uppercase",children:[l("Account")," ",v(st)]}),Object(y.jsxs)(he,{color:"secondary",fontSize:"12px",bold:!0,onClick:()=>g(tt),textTransform:"uppercase",children:[l("Time")," ",v(tt)]})]}),Object(y.jsx)(fe,{}),t?Object(y.jsxs)(y.Fragment,{children:[m.map((e,t)=>e?Object(y.jsxs)(n.a.Fragment,{children:[Object(y.jsx)(it,{transaction:e}),Object(y.jsx)(fe,{})]},t):null),0===m.length?Object(y.jsx)(a.M,{justifyContent:"center",children:Object(y.jsx)(a.xb,{children:l("No Transactions")})}):void 0,Object(y.jsxs)(Oe,{children:[Object(y.jsx)(me,{onClick:()=>{b(1===j?j:j-1)},children:Object(y.jsx)(a.b,{color:1===j?"textDisabled":"primary"})}),Object(y.jsx)(a.xb,{children:l("Page %page% of %maxPage%",{page:j,maxPage:x})}),Object(y.jsx)(me,{onClick:()=>{b(j===x?j:j+1)},children:Object(y.jsx)(a.e,{color:j===x?"textDisabled":"primary"})})]})]}):Object(y.jsxs)(y.Fragment,{children:[Object(y.jsx)(ct,{}),Object(y.jsx)(a.j,{})]})]})]})};const lt=Object(o.e)(a.M)`
  justify-content: space-between;
  flex-direction: column;
  width: 100%;
  padding: 0;
  gap: 1em;

  & > * {
    width: 100%;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.md}} {
    flex-direction: row;
  }
`;var at=()=>{const{t:e}=Object(d.b)(),[t,s]=Object(r.useState)(),[n,c]=Object(r.useState)(),[i,o]=Object(r.useState)(),[l,j]=Object(r.useState)(),[b]=Object(x.j)(),[p]=Object(x.i)(),[h]=Object(x.k)(),u=Object(K.default)(new Date,"MMM d, yyyy");Object(r.useEffect)(()=>{null==i&&b&&o(b.volumeUSD)},[b,i]),Object(r.useEffect)(()=>{null==t&&b&&s(b.liquidityUSD)},[t,b]);const O=Object(r.useMemo)(()=>p?p.map(e=>({time:Object(G.a)(e.date),value:e.liquidityUSD})):[],[p]),m=Object(r.useMemo)(()=>p?p.map(e=>({time:Object(G.a)(e.date),value:e.volumeUSD})):[],[p]),f=Object(x.d)(),g=Object(r.useMemo)(()=>Object.values(f).map(e=>e.data).filter(e=>e),[f]),v=Object(x.c)(),k=Object(r.useMemo)(()=>Object.values(v).map(e=>e.data).filter(e=>e),[v]),S=Object(r.useMemo)(()=>Object.values(v).some(e=>!e.data),[v]);return Object(y.jsxs)(_.a,{children:[Object(y.jsx)(a.P,{scale:"lg",mb:"16px",id:"info-overview-title",children:e("Glide Info & Analytics")}),Object(y.jsxs)(lt,{children:[Object(y.jsx)(a.q,{children:Object(y.jsxs)(a.j,{p:["16px","16px","24px"],children:[Object(y.jsx)(a.xb,{bold:!0,color:"secondary",children:e("Liquidity")}),t>0?Object(y.jsxs)(a.xb,{bold:!0,fontSize:"24px",children:["$",M(t)]}):Object(y.jsx)(a.rb,{width:"128px",height:"36px"}),Object(y.jsx)(a.xb,{children:null!==n&&void 0!==n?n:u}),Object(y.jsx)(a.j,{height:"250px",children:Object(y.jsx)(xe,{data:O,setHoverValue:s,setHoverDate:c})})]})}),Object(y.jsx)(a.q,{children:Object(y.jsxs)(a.j,{p:["16px","16px","24px"],children:[Object(y.jsx)(a.xb,{bold:!0,color:"secondary",children:e("Volume 24H")}),i>0?Object(y.jsxs)(a.xb,{bold:!0,fontSize:"24px",children:["$",M(i)]}):Object(y.jsx)(a.rb,{width:"128px",height:"36px"}),Object(y.jsx)(a.xb,{children:null!==l&&void 0!==l?l:u}),Object(y.jsx)(a.j,{height:"250px",children:Object(y.jsx)(Xe,{data:m,setHoverValue:o,setHoverDate:j})})]})})]}),Object(y.jsx)(a.P,{scale:"lg",mt:"40px",mb:"16px",children:e("Top Tokens")}),Object(y.jsx)(ze,{tokenDatas:g}),Object(y.jsx)(a.P,{scale:"lg",mt:"40px",mb:"16px",children:e("Top Pools")}),Object(y.jsx)(He,{poolDatas:k,loading:S}),Object(y.jsx)(a.P,{scale:"lg",mt:"40px",mb:"16px",children:e("Transactions")}),Object(y.jsx)(ot,{transactions:h})]})};var dt=()=>{const{t:e}=Object(d.b)(),t=Object(x.c)(),s=Object(r.useMemo)(()=>Object.values(t).map(e=>e.data).filter(e=>e),[t]),[n]=Object(z.m)(),c=Object(x.f)(n);return Object(y.jsxs)(_.a,{children:[Object(y.jsx)(a.P,{scale:"lg",mb:"16px",children:e("Your Watchlist")}),Object(y.jsx)(a.q,{children:c.length>0?Object(y.jsx)(He,{poolDatas:c}):Object(y.jsx)(a.xb,{px:"24px",py:"16px",children:e("Saved pools will appear here")})}),Object(y.jsx)(a.P,{scale:"lg",mt:"40px",mb:"16px",id:"info-pools-title",children:e("All Pools")}),Object(y.jsx)(He,{poolDatas:s})]})},jt=s(248),bt=s(336),xt=s(5),pt=s(11),ht=s(14),ut=s(122),Ot=s(52);const mt=ht.c[xt.a.MAINNET];const ft=()=>{const{chainId:e}=Object(pt.a)(),t=e||xt.a.MAINNET,s=function(e){const{chainId:t}=Object(pt.a)(),s=Object(Ot.b)(e,t),n=Object(r.useMemo)(()=>[[t&&s&&Object(xt.o)(xt.n[t],s)?void 0:e,t?xt.n[t]:void 0],[null!==s&&void 0!==s&&s.equals(mt)?void 0:s,t===xt.a.MAINNET?mt:void 0],[t?xt.n[t]:void 0,t===xt.a.MAINNET?mt:void 0]],[t,e,s]),[[c,i],[o,l],[a,d]]=Object(ut.c)(n);return Object(r.useMemo)(()=>{if(!e||!s||!t)return;if(s.equals(xt.n[t])){if(l){const s=l.priceOf(xt.n[t]);return new xt.h(e,mt,s.denominator,s.numerator)}return}if(s.equals(mt))return new xt.h(mt,mt,"1","1");const r=null===i||void 0===i?void 0:i.reserveOf(xt.n[t]),n=r&&d?d.priceOf(xt.n[t]).quote(r).raw:xt.e.BigInt(0);if(o===ut.a.EXISTS&&l&&l.reserveOf(mt).greaterThan(n)){const t=l.priceOf(s);return new xt.h(e,mt,t.denominator,t.numerator)}if(c===ut.a.EXISTS&&i&&a===ut.a.EXISTS&&d&&d.reserveOf(mt).greaterThan("0")&&i.reserveOf(xt.n[t]).greaterThan("0")){const s=d.priceOf(mt),r=i.priceOf(xt.n[t]),n=s.multiply(r).invert();return new xt.h(e,mt,n.denominator,n.numerator)}},[t,e,i,c,d,a,l,o,s])}(ht.a[t]);return s};var gt=s(230);const yt=Object(o.e)(gt.a)`
  min-height: calc(100vh - 64px);
  padding-top: 16px;
  padding-bottom: 16px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding-top: 24px;
    padding-bottom: 24px;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    padding-top: 32px;
    padding-bottom: 32px;
  }
`,vt=e=>{let{symbol:t}=e;const{t:s}=Object(d.b)(),{pathname:r}=Object(c.h)(),n=ft(),i=n?`$${n.toFixed(3)}`:"...",o=Object(bt.b)(r,s)||{},{title:l,description:a,image:j}={...bt.a,...o};let b=i?[l,i].join(" - "):l;return t&&(b=[t,l].join(" - ")),Object(y.jsxs)(jt.a,{children:[Object(y.jsx)("title",{children:b}),Object(y.jsx)("meta",{property:"og:title",content:l}),Object(y.jsx)("meta",{property:"og:description",content:a}),Object(y.jsx)("meta",{property:"og:image",content:j})]})};var kt=e=>{let{children:t,symbol:s,...r}=e;return Object(y.jsxs)(y.Fragment,{children:[Object(y.jsx)(vt,{symbol:s}),Object(y.jsx)(yt,{...r,children:t})]})},St=s(1231);var Ct=e=>{let{data:t,setValue:s,setLabel:n,...c}=e;const{theme:i}=Object(L.a)(),o=Object(r.useRef)(null),[l,a]=Object(r.useState)(),d=Object(r.useCallback)(()=>{var e;l&&null!==o&&void 0!==o&&null!==(e=o.current)&&void 0!==e&&e.parentElement&&(l.resize(o.current.parentElement.clientWidth-32,250),l.timeScale().fitContent(),l.timeScale().scrollToPosition(0,!1))},[l,o]),j="object"===typeof window;return Object(r.useEffect)(()=>j?(window.addEventListener("resize",d),()=>window.removeEventListener("resize",d)):null,[j,o,d]),Object(r.useEffect)(()=>{var e;if(!l&&t&&null!==o&&void 0!==o&&null!==(e=o.current)&&void 0!==e&&e.parentElement){const e=Object(St.a)(o.current,{height:250,width:o.current.parentElement.clientWidth-32,layout:{backgroundColor:"transparent",textColor:i.colors.textSubtle,fontFamily:"Kanit, sans-serif",fontSize:12},rightPriceScale:{scaleMargins:{top:.1,bottom:.1},borderVisible:!1},timeScale:{borderVisible:!1,secondsVisible:!0,tickMarkFormatter:e=>Object(K.default)(1e3*e,"MM/dd h:mm a")},watermark:{visible:!1},grid:{horzLines:{visible:!1},vertLines:{visible:!1}},crosshair:{horzLine:{visible:!1,labelVisible:!1},mode:1,vertLine:{visible:!0,labelVisible:!1,style:3,width:1,color:i.colors.textSubtle,labelBackgroundColor:i.colors.primary}}});e.timeScale().fitContent(),a(e)}},[l,t,s,i]),Object(r.useEffect)(()=>{if(l&&t){const e=l.addCandlestickSeries({upColor:i.colors.success,downColor:i.colors.failure,borderDownColor:i.colors.failure,borderUpColor:i.colors.success,wickDownColor:i.colors.failure,wickUpColor:i.colors.success});e.setData(t),l.subscribeCrosshairMove(t=>{if(null!==o&&void 0!==o&&o.current&&(void 0===t||void 0===t.time||t&&t.point&&t.point.x<0||t&&t.point&&t.point.x>o.current.clientWidth||t&&t.point&&t.point.y<0||t&&t.point&&t.point.y>250))s&&s(void 0),n&&n(void 0);else if(e&&t){const r=t.time,c=new Date(1e3*r),i=new Date(c.getTime()+6e4*c.getTimezoneOffset()),o=`${Object(K.default)(i,"MMM d, yyyy h:mm a")} (UTC)`,l=t.seriesPrices.get(e);s&&s(null===l||void 0===l?void 0:l.open),n&&n(o)}})}},[l,t,s,n,i]),Object(y.jsxs)(y.Fragment,{children:[!l&&Object(y.jsx)(je,{}),Object(y.jsx)("div",{ref:o,id:"candle-chart",...c})]})};const wt=Object(o.e)(a.M)`
  overflow-x: scroll;
  padding: 0;
  border-radius: 24px 24px 0 0;
  ::-webkit-scrollbar {
    display: none;
  }
  scrollbar-width: none; /* Firefox */
`,Dt=Object(o.e)(a.M)`
  justify-content: space-between;
  background-color: ${e=>{let{theme:t}=e;return t.colors.input}};
  width: 100%;
`,Tt=o.e.button`
  display: inline-flex;
  justify-content: center;
  cursor: pointer;
  flex: 1;
  border: 0;
  outline: 0;
  padding: 16px;
  margin: 0;
  border-radius: 24px 24px 0 0;
  font-size: 16px;
  font-weight: 600;
  color: ${e=>{let{theme:t,isActive:s}=e;return s?t.colors.text:t.colors.textSubtle}};
  background-color: ${e=>{let{theme:t,isActive:s}=e;return s?t.card.background:t.colors.input}};
`,$t=e=>{let{children:t}=e;return Object(y.jsx)(wt,{p:["0 4px","0 16px"],children:Object(y.jsx)(Dt,{children:t})})};var Mt=function(e){return e[e.LIQUIDITY=0]="LIQUIDITY",e[e.VOLUME=1]="VOLUME",e[e.PRICE=2]="PRICE",e}(Mt||{});var zt=e=>{let{variant:t,chartData:s,tokenData:n,tokenPriceData:c}=e;const[i,o]=Object(r.useState)(Mt.PRICE),[l,j]=Object(r.useState)(),[b,x]=Object(r.useState)(),{t:p}=Object(d.b)(),h=Object(K.default)(new Date,"MMM d, yyyy"),u=Object(r.useMemo)(()=>s?s.map(e=>({time:Object(G.a)(e.date),value:e.liquidityUSD})):[],[s]),O=Object(r.useMemo)(()=>s?s.map(e=>({time:Object(G.a)(e.date),value:e.volumeUSD})):[],[s]);return Object(y.jsxs)(a.q,{children:[Object(y.jsxs)($t,{children:["token"===t&&Object(y.jsx)(Tt,{isActive:i===Mt.PRICE,onClick:()=>o(Mt.PRICE),children:Object(y.jsx)(a.xb,{children:p("Price")})}),Object(y.jsx)(Tt,{isActive:i===Mt.VOLUME,onClick:()=>o(Mt.VOLUME),children:Object(y.jsx)(a.xb,{children:p("Volume")})}),Object(y.jsx)(Tt,{isActive:i===Mt.LIQUIDITY,onClick:()=>o(Mt.LIQUIDITY),children:Object(y.jsx)(a.xb,{children:p("Liquidity")})})]}),Object(y.jsxs)(a.M,{flexDirection:"column",px:"24px",pt:"24px",children:[(()=>{let e=null;if(l)e=M(l);else if(i===Mt.VOLUME&&O.length>0){var t;e=M(null===(t=O[O.length-1])||void 0===t?void 0:t.value)}else if(i===Mt.LIQUIDITY&&u.length>0){var s;e=M(null===(s=u[u.length-1])||void 0===s?void 0:s.value)}else i===Mt.PRICE&&null!==n&&void 0!==n&&n.priceUSD&&(e=M(n.priceUSD));return e?Object(y.jsxs)(a.xb,{fontSize:"24px",bold:!0,children:["$",e]}):Object(y.jsx)(a.rb,{height:"36px",width:"128px"})})(),Object(y.jsx)(a.xb,{small:!0,color:"secondary",children:b||h})]}),Object(y.jsx)(a.j,{px:"24px",height:"token"===t?"250px":"335px",children:i===Mt.LIQUIDITY?Object(y.jsx)(xe,{data:u,setHoverValue:j,setHoverDate:x}):i===Mt.VOLUME?Object(y.jsx)(Xe,{data:O,setHoverValue:j,setHoverDate:x}):i===Mt.PRICE?Object(y.jsx)(Ct,{data:c,setValue:j,setLabel:x}):null})]})};const Lt=o.e.div`
  display: grid;
  grid-template-columns: 300px 1fr;
  grid-gap: 1em;
  margin-top: 16px;
  @media screen and (max-width: 800px) {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
`,Ut=Object(o.e)(a.M)`
  padding: 8px 0px;
  margin-right: 16px;
  :hover {
    cursor: pointer;
    opacity: 0.6;
  }
`,Nt=Object(o.e)(a.M)`
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
  background-color: ${e=>{let{theme:t}=e;return t.colors.background}};
  padding: 16px;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
  border-radius: 16px;
  max-width: 280px;
`;var Pt=e=>{let{match:{params:{address:t}}}=e;const{isXs:s,isSm:n}=Object(a.Nb)(),{t:c}=Object(d.b)(),[i,o]=Object(r.useState)(0),{tooltip:j,tooltipVisible:b,targetRef:p}=Object(a.Qb)(c("Based on last 7 days' performance. Does not account for impermanent loss"),{});Object(r.useEffect)(()=>{window.scrollTo(0,0)},[]);const h=t.toLowerCase(),u=Object(x.f)([h])[0],O=Object(x.e)(h),m=Object(x.g)(h),[g,v]=Object(z.m)();return Object(y.jsx)(kt,{symbol:u?`${null===u||void 0===u?void 0:u.token0.symbol} / ${null===u||void 0===u?void 0:u.token1.symbol}`:null,children:u?Object(y.jsxs)(y.Fragment,{children:[Object(y.jsxs)(a.M,{justifyContent:"space-between",mb:"16px",flexDirection:["column","column","row"],children:[Object(y.jsxs)(a.k,{mb:"32px",children:[Object(y.jsx)(l.a,{to:"/info",children:Object(y.jsx)(a.xb,{color:"primary",children:c("Info")})}),Object(y.jsx)(l.a,{to:"/info/pools",children:Object(y.jsx)(a.xb,{color:"primary",children:c("Pools")})}),Object(y.jsx)(a.M,{children:Object(y.jsx)(a.xb,{mr:"8px",children:`${u.token0.symbol} / ${u.token1.symbol}`})})]}),Object(y.jsxs)(a.M,{justifyContent:[null,null,"flex-end"],mt:["8px","8px",0],children:[Object(y.jsx)(a.X,{mr:"8px",href:Object(f.e)(h,"address"),children:c("View on explorer")}),Object(y.jsx)(N,{fill:g.includes(h),onClick:()=>v(h)})]})]}),Object(y.jsxs)(a.M,{flexDirection:"column",children:[Object(y.jsxs)(a.M,{alignItems:"center",mb:["8px",null],children:[Object(y.jsx)(D,{address0:u.token0.address,address1:u.token1.address,size:32}),Object(y.jsx)(a.xb,{ml:"38px",bold:!0,fontSize:s||n?"24px":"40px",id:"info-pool-pair-title",children:`${u.token0.symbol} / ${u.token1.symbol}`})]}),Object(y.jsxs)(a.M,{justifyContent:"space-between",flexDirection:["column","column","column","row"],children:[Object(y.jsxs)(a.M,{flexDirection:["column","column","row"],mb:["8px","8px",null],children:[Object(y.jsx)(l.a,{to:`/info/token/${u.token0.address}`,children:Object(y.jsxs)(Ut,{children:[Object(y.jsx)(C,{address:u.token0.address,size:"24px"}),Object(y.jsx)(a.xb,{fontSize:"16px",ml:"4px",style:{whiteSpace:"nowrap"},width:"fit-content",children:`1 ${u.token0.symbol} =  ${M(u.token1Price,{notation:"standard",displayThreshold:.001,tokenPrecision:!0})} ${u.token1.symbol}`})]})}),Object(y.jsx)(l.a,{to:`/info/token/${u.token1.address}`,children:Object(y.jsxs)(Ut,{ml:[null,null,"10px"],children:[Object(y.jsx)(C,{address:u.token1.address,size:"24px"}),Object(y.jsx)(a.xb,{fontSize:"16px",ml:"4px",style:{whiteSpace:"nowrap"},width:"fit-content",children:`1 ${u.token1.symbol} =  ${M(u.token0Price,{notation:"standard",displayThreshold:.001,tokenPrecision:!0})} ${u.token0.symbol}`})]})})]}),Object(y.jsxs)(a.M,{children:[Object(y.jsx)(l.a,{to:`/add/${u.token0.address}/${u.token1.address}`,children:Object(y.jsx)(a.m,{mr:"8px",variant:"secondary",children:c("Add Liquidity")})}),Object(y.jsx)(l.a,{to:`/swap?inputCurrency=${u.token0.address}&outputCurrency=${u.token1.address}`,children:Object(y.jsx)(a.m,{children:c("Trade")})})]})]})]}),Object(y.jsxs)(Lt,{children:[Object(y.jsxs)(a.j,{children:[Object(y.jsx)(a.q,{children:Object(y.jsxs)(a.j,{p:"24px",children:[Object(y.jsxs)(a.M,{justifyContent:"space-between",children:[Object(y.jsxs)(a.M,{flex:"1",flexDirection:"column",children:[Object(y.jsx)(a.xb,{color:"secondary",bold:!0,fontSize:"12px",textTransform:"uppercase",children:c("Liquidity")}),Object(y.jsxs)(a.xb,{fontSize:"24px",bold:!0,children:["$",M(u.liquidityUSD)]}),Object(y.jsx)(pe,{value:u.liquidityUSDChange})]}),Object(y.jsxs)(a.M,{flex:"1",flexDirection:"column",children:[Object(y.jsx)(a.xb,{color:"secondary",bold:!0,fontSize:"12px",textTransform:"uppercase",children:c("LP reward APR")}),Object(y.jsxs)(a.xb,{fontSize:"24px",bold:!0,children:[M(u.lpApr7d),"%"]}),Object(y.jsxs)(a.M,{alignItems:"center",children:[Object(y.jsx)("span",{ref:p,children:Object(y.jsx)(a.R,{color:"textSubtle"})}),Object(y.jsx)(a.xb,{ml:"4px",fontSize:"12px",color:"textSubtle",children:c("7D performance")}),b&&j]})]})]}),Object(y.jsx)(a.xb,{color:"secondary",bold:!0,mt:"24px",fontSize:"12px",textTransform:"uppercase",children:c("Total Tokens Locked")}),Object(y.jsxs)(Nt,{children:[Object(y.jsxs)(a.M,{justifyContent:"space-between",children:[Object(y.jsxs)(a.M,{children:[Object(y.jsx)(C,{address:u.token0.address,size:"24px"}),Object(y.jsx)(a.xb,{small:!0,color:"textSubtle",ml:"8px",children:u.token0.symbol})]}),Object(y.jsx)(a.xb,{small:!0,children:M(u.liquidityToken0)})]}),Object(y.jsxs)(a.M,{justifyContent:"space-between",children:[Object(y.jsxs)(a.M,{children:[Object(y.jsx)(C,{address:u.token1.address,size:"24px"}),Object(y.jsx)(a.xb,{small:!0,color:"textSubtle",ml:"8px",children:u.token1.symbol})]}),Object(y.jsx)(a.xb,{small:!0,children:M(u.liquidityToken1)})]})]})]})}),Object(y.jsx)(a.q,{mt:"16px",children:Object(y.jsxs)(a.M,{flexDirection:"column",p:"24px",children:[Object(y.jsxs)(a.n,{activeIndex:i,onItemClick:e=>o(e),scale:"sm",variant:"subtle",children:[Object(y.jsx)(a.o,{width:"100%",children:c("24H")}),Object(y.jsx)(a.o,{width:"100%",children:c("7D")})]}),Object(y.jsxs)(a.M,{mt:"24px",children:[Object(y.jsxs)(a.M,{flex:"1",flexDirection:"column",children:[Object(y.jsx)(a.xb,{color:"secondary",fontSize:"12px",bold:!0,textTransform:"uppercase",children:c(i?"Volume 7D":"Volume 24H")}),Object(y.jsxs)(a.xb,{fontSize:"24px",bold:!0,children:["$",M(i?u.volumeUSDWeek:u.volumeUSD)]}),Object(y.jsx)(pe,{value:i?u.volumeUSDChangeWeek:u.volumeUSDChange})]}),Object(y.jsxs)(a.M,{flex:"1",flexDirection:"column",children:[Object(y.jsx)(a.xb,{color:"secondary",fontSize:"12px",bold:!0,textTransform:"uppercase",children:c(i?"LP reward fees 7D":"LP reward fees 24H")}),Object(y.jsxs)(a.xb,{fontSize:"24px",bold:!0,children:["$",M(i?u.lpFees7d:u.lpFees24h)]}),Object(y.jsx)(a.xb,{color:"textSubtle",fontSize:"12px",children:c("out of $%totalFees% total fees",{totalFees:M(i?u.totalFees7d:u.totalFees24h)})})]})]})]})})]}),Object(y.jsx)(zt,{variant:"pool",chartData:O})]}),Object(y.jsx)(a.P,{mb:"16px",mt:"40px",scale:"lg",children:c("Transactions")}),Object(y.jsx)(ot,{transactions:m})]}):Object(y.jsx)(a.M,{mt:"80px",justifyContent:"center",children:Object(y.jsx)(a.l,{})})})};const At=Object(o.e)(l.a)`
  display: inline-block;
  min-width: 190px;
  margin-left: 16px;
  :hover {
    cursor: pointer;
    opacity: 0.6;
  }
`,It=Object(o.e)(a.j)`
  border: 1px solid ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
  border-radius: ${e=>{let{theme:t}=e;return t.radii.card}};
  padding: 16px;
`,Et=o.e.div`
  width: 100%;
  overflow-x: auto;
  padding: 16px 0;
  white-space: nowrap;
  ::-webkit-scrollbar {
    display: none;
  }
`,Ft=e=>{let{tokenData:t}=e;return Object(y.jsx)(At,{to:`/info/token/${t.address}`,children:Object(y.jsx)(It,{children:Object(y.jsxs)(a.M,{children:[Object(y.jsx)(a.j,{width:"32px",height:"32px",children:Object(y.jsx)(C,{address:t.address,size:"32px"})}),Object(y.jsxs)(a.j,{ml:"16px",children:[Object(y.jsx)(a.xb,{children:t.symbol}),Object(y.jsxs)(a.M,{alignItems:"center",children:[Object(y.jsxs)(a.xb,{fontSize:"14px",mr:"6px",lineHeight:"16px",children:["$",M(t.priceUSD)]}),Object(y.jsx)(pe,{fontSize:"14px",value:t.priceUSDChange})]})]})]})})})};var qt=()=>{const e=Object(x.d)(),{t:t}=Object(d.b)(),s=Object(r.useMemo)(()=>Object.values(e).sort((e,t)=>{let{data:s}=e,{data:r}=t;return s&&r?Math.abs(null===s||void 0===s?void 0:s.priceUSDChange)>Math.abs(null===r||void 0===r?void 0:r.priceUSDChange)?-1:1:-1}).slice(0,Math.min(20,Object.values(e).length)),[e]),n=Object(r.useRef)(null),c=Object(r.useRef)(!0);return Object(r.useEffect)(()=>{const e=setInterval(()=>{n.current&&(n.current.scrollLeft===n.current.scrollWidth-n.current.clientWidth?c.current=!1:0===n.current.scrollLeft&&(c.current=!0),n.current.scrollTo(c.current?n.current.scrollLeft+1:n.current.scrollLeft-1,0))},30);return()=>{clearInterval(e)}},[]),0!==s.length&&s.some(e=>e.data)?Object(y.jsxs)(a.q,{my:"16px",children:[Object(y.jsx)(a.xb,{ml:"16px",mt:"8px",children:t("Top Movers")}),Object(y.jsx)(Et,{ref:n,children:s.map(e=>{var t;return e.data?Object(y.jsx)(Ft,{tokenData:e.data},`top-card-token-${null===(t=e.data)||void 0===t?void 0:t.address}`):null})})]}):null};var Vt=()=>{const{t:e}=Object(d.b)();Object(r.useEffect)(()=>{window.scrollTo(0,0)},[]);const t=Object(x.d)(),s=Object(r.useMemo)(()=>Object.values(t).map(e=>e.data).filter(e=>e),[t]),[n]=Object(z.n)(),c=Object(x.n)(n);return Object(y.jsxs)(_.a,{children:[Object(y.jsx)(a.P,{scale:"lg",mb:"16px",children:e("Your Watchlist")}),n.length>0?Object(y.jsx)(ze,{tokenDatas:c}):Object(y.jsx)(a.q,{children:Object(y.jsx)(a.xb,{py:"16px",px:"24px",children:e("Saved tokens will appear here")})}),Object(y.jsx)(qt,{}),Object(y.jsx)(a.P,{scale:"lg",mt:"40px",mb:"16px",id:"info-tokens-title",children:e("All Tokens")}),Object(y.jsx)(ze,{tokenDatas:s})]})},Ht=s(104);var Wt=e=>{const[t,s]=Object(r.useState)(void 0);return Object(r.useEffect)(()=>{e&&(async()=>{const t=await fetch(`https://3rdparty-apis.coinmarketcap.com/v1/cryptocurrency/contract?address=${e}`);200===t.status&&t.json().then(e=>{let{data:t}=e;s(t.url)})})()},[e]),t};const Rt=o.e.div`
  margin-top: 16px;
  display: grid;
  grid-template-columns: 260px 1fr;
  grid-gap: 1em;
  @media screen and (max-width: 800px) {
    grid-template-columns: 1fr;
    grid-template-rows: 1fr 1fr;
  }
`,Bt=(Object(o.e)(a.W)`
  width: 24px;
  height: 24px;
  margin-right: 8px;

  & :hover {
    opacity: 0.8;
  }
`,{weeks:4});var Qt=e=>{let{match:{params:{address:t}}}=e;const{isXs:s,isSm:n}=Object(a.Nb)(),{t:c}=Object(d.b)();Object(r.useEffect)(()=>{window.scrollTo(0,0)},[]);const i=t.toLowerCase(),o=(Wt(i),Object(x.m)(i)),j=Object(x.h)(i),b=Object(x.f)(null!==j&&void 0!==j?j:[]),h=Object(x.p)(i),u=Object(x.l)(i),O=Object(x.o)(i,p.e,Bt),m=Object(r.useMemo)(()=>{if(O&&o&&O.length>0)return[...O,{time:(new Date).getTime()/1e3,open:O[O.length-1].close,close:null===o||void 0===o?void 0:o.priceUSD,high:null===o||void 0===o?void 0:o.priceUSD,low:O[O.length-1].close}]},[O,o]),[g,v]=Object(z.n)();return Object(y.jsx)(kt,{symbol:null===o||void 0===o?void 0:o.symbol,children:o?o.exists?Object(y.jsxs)(y.Fragment,{children:[Object(y.jsxs)(a.M,{justifyContent:"space-between",mb:"24px",flexDirection:["column","column","row"],children:[Object(y.jsxs)(a.k,{mb:"32px",children:[Object(y.jsx)(l.a,{to:"/info",children:Object(y.jsx)(a.xb,{color:"primary",children:c("Info")})}),Object(y.jsx)(l.a,{to:"/info/tokens",children:Object(y.jsx)(a.xb,{color:"primary",children:c("Tokens")})}),Object(y.jsxs)(a.M,{children:[Object(y.jsx)(a.xb,{mr:"8px",children:o.symbol}),Object(y.jsx)(a.xb,{children:`(${Ke(i)})`})]})]}),Object(y.jsxs)(a.M,{justifyContent:[null,null,"flex-end"],mt:["8px","8px",0],children:[Object(y.jsx)(a.X,{mr:"8px",color:"primary",href:Object(f.e)(i,"address"),children:c("View on explorer")}),Object(y.jsx)(N,{fill:g.includes(i),onClick:()=>v(i)})]})]}),Object(y.jsxs)(a.M,{justifyContent:"space-between",flexDirection:["column","column","column","row"],children:[Object(y.jsxs)(a.M,{flexDirection:"column",mb:["8px",null],children:[Object(y.jsxs)(a.M,{alignItems:"center",children:[Object(y.jsx)(C,{size:"32px",address:i}),Object(y.jsx)(a.xb,{ml:"12px",bold:!0,lineHeight:"0.7",fontSize:s||n?"24px":"40px",id:"info-token-name-title",children:o.name}),Object(y.jsxs)(a.xb,{ml:"12px",lineHeight:"1",color:"textSubtle",fontSize:s||n?"14px":"20px",children:["(",o.symbol,")"]})]}),Object(y.jsxs)(a.M,{mt:"8px",ml:"46px",alignItems:"center",children:[Object(y.jsxs)(a.xb,{mr:"16px",bold:!0,fontSize:"24px",children:["$",M(o.priceUSD,{notation:"standard"})]}),Object(y.jsx)(pe,{value:o.priceUSDChange,fontWeight:600})]})]}),Object(y.jsxs)(a.M,{children:[Object(y.jsx)(l.a,{to:`/add/${i}`,children:Object(y.jsx)(a.m,{mr:"8px",variant:"secondary",children:c("Add Liquidity")})}),Object(y.jsx)(l.a,{to:`/swap?inputCurrency=${i}`,children:Object(y.jsx)(a.m,{children:c("Trade")})})]})]}),Object(y.jsxs)(Rt,{children:[Object(y.jsx)(a.q,{children:Object(y.jsxs)(a.j,{p:"24px",children:[Object(y.jsx)(a.xb,{bold:!0,small:!0,color:"secondary",fontSize:"12px",textTransform:"uppercase",children:c("Liquidity")}),Object(y.jsxs)(a.xb,{bold:!0,fontSize:"24px",children:["$",M(o.liquidityUSD)]}),Object(y.jsx)(pe,{value:o.liquidityUSDChange}),Object(y.jsx)(a.xb,{mt:"24px",bold:!0,color:"secondary",fontSize:"12px",textTransform:"uppercase",children:c("Volume 24H")}),Object(y.jsxs)(a.xb,{bold:!0,fontSize:"24px",textTransform:"uppercase",children:["$",M(o.volumeUSD)]}),Object(y.jsx)(pe,{value:o.volumeUSDChange}),Object(y.jsx)(a.xb,{mt:"24px",bold:!0,color:"secondary",fontSize:"12px",textTransform:"uppercase",children:c("Volume 7D")}),Object(y.jsxs)(a.xb,{bold:!0,fontSize:"24px",children:["$",M(o.volumeUSDWeek)]}),Object(y.jsx)(a.xb,{mt:"24px",bold:!0,color:"secondary",fontSize:"12px",textTransform:"uppercase",children:c("Transactions 24H")}),Object(y.jsx)(a.xb,{bold:!0,fontSize:"24px",children:M(o.txCount,{isInteger:!0})})]})}),Object(y.jsx)(zt,{variant:"token",chartData:u,tokenData:o,tokenPriceData:m})]}),Object(y.jsx)(a.P,{scale:"lg",mb:"16px",mt:"40px",children:c("Pools")}),Object(y.jsx)(He,{poolDatas:b}),Object(y.jsx)(a.P,{scale:"lg",mb:"16px",mt:"40px",children:c("Transactions")}),Object(y.jsx)(ot,{transactions:h})]}):Object(y.jsx)(a.q,{children:Object(y.jsx)(a.j,{p:"16px",children:Object(y.jsxs)(a.xb,{children:[c("No pool has been created with this token yet. Create one"),Object(y.jsx)(l.a,{style:{display:"inline",marginLeft:"6px"},to:`/add/${i}`,children:c("here.")})]})})}):Object(y.jsx)(a.M,{mt:"80px",justifyContent:"center",children:Object(y.jsx)(a.l,{})})})};var Xt=e=>{const{match:{params:{address:t}}}=e;return Object(Ht.isAddress)(t.toLowerCase())?Object(y.jsx)(Qt,{...e}):Object(y.jsx)(c.a,{to:"/"})};t.default=()=>Object(y.jsxs)(y.Fragment,{children:[Object(y.jsx)(i.b,{}),Object(y.jsx)(i.a,{}),Object(y.jsx)(i.c,{}),Object(y.jsx)(Y,{}),Object(y.jsx)(c.b,{path:"/info",exact:!0,children:Object(y.jsx)(at,{})}),Object(y.jsx)(c.b,{path:"/info/pools",exact:!0,children:Object(y.jsx)(dt,{})}),Object(y.jsx)(c.b,{path:"/info/tokens",exact:!0,children:Object(y.jsx)(Vt,{})}),Object(y.jsx)(c.b,{exact:!0,path:["/info/tokens/:address","/info/token/:address"],component:Xt}),Object(y.jsx)(c.b,{exact:!0,path:["/info/pools/:address","/info/pool/:address","/info/pair/:address"],component:Pt})]})}}]);
//# sourceMappingURL=14.7e060cbd.chunk.js.map
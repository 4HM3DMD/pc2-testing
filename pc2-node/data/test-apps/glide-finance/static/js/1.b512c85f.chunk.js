(this["webpackJsonpglide-frontend"]=this["webpackJsonpglide-frontend"]||[]).push([[1],{1005:function(e,t,o){"use strict";o.d(t,"b",function(){return C}),o.d(t,"a",function(){return F}),o.d(t,"c",function(){return $});var r=o(1),n=o(795),a=o(794),s=o(799);const i=(e,t)=>e&&t?e-t:e||0,c=(e,t)=>e&&t?(e-t)/t*100:0,d=(e,t,o)=>{const r=i(e,t),n=i(t,o);return[r,c(r,n)]};var l=o(811),u=o(826);const m=async e=>{try{const t=n.gql`query overview {
      glideFactories(
        ${e?`block: { number: ${e}}`:""} 
        first: 1) {
        totalTransactions
        totalVolumeUSD
        totalLiquidityUSD
      }
    }`;return{data:await Object(n.request)(a.c,t),error:!1}}catch(t){return console.error("Failed to fetch info overview",t),{data:null,error:!0}}},b=e=>e?{totalTransactions:parseFloat(e.totalTransactions),totalVolumeUSD:parseFloat(e.totalVolumeUSD),totalLiquidityUSD:parseFloat(e.totalLiquidityUSD)}:null;var p=()=>{const[e,t]=Object(r.useState)({error:!1}),[o,n]=Object(l.a)(),{blocks:a,error:s}=Object(u.b)([o,n]),[i,p]=null!==a&&void 0!==a?a:[];return Object(r.useEffect)(()=>{!((null===i||void 0===i?void 0:i.number)&&(null===p||void 0===p?void 0:p.number))||s||e.data||(async()=>{var e,o,r,n,a;const{error:s,data:l}=await m(),{error:u,data:v}=await m(null!==(e=null===i||void 0===i?void 0:i.number)&&void 0!==e?e:void 0),{error:f,data:O}=await m(null!==(o=null===p||void 0===p?void 0:p.number)&&void 0!==o?o:void 0),y=s||u||f,D=b(null===l||void 0===l||null===(r=l.glideFactories)||void 0===r?void 0:r[0]),k=b(null===v||void 0===v||null===(n=v.glideFactories)||void 0===n?void 0:n[0]),S=b(null===O||void 0===O||null===(a=O.glideFactories)||void 0===a?void 0:a[0]);if(y||!(D&&k&&S))t({error:!0});else{const[e,o]=d(D.totalVolumeUSD,k.totalVolumeUSD,S.totalVolumeUSD),r=c(D.totalLiquidityUSD,k.totalLiquidityUSD),[n,a]=d(D.totalTransactions,k.totalTransactions,S.totalTransactions),s={volumeUSD:e,volumeUSDChange:"number"===typeof o?o:0,liquidityUSD:D.totalLiquidityUSD,liquidityUSDChange:r,txCount:n,txCountChange:a};t({error:!1,data:s})}})()},[i,p,s,e]),e},v=o(819);const f=n.gql`
  query overviewCharts($startTime: Int!, $skip: Int!) {
    glideDayDatas(first: 1000, skip: $skip, where: { date_gt: $startTime }, orderBy: date, orderDirection: asc) {
      date
      dailyVolumeUSD
      totalLiquidityUSD
    }
  }
`,O=async e=>{try{const{glideDayDatas:t}=await Object(n.request)(a.c,f,{startTime:s.f,skip:e});return{data:t.map(v.c),error:!1}}catch(t){return console.error("Failed to fetch overview chart data",t),{error:!0}}};var y=()=>{const[e,t]=Object(r.useState)(),[o,n]=Object(r.useState)(!1);return Object(r.useEffect)(()=>{e||o||(async()=>{const{data:e}=await Object(v.a)(O);e?t(e):n(!0)})()},[e,o]),{error:o,data:e}};const D=n.gql`
  query overviewTransactions {
    mints: mints(first: 33, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      to
      amount0
      amount1
      amountUSD
    }
    swaps: swaps(first: 33, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      from
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
    }
    burns: burns(first: 33, orderBy: timestamp, orderDirection: desc) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      sender
      amount0
      amount1
      amountUSD
    }
  }
`;var k=async()=>{try{const e=await Object(n.request)(a.c,D);if(!e)return;const t=e.mints.map(v.d),o=e.burns.map(v.b),r=e.swaps.map(v.f);return[...t,...o,...r].sort((e,t)=>parseInt(t.timestamp,10)-parseInt(e.timestamp,10))}catch{return}};var S=()=>{const[e,t]=Object(r.useState)([]),[o]=Object(l.a)();return Object(r.useEffect)(()=>{const r=async()=>{const e=await(async e=>{try{const t=n.gql`
      query topPools($blacklist: [String!], $timestamp24hAgo: Int) {
        pairDayDatas(
          first: 30
          where: { dailyTxns_gt: 0, token0_not_in: $blacklist, token1_not_in: $blacklist, date_gt: $timestamp24hAgo }
          orderBy: dailyVolumeUSD
          orderDirection: desc
        ) {
          id
        }
      }
    `;return(await Object(n.request)(a.c,t,{blacklist:s.g,timestamp24hAgo:e})).pairDayDatas.map(e=>e.id.split("-")[0])}catch(t){return console.error("Failed to fetch top pools",t),[]}})(o);t(e)};0===e.length&&r()},[e,o]),e};const A=(e,t)=>{const o=e?`block: {number: ${e}}`:"";return`pairs(\n    where: { id_in: ${`["${t.join('","')}"]`} }\n    ${o}\n    orderBy: trackedReserveELA\n    orderDirection: desc\n  ) {\n    id\n    reserve0\n    reserve1\n    reserveUSD\n    volumeUSD\n    token0Price\n    token1Price\n    token0 {\n      id\n      symbol\n      name\n    }\n    token1 {\n      id\n      symbol\n      name\n    }\n  }`},_=e=>e?e.reduce((e,t)=>{const{volumeUSD:o,reserveUSD:r,reserve0:n,reserve1:a,token0Price:s,token1Price:i}=t;return e[t.id]={...t,volumeUSD:parseFloat(o),reserveUSD:parseFloat(r),reserve0:parseFloat(n),reserve1:parseFloat(a),token0Price:parseFloat(s),token1Price:parseFloat(i)},e},{}):{};var j=e=>{const[t,o]=Object(r.useState)({error:!1}),[i,m,b,p]=Object(l.a)(),{blocks:v,error:f}=Object(u.b)([i,m,b,p]),[O,y,D,k]=null!==v&&void 0!==v?v:[];return Object(r.useEffect)(()=>{const t=async()=>{const{error:t,data:r}=await(async(e,o,r,s,i)=>{try{const t=n.gql`
      query pools {
        now: ${A(null,i)}
        oneDayAgo: ${A(e,i)}
        twoDaysAgo: ${A(o,i)}
        oneWeekAgo: ${A(r,i)}
        twoWeeksAgo: ${A(s,i)}
      }
    `;return{data:await Object(n.request)(a.c,t),error:!1}}catch(t){return console.error("Failed to fetch pool data",t),{error:!0}}})(O.number,y.number,D.number,k.number,e);if(t)o({error:!0});else{const t=_(null===r||void 0===r?void 0:r.now),n=_(null===r||void 0===r?void 0:r.oneDayAgo),a=_(null===r||void 0===r?void 0:r.twoDaysAgo),i=_(null===r||void 0===r?void 0:r.oneWeekAgo),l=_(null===r||void 0===r?void 0:r.twoWeeksAgo),u=e.reduce((e,o)=>{const r=t[o],u=n[o],m=a[o],b=i[o],p=l[o],[v,f]=d(null===r||void 0===r?void 0:r.volumeUSD,null===u||void 0===u?void 0:u.volumeUSD,null===m||void 0===m?void 0:m.volumeUSD),[O,y]=d(null===r||void 0===r?void 0:r.volumeUSD,null===b||void 0===b?void 0:b.volumeUSD,null===p||void 0===p?void 0:p.volumeUSD),D=r?r.reserveUSD:0,k=c(null===r||void 0===r?void 0:r.reserveUSD,null===u||void 0===u?void 0:u.reserveUSD),S=r?r.reserve0:0,A=r?r.reserve1:0,{totalFees24h:_,totalFees7d:j,lpFees24h:h,lpFees7d:E,lpApr7d:T}=((e,t,o)=>{const r=e*s.h,n=t*s.h,a=e*s.b,i=t*s.b,c=o>0?t*s.b*s.i*100/o:0;return{totalFees24h:r,totalFees7d:n,lpFees24h:a,lpFees7d:i,lpApr7d:c!==1/0?c:0}})(v,O,D);return r&&(e[o]={address:o,token0:{address:r.token0.id,name:r.token0.name,symbol:r.token0.symbol},token1:{address:r.token1.id,name:r.token1.name,symbol:r.token1.symbol},token0Price:r.token0Price,token1Price:r.token1Price,volumeUSD:v,volumeUSDChange:f,volumeUSDWeek:O,volumeUSDChangeWeek:y,totalFees24h:_,totalFees7d:j,lpFees24h:h,lpFees7d:E,lpApr7d:T,liquidityUSD:D,liquidityUSDChange:k,liquidityToken0:S,liquidityToken1:A}),e},{});o({data:u,error:!1})}},r=(null===O||void 0===O?void 0:O.number)&&(null===y||void 0===y?void 0:y.number)&&(null===D||void 0===D?void 0:D.number)&&(null===k||void 0===k?void 0:k.number);e.length>0&&r&&!f&&t()},[e,O,y,D,k,f]),t};const h=n.gql`
  query prices($block24: Int!, $block48: Int!, $blockWeek: Int!) {
    current: bundle(id: "1") {
      elaPrice
    }
    oneDay: bundle(id: "1", block: { number: $block24 }) {
      elaPrice
    }
    twoDay: bundle(id: "1", block: { number: $block48 }) {
      elaPrice
    }
    oneWeek: bundle(id: "1", block: { number: $blockWeek }) {
      elaPrice
    }
  }
`,E=()=>{const[e,t]=Object(r.useState)(),[o,s]=Object(r.useState)(!1),[i,c,d]=Object(l.a)(),{blocks:m,error:b}=Object(u.b)([i,c,d]);return Object(r.useEffect)(()=>{const r=async()=>{const[e,r,i]=m,{elaPrices:c,error:d}=await(async(e,t,r)=>{try{var s,i,c,d,l,u,m,b;const o=await Object(n.request)(a.c,h,{block24:e,block48:t,blockWeek:r});return{error:!1,elaPrices:{current:parseFloat(null!==(s=null===(i=o.current)||void 0===i?void 0:i.elaPrice)&&void 0!==s?s:"0"),oneDay:parseFloat(null!==(c=null===(d=o.oneDay)||void 0===d?void 0:d.elaPrice)&&void 0!==c?c:"0"),twoDay:parseFloat(null!==(l=null===(u=o.twoDay)||void 0===u?void 0:u.elaPrice)&&void 0!==l?l:"0"),week:parseFloat(null!==(m=null===(b=o.oneWeek)||void 0===b?void 0:b.elaPrice)&&void 0!==m?m:"0")}}}catch(o){return console.error("Failed to fetch ELA prices",o),{error:!0,elaPrices:void 0}}})(e.number,r.number,i.number);d?s(!0):t(c)};e||o||!m||b||r()},[o,e,m,b]),e},T=(e,t)=>`tokens(\n      where: {id_in: ${`["${t.join('","')}"]`}}\n      ${e?`block: {number: ${e}}`:""}\n      orderBy: tradeVolumeUSD\n      orderDirection: desc\n    ) {\n      id\n      symbol\n      name\n      derivedELA\n      derivedUSD\n      tradeVolumeUSD\n      totalTransactions\n      totalLiquidity\n    }\n  `,U=e=>e?e.reduce((e,t)=>{const{derivedELA:o,derivedUSD:r,tradeVolumeUSD:n,totalTransactions:a,totalLiquidity:s}=t;return e[t.id]={...t,derivedELA:parseFloat(o),derivedUSD:parseFloat(r),tradeVolumeUSD:parseFloat(n),totalTransactions:parseFloat(a),totalLiquidity:parseFloat(s)},e},{}):{};var P=e=>{const[t,o]=Object(r.useState)({error:!1}),[s,m,b,p]=Object(l.a)(),{blocks:v,error:f}=Object(u.b)([s,m,b,p]),[O,y,D,k]=null!==v&&void 0!==v?v:[],S=E();return Object(r.useEffect)(()=>{const t=async()=>{const{error:t,data:r}=await(async(e,o,r,s,i)=>{try{const t=n.gql`
      query tokens {
        now: ${T(null,i)}
        oneDayAgo: ${T(e,i)}
        twoDaysAgo: ${T(o,i)}
        oneWeekAgo: ${T(r,i)}
        twoWeeksAgo: ${T(s,i)}
      }
    `;return{data:await Object(n.request)(a.c,t),error:!1}}catch(t){return console.error("Failed to fetch token data",t),{error:!0}}})(O.number,y.number,D.number,k.number,e);if(t)o({error:!0});else{const t=U(null===r||void 0===r?void 0:r.now),n=U(null===r||void 0===r?void 0:r.oneDayAgo),a=U(null===r||void 0===r?void 0:r.twoDaysAgo),s=U(null===r||void 0===r?void 0:r.oneWeekAgo),l=U(null===r||void 0===r?void 0:r.twoWeeksAgo),u=e.reduce((e,o)=>{const r=t[o],u=n[o],m=a[o],b=s[o],p=l[o],[v,f]=d(null===r||void 0===r?void 0:r.tradeVolumeUSD,null===u||void 0===u?void 0:u.tradeVolumeUSD,null===m||void 0===m?void 0:m.tradeVolumeUSD),[O]=d(null===r||void 0===r?void 0:r.tradeVolumeUSD,null===b||void 0===b?void 0:b.tradeVolumeUSD,null===p||void 0===p?void 0:p.tradeVolumeUSD),y=r?r.totalLiquidity*r.derivedUSD:0,D=u?u.totalLiquidity*u.derivedUSD:0,k=c(y,D),A=r?r.totalLiquidity:0,_=r?r.derivedELA*S.current:0,j=u?u.derivedELA*S.oneDay:0,h=b?b.derivedELA*S.week:0,E=c(_,j),T=c(_,h),U=i(null===r||void 0===r?void 0:r.totalTransactions,null===u||void 0===u?void 0:u.totalTransactions);return e[o]={exists:!!r,address:o,name:r?r.name:"",symbol:r?r.symbol:"",volumeUSD:v,volumeUSDChange:f,volumeUSDWeek:O,txCount:U,liquidityUSD:y,liquidityUSDChange:k,liquidityToken:A,priceUSD:_,priceUSDChange:E,priceUSDChangeWeek:T},e},{});o({data:u,error:!1})}},r=(null===O||void 0===O?void 0:O.number)&&(null===y||void 0===y?void 0:y.number)&&(null===D||void 0===D?void 0:D.number)&&(null===k||void 0===k?void 0:k.number);e.length>0&&r&&!f&&S&&t()},[e,O,y,D,k,f,S]),t};var g=()=>{const[e,t]=Object(r.useState)([]),[o]=Object(l.a)();return Object(r.useEffect)(()=>{const r=async()=>{const e=await(async e=>{try{const t=n.gql`
      query topTokens($blacklist: [String!], $timestamp24hAgo: Int) {
        tokenDayDatas(
          first: 30
          where: { dailyTxns_gt: 0, id_not_in: $blacklist, date_gt: $timestamp24hAgo }
          orderBy: dailyVolumeUSD
          orderDirection: desc
        ) {
          id
        }
      }
    `;return(await Object(n.request)(a.c,t,{blacklist:s.g,timestamp24hAgo:e})).tokenDayDatas.map(e=>e.id.split("-")[0])}catch(t){return console.error("Failed to fetch top tokens",t),[]}})(o);t(e)};0===e.length&&r()},[e,o]),e},w=o(806);const C=()=>{const[e,t]=Object(w.j)(),{data:o,error:n}=p(),[a,s]=Object(w.i)(),{data:i,error:c}=y(),[d,l]=Object(w.k)();return Object(r.useEffect)(()=>{void 0===e&&o&&!n&&t(o)},[n,o,e,t]),Object(r.useEffect)(()=>{void 0===a&&i&&!c&&s(i)},[a,c,i,s]),Object(r.useEffect)(()=>{d||(async()=>{const e=await k();e&&l(e)})()},[d,l]),null},F=()=>{const e=Object(w.q)(),t=Object(w.a)(),o=Object(w.c)(),n=S();Object(r.useEffect)(()=>{n.length>0&&t(n)},[t,n]);const a=Object(r.useMemo)(()=>Object.keys(o).reduce((e,t)=>(o[t].data||e.push(t),e),[]),[o]),{error:s,data:i}=j(a);return Object(r.useEffect)(()=>{i&&!s&&e(Object.values(i))},[s,i,e]),null},$=()=>{const e=Object(w.r)(),t=Object(w.b)(),o=Object(w.d)(),n=g();Object(r.useEffect)(()=>{n.length>0&&t(n)},[t,n]);const a=Object(r.useMemo)(()=>Object.keys(o).reduce((e,t)=>(o[t].data||e.push(t),e),[]),[o]),{error:s,data:i}=P(a);return Object(r.useEffect)(()=>{i&&!s&&e(Object.values(i))},[s,i,e]),null}},794:function(e,t,o){"use strict";o.d(t,"b",function(){return r}),o.d(t,"c",function(){return n}),o.d(t,"a",function(){return a});Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_GRAPH_API_PROFILE,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_GRAPH_API_PREDICTION,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_GRAPH_API_LOTTERY,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_SNAPSHOT_VOTING_API,Object({NODE_ENV:"production",PUBLIC_URL:".",WDS_SOCKET_HOST:void 0,WDS_SOCKET_PATH:void 0,WDS_SOCKET_PORT:void 0,FAST_REFRESH:!0,REACT_APP_CHAIN_ID:"20",REACT_APP_NODE_1:"/api/rpc/esc",REACT_APP_NODE_2:"https://esc.elasafe.com",REACT_APP_INFURA_KEY:"d3649643a26e40ac95d47a1b929d3596",REACT_APP_WALLETCONNECT_PROJECT_ID:"2a6688f0c62abe9cecaeda54f58fa82f"}).REACT_APP_SNAPSHOT_BASE_URL;const r="https://api.glidefinance.io",n="https://api.glidefinance.io/subgraphs/name/glide/exchange",a="https://api.glidefinance.io/subgraphs/name/glide/blocks"},799:function(e,t,o){"use strict";o.d(t,"c",function(){return r}),o.d(t,"i",function(){return n}),o.d(t,"h",function(){return a}),o.d(t,"b",function(){return s}),o.d(t,"f",function(){return i}),o.d(t,"d",function(){return c}),o.d(t,"e",function(){return d}),o.d(t,"a",function(){return l}),o.d(t,"g",function(){return u});const r=2,n=52.1429,a=.0025,s=5e-4,i=1635919200,c=86400,d=3600,l=10,u=["0x"]},806:function(e,t,o){"use strict";o.d(t,"j",function(){return U}),o.d(t,"i",function(){return P}),o.d(t,"k",function(){return g}),o.d(t,"c",function(){return w}),o.d(t,"q",function(){return C}),o.d(t,"a",function(){return F}),o.d(t,"f",function(){return $}),o.d(t,"e",function(){return q}),o.d(t,"g",function(){return R}),o.d(t,"d",function(){return I}),o.d(t,"r",function(){return N}),o.d(t,"b",function(){return L}),o.d(t,"n",function(){return W}),o.d(t,"m",function(){return B}),o.d(t,"h",function(){return V}),o.d(t,"l",function(){return H}),o.d(t,"o",function(){return K}),o.d(t,"p",function(){return x});var r=o(1),n=o(24),a=o(1237),s=o(1239),i=o(1240),c=o(32),d=o(795),l=o(794),u=o(799),m=o(819);const b=async(e,t)=>{try{const o=d.gql`
      query pairDayDatas($startTime: Int!, $skip: Int!, $address: Bytes!) {
        pairDayDatas(
          first: 1000
          skip: $skip
          where: { pairAddress: $address, date_gt: $startTime }
          orderBy: date
          orderDirection: asc
        ) {
          date
          dailyVolumeUSD
          reserveUSD
        }
      }
    `,{pairDayDatas:r}=await Object(d.request)(l.c,o,{startTime:u.f,skip:e,address:t});return{data:r.map(m.e),error:!1}}catch(o){return console.error("Failed to fetch pool chart data",o),{error:!0}}};var p=async e=>Object(m.a)(b,e);const v=d.gql`
  query poolTransactions($address: Bytes!) {
    mints(first: 35, orderBy: timestamp, orderDirection: desc, where: { pair: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      to
      amount0
      amount1
      amountUSD
    }
    swaps(first: 35, orderBy: timestamp, orderDirection: desc, where: { pair: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      from
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
    }
    burns(first: 35, orderBy: timestamp, orderDirection: desc, where: { pair: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      sender
      amount0
      amount1
      amountUSD
    }
  }
`;var f=async e=>{try{const t=await Object(d.request)(l.c,v,{address:e}),o=t.mints.map(m.d),r=t.burns.map(m.b),n=t.swaps.map(m.f);return{data:[...o,...r,...n],error:!1}}catch(t){return console.error(`Failed to fetch transactions for pool ${e}`,t),{error:!0}}};const O=async(e,t)=>{try{const o=d.gql`
      query tokenDayDatas($startTime: Int!, $skip: Int!, $address: Bytes!) {
        tokenDayDatas(
          first: 1000
          skip: $skip
          where: { token: $address, date_gt: $startTime }
          orderBy: date
          orderDirection: asc
        ) {
          date
          dailyVolumeUSD
          totalLiquidityUSD
        }
      }
    `,{tokenDayDatas:r}=await Object(d.request)(l.c,o,{startTime:u.f,skip:e,address:t});return{data:r.map(m.c),error:!1}}catch(o){return console.error("Failed to fetch token chart data",o),{error:!0}}};var y=async e=>Object(m.a)(O,e);const D=d.gql`
  query tokenTransactions($address: Bytes!) {
    mintsAs0: mints(first: 10, orderBy: timestamp, orderDirection: desc, where: { token0: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      to
      amount0
      amount1
      amountUSD
    }
    mintsAs1: mints(first: 10, orderBy: timestamp, orderDirection: desc, where: { token0: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      to
      amount0
      amount1
      amountUSD
    }
    swapsAs0: swaps(first: 10, orderBy: timestamp, orderDirection: desc, where: { token0: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      from
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
    }
    swapsAs1: swaps(first: 10, orderBy: timestamp, orderDirection: desc, where: { token1: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      from
      amount0In
      amount1In
      amount0Out
      amount1Out
      amountUSD
    }
    burnsAs0: burns(first: 10, orderBy: timestamp, orderDirection: desc, where: { token0: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      sender
      amount0
      amount1
      amountUSD
    }
    burnsAs1: burns(first: 10, orderBy: timestamp, orderDirection: desc, where: { token1: $address }) {
      id
      timestamp
      pair {
        token0 {
          id
          symbol
        }
        token1 {
          id
          symbol
        }
      }
      sender
      amount0
      amount1
      amountUSD
    }
  }
`;var k=async e=>{try{const t=await Object(d.request)(l.c,D,{address:e}),o=t.mintsAs0.map(m.d),r=t.mintsAs1.map(m.d),n=t.burnsAs0.map(m.b),a=t.burnsAs1.map(m.b),s=t.swapsAs0.map(m.f),i=t.swapsAs1.map(m.f);return{data:[...o,...r,...n,...a,...s,...i],error:!1}}catch(t){return console.error(`Failed to fetch transactions for token ${e}`,t),{error:!0}}},S=o(826),A=o(811);const _=e=>d.gql`
    query tokenPriceData {
      ${e}
    }
  `;var j=async(e,t,o)=>{const r=Object(a.a)(new Date),n=[];let s=o;for(;s<=r;)n.push(s),s+=t;try{const t=await Object(S.a)(n,"asc",500);if(!t||0===t.length)return console.error("Error fetching blocks for timestamps",n),{error:!1};const o=await Object(A.b)(_,((e,t)=>t.map(t=>`\n      t${t.timestamp}:token(id:"${e}", block: { number: ${t.number} }) { \n        derivedELA\n      }\n      b${t.timestamp}: bundle(id:"1", block: { number: ${t.number} }) { \n        elaPrice\n      }\n    `))(e,t),l.c,200);if(!o)return console.error("Price data failed to load"),{error:!1};const r=[];Object.keys(o).forEach(e=>{const t=e.split("t")[1];var n;t&&r.push({timestamp:t,derivedELA:null!==(n=o[e])&&void 0!==n&&n.derivedELA?parseFloat(o[e].derivedELA):0,priceUSD:0})}),Object.keys(o).forEach(e=>{const t=e.split("b")[1];if(t){const s=r.findIndex(e=>e.timestamp===t);if(s>=0){var n,a;const{derivedELA:t}=r[s];r[s].priceUSD=parseFloat(null!==(n=null===(a=o[e])||void 0===a?void 0:a.elaPrice)&&void 0!==n?n:0)*t}}}),r.sort((e,t)=>parseInt(e.timestamp,10)-parseInt(t.timestamp,10));const a=[];for(let e=0;e<r.length-1;e++)a.push({time:parseFloat(r[e].timestamp),open:r[e].priceUSD,close:r[e+1].priceUSD,high:r[e+1].priceUSD,low:r[e].priceUSD});return{data:a,error:!1}}catch(i){return console.error(`Failed to fetch price data for token ${e}`,i),{error:!0}}};const h=d.gql`
  query poolsForToken($address: Bytes!, $blacklist: [String!]) {
    asToken0: pairs(
      first: 15
      orderBy: trackedReserveELA
      orderDirection: desc
      where: { totalTransactions_gt: 100, token0: $address, token1_not_in: $blacklist }
    ) {
      id
    }
    asToken1: pairs(
      first: 15
      orderBy: trackedReserveELA
      orderDirection: desc
      where: { totalTransactions_gt: 100, token1: $address, token0_not_in: $blacklist }
    ) {
      id
    }
  }
`;var E=async e=>{try{const t=await Object(d.request)(l.c,h,{address:e,blacklist:u.g});return{error:!1,addresses:t.asToken0.concat(t.asToken1).map(e=>e.id)}}catch(t){return console.error(`Failed to fetch pools for token ${e}`,t),{error:!0}}},T=o(102);const U=()=>{const e=Object(n.c)(e=>e.info.protocol.overview),t=Object(n.b)();return[e,Object(r.useCallback)(e=>t(Object(T.h)({protocolData:e})),[t])]},P=()=>{const e=Object(n.c)(e=>e.info.protocol.chartData),t=Object(n.b)();return[e,Object(r.useCallback)(e=>t(Object(T.g)({chartData:e})),[t])]},g=()=>{const e=Object(n.c)(e=>e.info.protocol.transactions),t=Object(n.b)();return[e,Object(r.useCallback)(e=>t(Object(T.i)({transactions:e})),[t])]},w=()=>Object(n.c)(e=>e.info.pools.byAddress),C=()=>{const e=Object(n.b)();return Object(r.useCallback)(t=>e(Object(T.e)({pools:t})),[e])},F=()=>{const e=Object(n.b)();return Object(r.useCallback)(t=>e(Object(T.a)({poolAddresses:t})),[e])},$=e=>{const t=w(),o=F(),n=e.reduce((e,o)=>(Object.keys(t).includes(o)||e.push(o),e),[]);Object(r.useEffect)(()=>{n&&o(n)},[o,n]);return e.map(e=>{var o;return null===(o=t[e])||void 0===o?void 0:o.data}).filter(e=>e)},q=e=>{const t=Object(n.b)(),o=Object(n.c)(t=>t.info.pools.byAddress[e]),a=null===o||void 0===o?void 0:o.chartData,[s,i]=Object(r.useState)(!1);return Object(r.useEffect)(()=>{a||s||(async()=>{const{error:o,data:r}=await p(e);!o&&r&&t(Object(T.d)({poolAddress:e,chartData:r})),o&&i(o)})()},[e,t,s,a]),a},R=e=>{const t=Object(n.b)(),o=Object(n.c)(t=>t.info.pools.byAddress[e]),a=null===o||void 0===o?void 0:o.transactions,[s,i]=Object(r.useState)(!1);return Object(r.useEffect)(()=>{a||s||(async()=>{const{error:o,data:r}=await f(e);o?i(!0):t(Object(T.f)({poolAddress:e,transactions:r}))})()},[e,t,s,a]),a},I=()=>Object(n.c)(e=>e.info.tokens.byAddress),N=()=>{const e=Object(n.b)();return Object(r.useCallback)(t=>{e(Object(T.k)({tokens:t}))},[e])},L=()=>{const e=Object(n.b)();return Object(r.useCallback)(t=>e(Object(T.b)({tokenAddresses:t})),[e])},W=e=>{const t=I(),o=L();null===e||void 0===e||e.forEach(e=>{t[e]||o([e])});return Object(r.useMemo)(()=>{if(e)return e.map(e=>{var o;return null===(o=t[e])||void 0===o?void 0:o.data}).filter(e=>e)},[e,t])},B=e=>{var t;const o=I(),r=L();if(e&&Object(c.h)(e))return o[e]||r([e]),null===(t=o[e])||void 0===t?void 0:t.data},V=e=>{const t=Object(n.b)(),o=Object(n.c)(t=>t.info.tokens.byAddress[e]).poolAddresses,[a,s]=Object(r.useState)(!1);return Object(r.useEffect)(()=>{o||a||(async()=>{const{error:o,addresses:r}=await E(e);!o&&r&&t(Object(T.c)({tokenAddress:e,poolAddresses:r})),o&&s(o)})()},[e,t,a,o]),o},H=e=>{const t=Object(n.b)(),o=Object(n.c)(t=>t.info.tokens.byAddress[e]),{chartData:a}=o,[s,i]=Object(r.useState)(!1);return Object(r.useEffect)(()=>{a||s||(async()=>{const{error:o,data:r}=await y(e);!o&&r&&t(Object(T.j)({tokenAddress:e,chartData:r})),o&&i(o)})()},[e,t,s,a]),a},K=(e,t,o)=>{const c=Object(n.b)(),d=Object(n.c)(t=>t.info.tokens.byAddress[e]),l=d.priceData[t],[u,m]=Object(r.useState)(!1),b=d.priceData.oldestFetchedTimestamp,p=1e3*Object(a.a)(new Date),v=Object(a.a)(Object(s.a)(Object(i.a)(p,o)));return Object(r.useEffect)(()=>{l||u||(async()=>{const{data:o,error:r}=await j(e,t,v);o&&c(Object(T.l)({tokenAddress:e,secondsInterval:t,priceData:o,oldestFetchedTimestamp:v})),r&&m(!0)})()},[e,c,u,t,b,l,v,o]),l},x=e=>{const t=Object(n.b)(),o=Object(n.c)(t=>t.info.tokens.byAddress[e]),{transactions:a}=o,[s,i]=Object(r.useState)(!1);return Object(r.useEffect)(()=>{a||s||(async()=>{const{error:o,data:r}=await k(e);o?i(!0):r&&t(Object(T.m)({tokenAddress:e,transactions:r}))})()},[e,t,s,a]),a}},811:function(e,t,o){"use strict";o.d(t,"b",function(){return c}),o.d(t,"a",function(){return d});var r=o(1237),n=o(1238),a=o(480),s=o(679),i=o(795);const c=async function(e,t,o){let r=arguments.length>3&&void 0!==arguments[3]?arguments[3]:1e3,n={},a=!1,s=0;try{for(;!a;){let c=t.length;s+r<t.length&&(c=s+r);const d=t.slice(s,c),l=await Object(i.request)(o,e(d));n={...n,...l},a=Object.keys(l).length<r||s+r>t.length,s+=r}return n}catch(c){return console.error("Failed to fetch info data",c),null}},d=()=>{const e=1e3*Object(r.a)(new Date);return[Object(r.a)(Object(n.a)(Object(a.default)(e,1))),Object(r.a)(Object(n.a)(Object(a.default)(e,2))),Object(r.a)(Object(n.a)(Object(s.default)(e,1))),Object(r.a)(Object(n.a)(Object(s.default)(e,2)))]}},819:function(e,t,o){"use strict";o.d(t,"d",function(){return s}),o.d(t,"b",function(){return i}),o.d(t,"f",function(){return c}),o.d(t,"c",function(){return d}),o.d(t,"e",function(){return l}),o.d(t,"a",function(){return u});var r=o(799),n=o(1237),a=o(892);const s=e=>({type:a.a.MINT,hash:e.id.split("-")[0],timestamp:e.timestamp,sender:e.to,token0Symbol:e.pair.token0.symbol,token1Symbol:e.pair.token1.symbol,token0Address:e.pair.token0.id,token1Address:e.pair.token1.id,amountUSD:parseFloat(e.amountUSD),amountToken0:parseFloat(e.amount0),amountToken1:parseFloat(e.amount1)}),i=e=>({type:a.a.BURN,hash:e.id.split("-")[0],timestamp:e.timestamp,sender:e.sender,token0Symbol:e.pair.token0.symbol,token1Symbol:e.pair.token1.symbol,token0Address:e.pair.token0.id,token1Address:e.pair.token1.id,amountUSD:parseFloat(e.amountUSD),amountToken0:parseFloat(e.amount0),amountToken1:parseFloat(e.amount1)}),c=e=>({type:a.a.SWAP,hash:e.id.split("-")[0],timestamp:e.timestamp,sender:e.from,token0Symbol:e.pair.token0.symbol,token1Symbol:e.pair.token1.symbol,token0Address:e.pair.token0.id,token1Address:e.pair.token1.id,amountUSD:parseFloat(e.amountUSD),amountToken0:parseFloat(e.amount0In)-parseFloat(e.amount0Out),amountToken1:parseFloat(e.amount1In)-parseFloat(e.amount1Out)}),d=e=>({date:e.date,volumeUSD:parseFloat(e.dailyVolumeUSD),liquidityUSD:parseFloat(e.totalLiquidityUSD)}),l=e=>({date:e.date,volumeUSD:parseFloat(e.dailyVolumeUSD),liquidityUSD:parseFloat(e.reserveUSD)}),u=async(e,t)=>{var o,a;let s=[],i=!1,c=0,d=!1;for(;!d;){const{data:o,error:r}=await e(c,t);c+=1e3,d=o.length<1e3,i=r,o&&(s=s.concat(o))}if(i||0===s.length)return{error:!0};const l=s.reduce((e,t)=>{const o=parseInt((t.date/r.d).toFixed(0));return{[o]:t,...e}},{}),u=l[Object.keys(l).map(e=>parseInt(e,10))[0]];let m=null!==(o=null===u||void 0===u?void 0:u.date)&&void 0!==o?o:r.f,b=null!==(a=null===u||void 0===u?void 0:u.liquidityUSD)&&void 0!==a?a:0;const p=Object(n.a)(new Date);for(;m<p-r.d;){m+=r.d;const e=parseInt((m/r.d).toFixed(0),10);Object.keys(l).includes(e.toString())?b=l[e].liquidityUSD:l[e]={date:m,volumeUSD:0,liquidityUSD:b}}return{data:Object.values(l),error:!1}}},826:function(e,t,o){"use strict";o.d(t,"a",function(){return c}),o.d(t,"b",function(){return d});var r=o(795),n=o(1),a=o(811),s=o(794);const i=e=>r.gql`query blocks {
    ${e}
  }`,c=async function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:"desc",o=arguments.length>2&&void 0!==arguments[2]?arguments[2]:500;if(0===(null===e||void 0===e?void 0:e.length))return[];const r=await Object(a.b)(i,(e=>e.map(e=>`t${e}:blocks(first: 1, orderBy: timestamp, orderDirection: desc, where: { timestamp_gt: ${e}, timestamp_lt: ${e+600} }) {\n      number\n    }`))(e),s.a,o),n="desc"===t?(e,t)=>t.number-e.number:(e,t)=>e.number-t.number,c=[];if(r){for(const e of Object.keys(r))r[e].length>0&&c.push({timestamp:e.split("t")[1],number:parseInt(r[e][0].number,10)});c.sort(n)}return c},d=function(e){let t=arguments.length>1&&void 0!==arguments[1]?arguments[1]:"desc",o=arguments.length>2&&void 0!==arguments[2]?arguments[2]:1e3;const[r,a]=Object(n.useState)(),[s,i]=Object(n.useState)(!1),d=JSON.stringify(e),l=r?JSON.stringify(r):void 0;return Object(n.useEffect)(()=>{(l?JSON.parse(l):void 0)||s||(async()=>{const e=JSON.parse(d),r=await c(e,t,o);0===r.length?i(!0):a(r)})()},[l,s,o,t,d]),{blocks:r,error:s}}},892:function(e,t,o){"use strict";o.d(t,"a",function(){return r});let r=function(e){return e[e.SWAP=0]="SWAP",e[e.MINT=1]="MINT",e[e.BURN=2]="BURN",e}({})}}]);
//# sourceMappingURL=1.b512c85f.chunk.js.map
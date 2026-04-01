(this["webpackJsonpglide-frontend"]=this["webpackJsonpglide-frontend"]||[]).push([[12],{1248:function(e,t,r){"use strict";r.r(t),r.d(t,"default",function(){return Yt});var i=r(1),a=r.n(i),n=r(63),c=r(6),s=r.n(c),l=r(27),d=r(2),o=r(5),b=r(35),j=r(3),x=r(249),p=r(139),u=r(56),h=r(149),m=r(7),O=r(10),g=r(144),f=r(85),y=r(147),v=r(407);const k={latin_map:{"\u03c4":"t","\u03a4":"T"}},w=e=>e.replace(/[^A-Za-z0-9[\] ]/g,e=>k.latin_map[e]||e);var S=r(50),C=r(255),D=r(318),T=r.n(D),$=r(0);const L=Object(j.e)(d.V)`
  border-radius: 16px;
  margin-left: auto;
`,A=j.e.div`
  position: relative;
  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    display: block;
  }
`,q=j.e.div``;var R=e=>{let{onChange:t,placeholder:r="Search"}=e;const[a,n]=Object(i.useState)(!1),[c,s]=Object(i.useState)(""),{t:l}=Object(m.b)(),d=Object(i.useMemo)(()=>T()(e=>t(e),500),[t]);return Object($.jsx)(q,{toggled:a,children:Object($.jsx)(A,{children:Object($.jsx)(L,{value:c,onChange:e=>{s(e.target.value),d(e)},placeholder:l(r),onBlur:()=>n(!1)})})})},N=r(424),B=r(250),M=r(142),I=r(32);const E=j.e.div`
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;

  svg {
    fill: ${e=>{let{theme:t}=e;return t.colors.primary}};
  }
`;var P=e=>{let{onClick:t,expanded:r}=e;const{t:i}=Object(m.b)();return Object($.jsxs)(E,{"aria-label":i("Hide or show expandable content"),role:"button",onClick:()=>t(),children:[Object($.jsx)(d.xb,{color:"primary",bold:!0,children:i(r?"Hide":"Details")}),r?Object($.jsx)(d.B,{}):Object($.jsx)(d.z,{})]})},F=r(13);var z=e=>{let{quoteTokenAddress:t,tokenAddress:r}=e;const i=Object(F.A)(),a=t?t[20]:null,n=r?r[20]:null;return`${a&&a!==i?a:"ELA"}/${n&&n!==i?n:"ELA"}`};const U=j.e.div`
  margin-top: 24px;
`,Q=Object(j.e)(d.X)`
  font-weight: 400;
`;var G=e=>{let{bscScanAddress:t,infoAddress:r,removed:i,totalValueFormatted:a,lpLabel:n,addLiquidityUrl:c}=e;const{t:s}=Object(m.b)();return Object($.jsxs)(U,{children:[Object($.jsxs)(d.M,{justifyContent:"space-between",children:[Object($.jsxs)(d.xb,{children:[s("Total Liquidity"),":"]}),a?Object($.jsx)(d.xb,{children:a}):Object($.jsx)(d.rb,{width:75,height:25})]}),!i&&Object($.jsx)(Q,{href:c,children:s("Get %symbol%",{symbol:n})}),Object($.jsx)(Q,{href:t,children:s("View Contract")}),Object($.jsx)(Q,{href:r,children:s("See Pair Info")})]})},V=r(188),W=r(243);const _=Object(j.e)(d.M)`
  svg {
    margin-right: 4px;
  }
`,H=Object(j.e)(d.wb)`
  margin-left: 4px;
`;var X=e=>{let{lpLabel:t,multiplier:r,isCommunityFarm:i,token:a,quoteToken:n}=e;return Object($.jsxs)(_,{justifyContent:"space-between",alignItems:"center",mb:"12px",children:[Object($.jsx)(W.a,{variant:"inverted",primaryToken:a,secondaryToken:n,width:64,height:64}),Object($.jsxs)(d.M,{flexDirection:"column",alignItems:"flex-end",children:[Object($.jsx)(d.P,{mb:"4px",children:t.split(" ")[0]}),Object($.jsxs)(d.M,{justifyContent:"center",children:[i?Object($.jsx)(V.a,{}):Object($.jsx)(V.c,{}),Object($.jsx)(H,{variant:"secondary",children:r})]})]})]})},Y=r(38),J=r(120),Z=r(25),K=r(60),ee=r(31);const te=j.e.div`
  height: ${e=>e.size}px;
  width: ${e=>e.size}px;
`;var re=e=>{let{size:t="md"}=e;const{spacing:r}=Object(i.useContext)(j.a);let a;switch(t){case"lg":a=r[6];break;case"sm":a=r[2];break;default:a=r[4]}return Object($.jsx)(te,{size:a})};const ie=j.e.div`
  align-items: center;
  background-color: ${e=>e.theme.colors.primaryDark}00;
  display: flex;
  margin: 0;
  padding: ${e=>e.theme.spacing[4]}px 0;
`,ae=j.e.div`
  flex: 1;
`;var ne=e=>{let{children:t}=e;const r=a.a.Children.toArray(t).length;return Object($.jsx)(ie,{children:a.a.Children.map(t,(e,t)=>Object($.jsxs)($.Fragment,{children:[Object($.jsx)(ae,{children:e}),t<r-1&&Object($.jsx)(re,{})]}))})};const ce=j.e.div`
  display: flex;
  flex-direction: column;
  background-color: ${e=>{let{theme:t}=e;return t.colors.input}};
  border-radius: 16px;
  box-shadow: ${e=>{let{isWarning:t=!1,theme:r}=e;return t?r.shadows.warning:r.shadows.inset}};
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
  padding: 8px 16px 8px 0;
  width: 100%;
  margin-bottom: 12px;
`,se=Object(j.e)(d.V)`
  box-shadow: none;
  width: 60px;
  margin: 0 8px;
  padding: 0 8px;
  border: none;

  ${e=>{let{theme:t}=e;return t.mediaQueries.xs}} {
    width: 80px;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    width: auto;
  }
`,le=Object(j.e)(d.xb)`
  position: absolute;
  bottom: -12px;
  a {
    display: inline;
  }
`;var de=e=>{let{max:t,symbol:r,onChange:i,onSelectMax:a,value:n,addLiquidityUrl:s,inputTitle:l,decimals:o=18}=e;const{t:b}=Object(m.b)(),j="0"===t||!t;return Object($.jsxs)("div",{style:{position:"relative"},children:[Object($.jsxs)(ce,{isWarning:j,children:[Object($.jsxs)(d.M,{justifyContent:"space-between",pl:"16px",children:[Object($.jsx)(d.xb,{fontSize:"14px",children:l}),Object($.jsx)(d.xb,{fontSize:"14px",children:b("Balance: %balance%",{balance:(e=>{if(j)return"0";const t=new c.BigNumber(e);return t.gt(0)&&t.lt(1e-4)?t.toLocaleString():t.toFixed(6,c.BigNumber.ROUND_DOWN)})(t)})})]}),Object($.jsxs)(d.M,{alignItems:"flex-end",justifyContent:"space-around",children:[Object($.jsx)(se,{pattern:`^[0-9]*[.,]?[0-9]{0,${o}}$`,inputMode:"decimal",step:"any",min:"0",onChange:i,placeholder:"0",value:n}),Object($.jsx)(d.m,{scale:"sm",onClick:a,mr:"8px",children:b("Max")}),Object($.jsx)(d.xb,{fontSize:"16px",children:r})]})]}),j&&Object($.jsxs)(le,{fontSize:"14px",color:"failure",children:[b("No tokens to stake"),":"," ",Object($.jsx)(d.W,{fontSize:"14px",bold:!1,href:s,external:!0,color:"failure",children:b("Get %symbol%",{symbol:r})})]})]})},oe=r(51),be=r(54),je=r(11);const xe=Object($.jsx)(d.f,{spin:!0,color:"currentColor"});var pe=e=>{let{max:t,onConfirm:r,onDismiss:a,tokenName:n="",addLiquidityUrl:c}=e;const[l,o]=Object(i.useState)(""),{theme:b}=Object(be.a)(),{toastSuccess:j,toastError:x}=Object(oe.a)(),[p,u]=Object(i.useState)(!1),{t:h}=Object(m.b)(),{chainId:g}=Object(je.a)(),f=Object(i.useMemo)(()=>Object(O.f)(t),[t]),y=new s.a(l),v=new s.a(f),k=Object(i.useCallback)(e=>{e.currentTarget.validity.valid&&o(e.currentTarget.value.replace(/,/g,"."))},[o]),w=Object(i.useCallback)(()=>{o(f)},[f,o]);return Object($.jsxs)(d.eb,{title:h("Stake LP tokens"),onDismiss:a,headerBackground:b.colors.gradients.cardHeader,children:[Object($.jsx)(de,{value:l,onSelectMax:w,onChange:k,max:f,symbol:n,addLiquidityUrl:c,inputTitle:h("Stake")}),Object($.jsxs)(ne,{children:[Object($.jsx)(d.m,{variant:"secondary",onClick:a,width:"100%",disabled:p,children:h("Cancel")}),Object($.jsx)(d.m,{width:"100%",disabled:p||!y.isFinite()||y.eq(0)||y.gt(v)||20!==g,isLoading:p,endIcon:p?xe:void 0,onClick:async()=>{u(!0);try{await r(l),j(h("Staked!"),h("Your tokens have been staked in the farm")),a()}catch(e){x(h("Error"),h("Please try again. Confirm the transaction and make sure you are paying enough gas!")),console.error(e)}finally{u(!1)}},children:h(p?"Confirming":"Confirm")})]}),Object($.jsx)(d.X,{href:c,style:{alignSelf:"center"},children:h("Get %symbol%",{symbol:n})})]})};const ue=Object($.jsx)(d.f,{spin:!0,color:"currentColor"});var he=e=>{let{onConfirm:t,onDismiss:r,max:a,tokenName:n=""}=e;const[c,l]=Object(i.useState)(""),{theme:o}=Object(be.a)(),{toastSuccess:b,toastError:j}=Object(oe.a)(),[x,p]=Object(i.useState)(!1),{t:u}=Object(m.b)(),{chainId:h}=Object(je.a)(),g=Object(i.useMemo)(()=>Object(O.f)(a),[a]),f=new s.a(c),y=new s.a(g),v=Object(i.useCallback)(e=>{e.currentTarget.validity.valid&&l(e.currentTarget.value.replace(/,/g,"."))},[l]),k=Object(i.useCallback)(()=>{l(g)},[g,l]);return Object($.jsxs)(d.eb,{title:u("Unstake LP tokens"),onDismiss:r,headerBackground:o.colors.gradients.cardHeader,children:[Object($.jsx)(de,{onSelectMax:k,onChange:v,value:c,max:g,symbol:n,inputTitle:u("Unstake")}),Object($.jsxs)(ne,{children:[Object($.jsx)(d.m,{variant:"secondary",onClick:r,width:"100%",disabled:x,children:u("Cancel")}),Object($.jsx)(d.m,{disabled:x||!f.isFinite()||f.eq(0)||f.gt(y)||20!==h,isLoading:x,endIcon:x?ue:void 0,onClick:async()=>{p(!0);try{await t(c),b(u("Unstaked!"),u("Your earnings have also been harvested to your wallet")),r()}catch(e){j(u("Error"),u("Please try again. Confirm the transaction and make sure you are paying enough gas!")),console.error(e)}finally{p(!1)}},width:"100%",children:u(x?"Confirming":"Confirm")})]})]})},me=r(98);var Oe=e=>{const t=Object(Z.i)();return{onUnstake:Object(i.useCallback)(async r=>{await Object(me.e)(t,e,r)},[t,e])}};var ge=e=>{const t=Object(Z.i)();return{onStake:Object(i.useCallback)(async r=>{const i=await Object(me.d)(t,e,r);console.info(i)},[t,e])}};const fe=j.e.div`
  display: flex;
  svg {
    width: 20px;
  }
`;var ye=e=>{let{stakedBalance:t,tokenBalance:r,tokenName:a,pid:c,addLiquidityUrl:o}=e;const{t:b}=Object(m.b)(),{onStake:j}=ge(c),{onUnstake:x}=Oe(c),p=Object(n.h)(),h=Object(Y.b)(),{account:g,chainId:f}=Object(l.c)(),y=Object(u.c)(a),v=Object(i.useCallback)(()=>{const e=Object(O.c)(t);return e.gt(0)&&e.lt(1e-7)?e.toFixed(10,s.a.ROUND_DOWN):e.gt(0)&&e.lt(1e-4)?Object(O.f)(t).toLocaleString():e.toFixed(3,s.a.ROUND_DOWN)},[t]),[k]=Object(d.Ob)(Object($.jsx)(pe,{max:r,onConfirm:async e=>{await j(e),h(Object(J.b)({account:g,pids:[c]}))},tokenName:a,addLiquidityUrl:o})),[w]=Object(d.Ob)(Object($.jsx)(he,{max:t,onConfirm:async e=>{await x(e),h(Object(J.b)({account:g,pids:[c]}))},tokenName:a}));return Object($.jsxs)(d.M,{justifyContent:"space-between",alignItems:"center",children:[Object($.jsxs)(d.M,{flexDirection:"column",alignItems:"flex-start",children:[Object($.jsx)(d.P,{color:t.eq(0)?"textDisabled":"text",children:v()}),t.gt(0)&&y.gt(0)&&Object($.jsx)(ee.a,{fontSize:"12px",color:"textSubtle",decimals:2,value:Object(O.d)(y.times(t)),unit:" USD",prefix:"~"})]}),t.eq(0)?Object($.jsx)(d.m,{onClick:k,disabled:["history","archived"].some(e=>p.pathname.includes(e))||20!==f,children:b("Stake LP")}):Object($.jsxs)(fe,{children:[Object($.jsx)(d.T,{variant:"tertiary",onClick:w,mr:"6px",children:Object($.jsx)(d.db,{color:"primary",width:"14px"})}),Object($.jsx)(d.T,{variant:"tertiary",onClick:k,disabled:["history","archived"].some(e=>p.pathname.includes(e)),children:Object($.jsx)(d.a,{color:"primary",width:"14px"})})]})]})},ve=r(17);var ke=e=>{const t=Object(Z.i)();return{onReward:Object(i.useCallback)(async()=>{await Object(me.c)(t,e)},[e,t])}};var we=e=>{let{earnings:t,pid:r}=e;const{account:a,chainId:n}=Object(l.c)(),{toastSuccess:c,toastError:o}=Object(oe.a)(),{t:b}=Object(m.b)(),[j,x]=Object(i.useState)(!1),{onReward:p}=ke(r),h=Object(u.f)(),g=Object(Y.b)(),f=a?Object(O.c)(t):ve.c,y=f.toFixed(3,s.a.ROUND_DOWN),v=f?f.multipliedBy(h).toNumber():0;return Object($.jsxs)(d.M,{mb:"8px",justifyContent:"space-between",alignItems:"center",children:[Object($.jsxs)(d.M,{flexDirection:"column",alignItems:"flex-start",children:[Object($.jsx)(d.P,{color:f.eq(0)?"textDisabled":"text",children:y}),v>0&&Object($.jsx)(ee.a,{fontSize:"12px",color:"textSubtle",decimals:2,value:v,unit:" USD",prefix:"~"})]}),Object($.jsx)(d.m,{disabled:f.eq(0)||j||20!==n,onClick:async()=>{x(!0);try{await p(),c(`${b("Harvested")}!`,b("Your %symbol% earnings have been sent to your wallet!",{symbol:"GLIDE"}))}catch(e){o(b("Error"),b("Please try again. Confirm the transaction and make sure you are paying enough gas!")),console.error(e)}finally{x(!1)}g(Object(J.b)({account:a,pids:[r]}))},children:b("Harvest")})]})},Se=r(71);var Ce=e=>{const t=Object(Z.i)();return{onApprove:Object(i.useCallback)(async()=>{try{const r=await e.approve(t.address,Se.a.constants.MaxUint256);return(await r.wait()).status}catch(r){return!1}},[e,t])}};const De=j.e.div`
  padding-top: 16px;
`;var Te=e=>{let{farm:t,account:r,addLiquidityUrl:a}=e;const{t:n}=Object(m.b)(),{chainId:c}=Object(je.a)(),[l,o]=Object(i.useState)(!1),{pid:b,lpAddresses:j}=t,{allowance:x=0,tokenBalance:p=0,stakedBalance:u=0,earnings:h=0}=t.userData||{},O=new s.a(x),g=new s.a(p),f=new s.a(u),y=new s.a(h),v=Object(F.a)(j),k=r&&O&&O.isGreaterThan(0),w=Object(Y.b)(),S=Object(Z.g)(v),{onApprove:C}=Ce(S),D=Object(i.useCallback)(async()=>{try{o(!0),await C(),w(Object(J.b)({account:r,pids:[b]})),o(!1)}catch(e){console.error(e)}},[C,w,r,b]);return Object($.jsxs)(De,{children:[Object($.jsxs)(d.M,{children:[Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"secondary",fontSize:"12px",pr:"4px",children:"GLIDE"}),Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:n("Earned")})]}),Object($.jsx)(we,{earnings:y,pid:b}),Object($.jsxs)(d.M,{children:[Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"secondary",fontSize:"12px",pr:"4px",children:t.lpSymbol}),Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:n("Staked")})]}),r?k?Object($.jsx)(ye,{stakedBalance:f,tokenBalance:g,tokenName:t.lpSymbol,pid:b,addLiquidityUrl:a}):Object($.jsx)(d.m,{mt:"8px",width:"100%",disabled:l||20!==c,onClick:D,children:n("Enable Contract")}):Object($.jsx)(K.a,{mt:"8px",width:"100%"})]})},$e=r(251);var Le=e=>{let{lpLabel:t,cakePrice:r,apr:i,displayApr:a,addLiquidityUrl:n}=e;const{t:c}=Object(m.b)(),[s]=Object(d.Ob)(Object($.jsx)($e.a,{linkLabel:c("Get %symbol%",{symbol:t}),tokenPrice:r.toNumber(),apr:i,displayApr:a,linkHref:n,isFarm:!0}));return Object($.jsx)(d.T,{onClick:e=>{e.stopPropagation(),s()},variant:"text",scale:"sm",ml:"4px",children:Object($.jsx)(d.p,{width:"18px"})})};const Ae=Object(j.e)(d.q)`
  align-self: baseline;
`,qe=Object(j.e)(d.M)`
  flex-direction: column;
  justify-content: space-around;
  padding: 24px;
`,Re=j.e.div`
  padding: 24px;
  border-top: 2px solid ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
  overflow: hidden;
`;var Ne=e=>{let{farm:t,displayApr:r,removed:a,cakePrice:n,account:c}=e;const{t:s}=Object(m.b)(),[l,o]=Object(i.useState)(!1),j=t.liquidity&&t.liquidity.gt(0)?`$${t.liquidity.toNumber().toLocaleString(void 0,{maximumFractionDigits:0})}`:"",x=t.lpSymbol&&t.lpSymbol.toUpperCase().replace("",""),p=t.dual?t.dual.earnLabel:s("GLIDE + Fees"),u=z({quoteTokenAddress:t.quoteToken.address,tokenAddress:t.token.address}),h=`${b.a}/${u}`,O=Object(F.a)(t.lpAddresses),g="GLIDE"===t.token.symbol;return Object($.jsxs)(Ae,{isActive:g,children:[Object($.jsxs)(qe,{children:[Object($.jsx)(X,{lpLabel:x,multiplier:t.multiplier,isCommunityFarm:t.isCommunity,token:t.token,quoteToken:t.quoteToken}),!a&&Object($.jsxs)(d.M,{justifyContent:"space-between",alignItems:"center",children:[Object($.jsxs)(d.xb,{children:[s("APR"),":"]}),Object($.jsx)(d.xb,{bold:!0,style:{display:"flex",alignItems:"center"},children:t.apr?Object($.jsxs)($.Fragment,{children:[Object($.jsx)(Le,{lpLabel:x,addLiquidityUrl:h,cakePrice:n,apr:t.apr,displayApr:r}),r,"%"]}):Object($.jsx)(d.rb,{height:24,width:80})})]}),Object($.jsxs)(d.M,{justifyContent:"space-between",children:[Object($.jsxs)(d.xb,{children:[s("Earn"),":"]}),Object($.jsx)(d.xb,{bold:!0,children:p})]}),Object($.jsx)(Te,{farm:t,account:c,addLiquidityUrl:h})]}),Object($.jsxs)(Re,{children:[Object($.jsx)(P,{onClick:()=>o(!l),expanded:l}),l&&Object($.jsx)(G,{removed:a,bscScanAddress:Object(I.e)(O,"address"),totalValueFormatted:j,lpLabel:x,addLiquidityUrl:h})]})]})};var Be=(e,t)=>{const[r,a]=Object(i.useState)(!1);return Object(i.useEffect)(()=>{let i;return e&&!r?a(!0):!e&&r&&(i=setTimeout(()=>a(!1),t)),()=>clearTimeout(i)},[e,t,r]),r};const Me=j.e.div`
  display: flex;
  align-items: center;
  color: ${e=>{let{theme:t}=e;return t.colors.text}};

  button {
    width: 20px;
    height: 20px;

    svg {
      path {
        fill: ${e=>{let{theme:t}=e;return t.colors.textSubtle}};
      }
    }
  }
`,Ie=j.e.div`
  min-width: 60px;
  text-align: left;
`;var Ee=e=>{let{value:t,lpLabel:r,tokenAddress:i,quoteTokenAddress:a,cakePrice:n,originalValue:c,hideButton:s=!1}=e;const l=z({quoteTokenAddress:a,tokenAddress:i}),o=`${b.a}/${l}`;return 0!==c?Object($.jsx)(Me,{children:c?Object($.jsxs)($.Fragment,{children:[Object($.jsxs)(Ie,{children:[t,"%"]}),!s&&Object($.jsx)(Le,{lpLabel:r,cakePrice:n,apr:c,displayApr:t,addLiquidityUrl:o})]}):Object($.jsx)(Ie,{children:Object($.jsx)(d.rb,{width:60})})}):Object($.jsx)(Me,{children:Object($.jsxs)(Ie,{children:[c,"%"]})})};const Pe=j.e.div`
  padding-left: 16px;
  display: flex;
  align-items: center;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding-left: 32px;
  }
`,Fe=j.e.div`
  padding-right: 8px;
  width: 24px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    width: 40px;
  }
`;var ze=e=>{let{token:t,quoteToken:r,label:i,pid:a}=e;const{stakedBalance:n}=Object(u.a)(a),{t:c}=Object(m.b)(),s=Object(O.d)(n);return Object($.jsxs)(Pe,{children:[Object($.jsx)(Fe,{children:Object($.jsx)(W.a,{variant:"inverted",primaryToken:t,secondaryToken:r,width:40,height:40})}),Object($.jsxs)("div",{children:[s?Object($.jsx)(d.xb,{color:"secondary",fontSize:"12px",bold:!0,textTransform:"uppercase",children:c("Farming")}):null,Object($.jsx)(d.xb,{bold:!0,children:i})]})]})};const Ue=j.e.span`
  color: ${e=>{let{earned:t,theme:r}=e;return t?r.colors.text:r.colors.textDisabled}};
  display: flex;
  align-items: center;
`;var Qe=e=>{let{earnings:t,userDataReady:r}=e;return r?Object($.jsx)(Ue,{earned:t,children:t.toLocaleString()}):Object($.jsx)(Ue,{earned:0,children:Object($.jsx)(d.rb,{width:60})})};const Ge=j.e.div`
  display: flex;
  width: 100%;
  justify-content: flex-end;
  padding-right: 8px;
  color: ${e=>{let{theme:t}=e;return t.colors.primary}};

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    padding-right: 0px;
  }
`,Ve=Object(j.e)(d.z)`
  transform: ${e=>{let{toggled:t}=e;return t?"rotate(180deg)":"rotate(0)"}};
  height: 20px;
`;var We=e=>{let{actionPanelToggled:t}=e;const{t:r}=Object(m.b)(),{isXl:i}=Object(d.Nb)(),a=!i;return Object($.jsxs)(Ge,{children:[!a&&r("Details"),Object($.jsx)(Ve,{color:"primary",toggled:t})]})};const _e=j.e.div`
  display: inline-block;
`,He=j.e.div`
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
  width: 36px;
  text-align: right;
  margin-right: 14px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    text-align: left;
    margin-right: 0;
  }
`,Xe=j.e.div`
  display: flex;
  align-items: center;
`;var Ye=e=>{let{multiplier:t}=e;const r=t?t.toLowerCase():Object($.jsx)(d.rb,{width:30}),{t:i}=Object(m.b)(),a=Object($.jsxs)($.Fragment,{children:[i("The multiplier represents the amount of GLIDE rewards each farm gets."),Object($.jsx)("br",{}),Object($.jsx)("br",{}),i("For example, if a 1x farm was getting 1 GLIDE per block, a 5x farm would be getting 5 GLIDE per block.")]}),{targetRef:n,tooltip:c,tooltipVisible:s}=Object(d.Qb)(a,{placement:"top-end",tooltipOffset:[20,10]});return Object($.jsxs)(Xe,{children:[Object($.jsx)(He,{children:r}),Object($.jsx)(_e,{ref:n,children:Object($.jsx)(d.R,{color:"textSubtle"})}),s&&c]})};const Je=j.e.div`
  display: inline-block;
`,Ze=j.e.div`
  min-width: 110px;
  font-weight: 600;
  text-align: right;
  margin-right: 14px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    text-align: left;
    margin-right: 0;
  }
`,Ke=j.e.div`
  display: flex;
  align-items: center;
`;var et=e=>{let{liquidity:t}=e;const r=t&&t.gt(0)?`$${Number(t).toLocaleString(void 0,{maximumFractionDigits:0})}`:Object($.jsx)(d.rb,{width:60}),{t:i}=Object(m.b)(),{targetRef:a,tooltip:n,tooltipVisible:c}=Object(d.Qb)(i("Total value of the funds in this farm\u2019s liquidity pool"),{placement:"top-end",tooltipOffset:[20,10]});return Object($.jsxs)(Ke,{children:[Object($.jsx)(Ze,{children:Object($.jsx)(d.xb,{children:r})}),Object($.jsx)(Je,{ref:a,children:Object($.jsx)(d.R,{color:"textSubtle"})}),c&&n]})};const tt=j.e.div`
  padding: 16px;
  border: 2px solid ${e=>{let{theme:t}=e;return t.colors.primary}};
  border-radius: 16px;
  flex-grow: 1;
  flex-basis: 0;
  margin-bottom: 16px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    margin-left: 12px;
    margin-right: 12px;
    margin-bottom: 0;
    max-height: 100px;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.xl}} {
    margin-left: 48px;
    margin-right: 0;
    margin-bottom: 0;
    max-height: 100px;
  }
`,rt=j.e.div`
  display: flex;
`,it=j.e.div`
  display: flex;
  justify-content: space-between;
  align-items: center;
`;var at=e=>{let{pid:t,userData:r,userDataReady:a}=e;const{toastSuccess:n,toastError:c}=Object(oe.a)(),o=new s.a(r.earnings),b=Object(u.f)();let j=ve.c,x=0,p=a?j.toLocaleString():Object($.jsx)(d.rb,{width:60});o.isZero()||(j=Object(O.c)(o),x=j.multipliedBy(b).toNumber(),p=j.toFixed(3,s.a.ROUND_DOWN));const[h,g]=Object(i.useState)(!1),{onReward:f}=ke(t),{t:y}=Object(m.b)(),v=Object(Y.b)(),{account:k,chainId:w}=Object(l.c)();return Object($.jsxs)(tt,{children:[Object($.jsxs)(rt,{children:[Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"secondary",fontSize:"12px",pr:"4px",children:"GLIDE"}),Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:y("Earned")})]}),Object($.jsxs)(it,{children:[Object($.jsxs)("div",{children:[Object($.jsx)(d.P,{children:p}),x>0&&Object($.jsx)(ee.a,{fontSize:"12px",color:"textSubtle",decimals:2,value:x,unit:" USD",prefix:"~"})]}),Object($.jsx)(d.m,{disabled:j.eq(0)||h||!a||20!==w,onClick:async()=>{g(!0);try{await f(),n(`${y("Harvested")}!`,y("Your %symbol% earnings have been sent to your wallet!",{symbol:"GLIDE"}))}catch(e){c(y("Error"),y("Please try again. Confirm the transaction and make sure you are paying enough gas!")),console.error(e)}finally{g(!1)}v(Object(J.b)({account:k,pids:[t]}))},ml:"4px",children:y("Harvest")})]})]})};const nt=j.e.div`
  display: flex;
`;var ct=e=>{let{pid:t,lpSymbol:r,lpAddresses:a,quoteToken:s,token:o,userDataReady:j}=e;const{t:x}=Object(m.b)(),{account:p,chainId:h}=Object(l.c)(),[g,f]=Object(i.useState)(!1),{allowance:y,tokenBalance:v,stakedBalance:k}=Object(u.a)(t),{onStake:w}=ge(t),{onUnstake:S}=Oe(t),C=Object(n.h)(),D=Object(u.c)(r),T=p&&y&&y.isGreaterThan(0),L=Object(F.a)(a),A=z({quoteTokenAddress:s.address,tokenAddress:o.address}),q=`${b.a}/${A}`,R=Object(i.useCallback)(()=>{const e=Object(O.c)(k);return e.gt(0)&&e.lt(1e-7)?e.toFixed(10,c.BigNumber.ROUND_DOWN):e.gt(0)&&e.lt(1e-4)?Object(O.f)(k).toLocaleString():e.toFixed(6,c.BigNumber.ROUND_DOWN)},[k]),[N]=Object(d.Ob)(Object($.jsx)(pe,{max:v,onConfirm:async e=>{await w(e),I(Object(J.b)({account:p,pids:[t]}))},tokenName:r,addLiquidityUrl:q})),[B]=Object(d.Ob)(Object($.jsx)(he,{max:k,onConfirm:async e=>{await S(e),I(Object(J.b)({account:p,pids:[t]}))},tokenName:r})),M=Object(Z.g)(L),I=Object(Y.b)(),{onApprove:E}=Ce(M),P=Object(i.useCallback)(async()=>{try{f(!0),await E(),I(Object(J.b)({account:p,pids:[t]})),f(!1)}catch(e){console.error(e)}},[E,I,p,t]);return p?T?k.gt(0)?Object($.jsxs)(tt,{children:[Object($.jsxs)(rt,{children:[Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"secondary",fontSize:"12px",pr:"4px",children:r}),Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:x("Staked")})]}),Object($.jsxs)(it,{children:[Object($.jsxs)("div",{children:[Object($.jsx)(d.P,{children:R()}),k.gt(0)&&D.gt(0)&&Object($.jsx)(ee.a,{fontSize:"12px",color:"textSubtle",decimals:2,value:Object(O.d)(D.times(k)),unit:" USD",prefix:"~"})]}),Object($.jsxs)(nt,{children:[Object($.jsx)(d.T,{variant:"secondary",onClick:B,mr:"6px",children:Object($.jsx)(d.db,{color:"primary",width:"14px"})}),Object($.jsx)(d.T,{variant:"secondary",onClick:N,disabled:["history","archived"].some(e=>C.pathname.includes(e)),children:Object($.jsx)(d.a,{color:"primary",width:"14px"})})]})]})]}):Object($.jsxs)(tt,{children:[Object($.jsxs)(rt,{children:[Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",pr:"4px",children:x("Stake").toUpperCase()}),Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"secondary",fontSize:"12px",children:r})]}),Object($.jsx)(it,{children:Object($.jsx)(d.m,{width:"100%",onClick:N,variant:"secondary",disabled:["history","archived"].some(e=>C.pathname.includes(e))||20!==h,children:x("Stake LP")})})]}):j?Object($.jsxs)(tt,{children:[Object($.jsx)(rt,{children:Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:x("Enable Farm")})}),Object($.jsx)(it,{children:Object($.jsx)(d.m,{width:"100%",disabled:g||20!==h,onClick:P,variant:"secondary",children:x("Enable")})})]}):Object($.jsxs)(tt,{children:[Object($.jsx)(rt,{children:Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:x("Start Farming")})}),Object($.jsx)(it,{children:Object($.jsx)(d.rb,{width:180,marginBottom:28,marginTop:14})})]}):Object($.jsxs)(tt,{children:[Object($.jsx)(rt,{children:Object($.jsx)(d.xb,{bold:!0,textTransform:"uppercase",color:"textSubtle",fontSize:"12px",children:x("Start Farming")})}),Object($.jsx)(it,{children:Object($.jsx)(K.a,{width:"100%"})})]})};const st=j.f`
  from {
    max-height: 0px;
  }
  to {
    max-height: 500px;
  }
`,lt=j.f`
  from {
    max-height: 500px;
  }
  to {
    max-height: 0px;
  }
`,dt=j.e.div`
  animation: ${e=>{let{expanded:t}=e;return t?j.d`
          ${st} 300ms linear forwards
        `:j.d`
          ${lt} 300ms linear forwards
        `}};
  overflow: hidden;
  background: ${e=>{let{theme:t}=e;return t.colors.dropdownDeep}};
  display: flex;
  border-radius: 10px;
  width: 100%;
  flex-direction: column-reverse;
  padding: 24px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    flex-direction: row;
    padding: 16px 32px;
  }
`,ot=Object(j.e)(d.X)`
  font-weight: 400;
`,bt=j.e.div`
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
  align-items: center;
  display: flex;
  justify-content: space-between;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    justify-content: flex-start;
  }
`,jt=j.e.div`
  display: flex;
  align-items: center;
  margin-top: 25px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    margin-top: 16px;
  }

  > div {
    height: 24px;
    padding: 0 6px;
    font-size: 14px;
    margin-right: 4px;

    svg {
      width: 14px;
    }
  }
`,xt=j.e.div`
  display: flex;
  flex-direction: column;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    flex-direction: row;
    align-items: center;
    flex-grow: 1;
    flex-basis: 0;
  }
`,pt=j.e.div`
  min-width: 200px;
`,ut=j.e.div`
  display: block;

  ${e=>{let{theme:t}=e;return t.mediaQueries.lg}} {
    display: none;
  }
`,ht=j.e.div`
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin: 4px 0px;
`;var mt=e=>{let{details:t,apr:r,multiplier:i,liquidity:a,userDataReady:n,expanded:c}=e;const s=t,{t:l}=Object(m.b)(),o="0X"!==s.multiplier,{quoteToken:b,token:j,dual:x}=s,p=s.lpSymbol&&s.lpSymbol.toUpperCase().replace("",""),u=z({quoteTokenAddress:b.address,tokenAddress:j.address}),h=Object(F.a)(s.lpAddresses),O=Object(I.e)(h,"address");return Object($.jsxs)(dt,{expanded:c,children:[Object($.jsxs)(pt,{children:[o&&Object($.jsx)(bt,{children:Object($.jsx)(ot,{href:`/add/${u}`,children:l("Get %symbol%",{symbol:p})})}),Object($.jsx)(ot,{href:O,children:l("View Contract")}),Object($.jsxs)(jt,{children:[s.isCommunity?Object($.jsx)(V.a,{}):Object($.jsx)(V.c,{}),x?Object($.jsx)(V.d,{}):null]})]}),Object($.jsxs)(ut,{children:[Object($.jsxs)(ht,{children:[Object($.jsx)(d.xb,{children:l("APR")}),Object($.jsx)(Ee,{...r})]}),Object($.jsxs)(ht,{children:[Object($.jsx)(d.xb,{children:l("Multiplier")}),Object($.jsx)(Ye,{...i})]}),Object($.jsxs)(ht,{children:[Object($.jsx)(d.xb,{children:l("Liquidity")}),Object($.jsx)(et,{...a})]})]}),Object($.jsxs)(xt,{children:[Object($.jsx)(at,{...s,userDataReady:n}),Object($.jsx)(ct,{...s,userDataReady:n})]})]})};const Ot=j.e.div`
  font-size: 12px;
  color: ${e=>{let{theme:t}=e;return t.colors.textSubtle}};
  text-align: left;
`,gt=j.e.div`
  min-height: 24px;
  display: flex;
  align-items: center;
`;var ft=e=>{let{label:t="",children:r}=e;return Object($.jsxs)("div",{children:[t&&Object($.jsx)(Ot,{children:t}),Object($.jsx)(gt,{children:r})]})};const yt=[{id:1,name:"farm",sortable:!0,label:""},{id:2,name:"earned",sortable:!0,label:"Earned"},{id:3,name:"apr",sortable:!0,label:"APR"},{id:6,name:"details",sortable:!0,label:""}],vt=[{id:1,name:"farm",sortable:!0,label:""},{id:2,name:"earned",sortable:!0,label:"Earned"},{id:3,name:"apr",sortable:!0,label:"APR"},{id:4,name:"liquidity",sortable:!0,label:"Liquidity"},{id:5,name:"multiplier",sortable:!0,label:"Multiplier"},{id:6,name:"details",sortable:!0,label:""}];let kt=function(e){return e.TABLE="TABLE",e.CARD="CARD",e}({});const wt={apr:Ee,farm:ze,earned:Qe,details:We,multiplier:Ye,liquidity:et},St=j.e.div`
  padding: 24px 0px;
  display: flex;
  width: 100%;
  align-items: center;
  padding-right: 8px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.xl}} {
    padding-right: 32px;
  }
`,Ct=j.e.tr`
  background: #19274d;
  border-radius: 16px;
  cursor: pointer;
  border-bottom: 2px solid ${e=>{let{theme:t}=e;return t.colors.cardBorder}};
`,Dt=j.e.td`
  padding: 16px 0 24px 16px;
`,Tt=j.e.td`
  padding-top: 16px;
  padding-bottom: 24px;
`,$t=j.e.td`
  padding-top: 24px;
`;var Lt=e=>{const{details:t,userDataReady:r}=e,n=!!Object(u.a)(t.pid).stakedBalance.toNumber(),[c,s]=Object(i.useState)(n),l=Be(c,300),{t:o}=Object(m.b)(),b=()=>{s(!c)};Object(i.useEffect)(()=>{s(n)},[n]);const{isXl:j,isXs:x}=Object(d.Nb)(),p=!j,h=p?yt:vt,O=h.map(e=>e.name);return Object($.jsxs)($.Fragment,{children:[x?Object($.jsxs)(Ct,{onClick:b,children:[Object($.jsxs)("td",{children:[Object($.jsx)("tr",{children:Object($.jsx)($t,{children:Object($.jsx)(ft,{children:Object($.jsx)(ze,{...e.farm})})})}),Object($.jsxs)("tr",{children:[Object($.jsx)(Dt,{children:Object($.jsx)(ft,{label:o("Earned"),children:Object($.jsx)(Qe,{...e.earned,userDataReady:r})})}),Object($.jsx)(Tt,{children:Object($.jsx)(ft,{label:o("APR"),children:Object($.jsx)(Ee,{...e.apr,hideButton:!0})})})]})]}),Object($.jsx)("td",{children:Object($.jsx)(St,{children:Object($.jsx)(ft,{children:Object($.jsx)(We,{actionPanelToggled:c})})})})]}):Object($.jsx)(Ct,{onClick:b,children:Object.keys(e).map(t=>{const i=O.indexOf(t);if(-1===i)return null;switch(t){case"details":return Object($.jsx)("td",{children:Object($.jsx)(St,{children:Object($.jsx)(ft,{children:Object($.jsx)(We,{actionPanelToggled:c})})})},t);case"apr":return Object($.jsx)("td",{children:Object($.jsx)(St,{children:Object($.jsx)(ft,{label:o("APR"),children:Object($.jsx)(Ee,{...e.apr,hideButton:p})})})},t);default:return Object($.jsx)("td",{children:Object($.jsx)(St,{children:Object($.jsx)(ft,{label:o(h[i].label),children:a.a.createElement(wt[t],{...e[t],userDataReady:r})})})},t)}})}),l&&Object($.jsx)("tr",{children:Object($.jsx)("td",{colSpan:6,children:Object($.jsx)(mt,{...e,expanded:c})})})]})};const At=j.e.div`
  filter: ${e=>{let{theme:t}=e;return t.card.dropShadow}};
  width: 100%;
  margin: 16px 0px;
`,qt=j.e.div`
  overflow: visible;

  &::-webkit-scrollbar {
    display: none;
  }
`,Rt=j.e.table`
  border-collapse: separate;
  border-spacing: 0 1em;
  font-size: 14px;
  border-radius: 4px;
  margin-left: auto;
  margin-right: auto;
  width: 100%;
`,Nt=j.e.tbody`
  & tr {
    td {
      font-size: 16px;
      vertical-align: middle;
    }
    td:first-child {
      border-left-style: solid;
      border-top-left-radius: 10px;
      border-bottom-left-radius: 10px;
    }
    td:last-child {
      border-right-style: solid;
      border-bottom-right-radius: 10px;
      border-top-right-radius: 10px;
    }
  }
`,Bt=j.e.div`
  position: relative;
`,Mt=j.e.div`
  display: flex;
  justify-content: center;
  padding-top: 5px;
  padding-bottom: 5px;
`;var It=e=>{const t=Object(i.useRef)(null),{t:r}=Object(m.b)(),{data:a,columns:n,userDataReady:c}=e,{rows:s}=Object(d.Pb)(n,a,{sortable:!0,sortColumn:"farm"});return Object($.jsx)(At,{children:Object($.jsxs)(Bt,{children:[Object($.jsx)(qt,{ref:t,children:Object($.jsx)(Rt,{children:Object($.jsx)(Nt,{children:s.map(e=>Object(i.createElement)(Lt,{...e.original,userDataReady:c,key:`table-row-${e.id}`}))})})}),Object($.jsx)(Mt,{children:Object($.jsxs)(d.m,{variant:"text",onClick:()=>{t.current.scrollIntoView({behavior:"smooth"})},children:[r("To Top"),Object($.jsx)(d.B,{color:"primary"})]})})]})})},Et=r(58);var Pt=e=>{let{hasStakeInFinishedFarms:t}=e;const{url:r}=Object(n.i)(),i=Object(n.h)(),{t:a}=Object(m.b)();let c;switch(i.pathname){case"/farms":default:c=0;break;case"/farms/history":c=1;break;case"/farms/archived":c=2}return Object($.jsx)(Ft,{children:Object($.jsxs)(d.n,{activeIndex:c,scale:"sm",variant:"subtle",children:[Object($.jsx)(d.o,{as:Et.a,to:`${r}`,children:a("Live")}),Object($.jsx)(d.mb,{show:t,children:Object($.jsx)(d.o,{as:Et.a,to:`${r}/history`,children:a("Finished")})})]})})};const Ft=j.e.div`
  display: flex;
  justify-content: center;
  align-items: center;

  a {
    padding-left: 12px;
    padding-right: 12px;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    margin-left: 16px;
  }
`,zt=Object(j.e)(d.q)`
  width: 100%;
  flex: 1;
  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    min-width: 240px;
  }
`;var Ut=e=>{let{currentBlock:t,targetBlock:r}=e;const{t:i}=Object(m.b)(),a=r-t<0?0:r-t,n=a*b.h,c=Math.floor(n/86400),s=Math.floor(n%86400/3600),l=Math.floor(n%3600/60),o=Math.floor(n%60);return Object($.jsx)($.Fragment,{children:Object($.jsx)(zt,{children:Object($.jsxs)(d.r,{children:[Object($.jsx)(d.M,{flexDirection:"column",children:Object($.jsx)(d.M,{alignItems:"center",mb:"12px",children:Object($.jsx)(d.xb,{fontSize:"20px",bold:!0,color:"textSubtle",mr:"4px",children:i("GLIDE Farming Start")})})}),Object($.jsx)(d.M,{alignItems:"center",justifyContent:"space-between",children:Object($.jsx)(d.M,{flexDirection:"column",mr:"12px",children:Object($.jsx)(d.P,{children:t?Object($.jsxs)($.Fragment,{children:[Object($.jsxs)(d.xb,{fontSize:"18px",children:[a," ",i("blocks")]}),Object($.jsxs)(d.xb,{fontSize:"18px",children:[c,"d, ",s,"h, ",l,"m, ",o,"s"]})]}):Object($.jsx)(d.rb,{height:18,width:96,mb:"2px"})})})})]})})})};const Qt=j.e.div`
  display: flex;
  width: 100%;
  align-items: center;
  position: relative;

  justify-content: space-between;
  flex-direction: column;
  margin-bottom: 32px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    flex-direction: row;
    flex-wrap: wrap;
    padding: 16px 32px;
    margin-bottom: 0;
  }
`,Gt=j.e.div`
  display: flex;
  align-items: center;
  margin-left: 10px;

  ${d.xb} {
    margin-left: 8px;
  }
`,Vt=j.e.div`
  > ${d.xb} {
    font-size: 12px;
  }
`,Wt=j.e.div`
  display: flex;
  align-items: center;
  width: 100%;
  padding: 8px 0px;

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    width: auto;
    padding: 0;
  }
`,_t=j.e.div`
  flex-wrap: wrap;
  justify-content: space-between;
  display: flex;
  align-items: center;
  width: 100%;

  > div {
    padding: 8px 0px;
  }

  ${e=>{let{theme:t}=e;return t.mediaQueries.sm}} {
    justify-content: flex-start;
    width: auto;

    > div {
      padding: 0;
    }
  }
`,Ht=Object(j.e)(d.M)`
  margin-bottom: 15px;
`,Xt=(e,t)=>e&&t?(e+t).toLocaleString("en-US",{maximumFractionDigits:2}):e?e.toLocaleString("en-US",{maximumFractionDigits:2}):null;var Yt=()=>{const{path:e}=Object(n.i)(),{pathname:t}=Object(n.h)(),{t:r}=Object(m.b)(),{data:a,userDataLoaded:c}=Object(u.b)(),j=Object(u.f)(),[k,D]=Object(i.useState)(""),[T]=Object(h.a)(kt.TABLE,{localStorageKey:"glide_farm_view"}),{account:L,chainId:A,library:q}=Object(l.c)(),[I,E]=Object(i.useState)("hot"),P=Object(i.useRef)(0),F=t.includes("archived"),z=t.includes("history"),U=!z&&!F,{currentBlock:Q}=Object(M.a)();Object(u.d)(F);const G=!L||!!L&&c,[V,W]=Object(S.i)(U),_=a.filter(e=>0!==e.pid&&"0X"!==e.multiplier&&!Object(v.a)(e.pid)),H=a.filter(e=>0!==e.pid&&"0X"===e.multiplier&&!Object(v.a)(e.pid)),X=a.filter(e=>Object(v.a)(e.pid)),Y=_.filter(e=>e.userData&&new s.a(e.userData.stakedBalance).isGreaterThan(0)),J=H.filter(e=>e.userData&&new s.a(e.userData.stakedBalance).isGreaterThan(0)),Z=X.filter(e=>e.userData&&new s.a(e.userData.stakedBalance).isGreaterThan(0)),K=Object(i.useCallback)(e=>{let t=e.map(e=>{if(!e.lpTotalInQuoteToken||!e.quoteToken.usdcPrice)return e;const t=new s.a(e.lpTotalInQuoteToken).times(e.quoteToken.usdcPrice),{glideRewardsApr:r,lpRewardsApr:i}=U?Object(g.a)(new s.a(e.poolWeight),j,t,e.lpAddresses[o.a.MAINNET],Q):{glideRewardsApr:0,lpRewardsApr:0};return{...e,apr:r,lpRewardsApr:i,liquidity:t}});if(k){const e=w(k.toLowerCase());t=t.filter(t=>w(t.lpSymbol.toLowerCase()).includes(e))}return t},[j,k,U,Q]),ee=Object(i.useRef)(null),[te,re]=Object(i.useState)(12),[ie,ae]=Object(i.useState)(!1),ne=Object(i.useMemo)(()=>{let e=[];return U&&(e=K(V?Y:_)),z&&(e=K(V?J:H)),F&&(e=K(V?Z:X)),(e=>{switch(I){case"apr":return Object(y.orderBy)(e,e=>e.apr+e.lpRewardsApr,"desc");case"multiplier":return Object(y.orderBy)(e,e=>e.multiplier?Number(e.multiplier.slice(0,-1)):0,"desc");case"earned":return Object(y.orderBy)(e,e=>e.userData?Number(e.userData.earnings):0,"desc");case"liquidity":return Object(y.orderBy)(e,e=>Number(e.liquidity),"desc");default:return e}})(e).slice(0,te)},[I,_,K,H,X,U,z,F,Z,J,V,Y,te]);P.current=ne.length,Object(i.useEffect)(()=>{if(!ie){new IntersectionObserver(e=>{const[t]=e;t.isIntersecting&&re(e=>e<=P.current?e+12:e)},{rootMargin:"0px",threshold:1}).observe(ee.current),ae(!0)}},[ne,ie]);const ce=ne.map(e=>{const{token:t,quoteToken:r}=e,i=t.address,a=r.address,n=e.lpSymbol&&e.lpSymbol.split(" ")[0].toUpperCase().replace("","");return{apr:{value:Xt(e.apr,e.lpRewardsApr),multiplier:e.multiplier,lpLabel:n,tokenAddress:i,quoteTokenAddress:a,cakePrice:j,originalValue:e.apr},farm:{label:n,pid:e.pid,token:e.token,quoteToken:e.quoteToken},earned:{earnings:Object(O.d)(new s.a(e.userData.earnings)),pid:e.pid},liquidity:{liquidity:e.liquidity},multiplier:{multiplier:e.multiplier},details:e}});return Object($.jsx)($.Fragment,{children:Object($.jsxs)(p.a,{children:[Object($.jsx)(C.a,{children:Object($.jsxs)(d.M,{justifyContent:"space-between",flexDirection:["column",null,null,"row"],children:[Object($.jsxs)(d.M,{flex:"1",flexDirection:"column",mr:["8px",0],children:[Object($.jsx)(d.N,{as:"h1",scale:"xxl",color:"glide",mb:"24px",children:r("Farms")}),Object($.jsx)(d.P,{scale:"lg",color:"text",children:r("Deposit LP tokens to earn")})]}),20===A&&Number(b.l.toString())-Q+3e4>0&&Object($.jsx)(d.M,{flex:"1",height:"fit-content",justifyContent:"center",alignItems:"center",mt:["24px",null,"0"],children:Object($.jsx)(Ut,{currentBlock:Q,targetBlock:Number(b.l.toString())})})]})}),Object($.jsxs)(Qt,{children:[Object($.jsxs)(_t,{children:[Object($.jsxs)(Gt,{children:[Object($.jsx)(d.Ab,{checked:V,onChange:()=>W(!V),scale:"sm"}),Object($.jsxs)(d.xb,{children:[" ",r("Staked only")]})]}),Object($.jsx)(Pt,{hasStakeInFinishedFarms:J.length>0})]}),Object($.jsxs)(Wt,{children:[Object($.jsxs)(Vt,{children:[Object($.jsx)(d.xb,{textTransform:"uppercase",children:r("Sort by")}),Object($.jsx)(N.a,{options:[{label:r("Hot"),value:"hot"},{label:r("APR"),value:"apr"},{label:r("Multiplier"),value:"multiplier"},{label:r("Earned"),value:"earned"},{label:r("Liquidity"),value:"liquidity"}],onChange:e=>{E(e.value)}})]}),Object($.jsxs)(Vt,{style:{marginLeft:16},children:[Object($.jsx)(d.xb,{textTransform:"uppercase",children:r("Search")}),Object($.jsx)(R,{onChange:e=>{D(e.target.value)},placeholder:r("Search Farms")})]})]})]}),20!==A&&Object($.jsx)(Ht,{justifyContent:"center",children:Object($.jsx)(d.m,{onClick:()=>{Object(f.b)(20,q)},children:r("Switch to the Elastos network to begin")})}),(()=>{if(T===kt.TABLE&&ce.length){const e=vt.map(e=>({id:e.id,name:e.name,label:e.label,sort:(t,r)=>{switch(e.name){case"farm":return r.id-t.id;case"apr":return t.original.apr.value&&r.original.apr.value?Number(t.original.apr.value)-Number(r.original.apr.value):0;case"earned":return t.original.earned.earnings-r.original.earned.earnings;default:return 1}},sortable:e.sortable}));return Object($.jsx)(It,{data:ce,columns:e,userDataReady:G})}return Object($.jsxs)(x.a,{children:[Object($.jsx)(n.b,{exact:!0,path:`${e}`,children:ne.map(e=>Object($.jsx)(Ne,{farm:e,displayApr:Xt(e.apr,e.lpRewardsApr),cakePrice:j,account:L,removed:!1},e.pid))}),Object($.jsx)(n.b,{exact:!0,path:`${e}/history`,children:ne.map(e=>Object($.jsx)(Ne,{farm:e,displayApr:Xt(e.apr,e.lpRewardsApr),cakePrice:j,account:L,removed:!0},e.pid))}),Object($.jsx)(n.b,{exact:!0,path:`${e}/archived`,children:ne.map(e=>Object($.jsx)(Ne,{farm:e,displayApr:Xt(e.apr,e.lpRewardsApr),cakePrice:j,account:L,removed:!0},e.pid))})]})})(),L&&!c&&V&&Object($.jsx)(d.M,{justifyContent:"center",children:Object($.jsx)(B.a,{})}),Object($.jsx)("div",{ref:ee})]})})}}}]);
//# sourceMappingURL=12.92c4168d.chunk.js.map
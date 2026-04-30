(this["webpackJsonpglide-frontend"]=this["webpackJsonpglide-frontend"]||[]).push([[9],{1247:function(e,t,c){"use strict";c.r(t),c.d(t,"default",function(){return N});var n=c(1),i=c(5),r=c(2),o=c(3),l=c(7),j=c(103),d=c(29),s=c(43),a=c(353),b=c(20),x=c(425),O=c(122),u=c(11),h=c(50),p=c(93),g=c(883),f=c(150),y=c(208),m=c(179),v=c(231),T=c(0),I=function(e){return e[e.TOKEN0=0]="TOKEN0",e[e.TOKEN1=1]="TOKEN1",e}(I||{});const E=Object(o.e)(r.m)`
  background: linear-gradient(250deg, #17264f 0%, hsl(220, 51%, 23%) 100%);
  color: ${e=>{let{theme:t}=e;return t.colors.text}};
  box-shadow: none;
  border-radius: 16px;
`;function N(){var e;const{account:t}=Object(u.a)(),{t:c}=Object(l.b)(),[o,N]=Object(n.useState)(I.TOKEN1),[S,k]=Object(n.useState)(i.d),[A,C]=Object(n.useState)(null),[w,K]=Object(O.b)(null!==S&&void 0!==S?S:void 0,null!==A&&void 0!==A?A:void 0),q=Object(h.e)();Object(n.useEffect)(()=>{K&&q(K)},[K,q]);const B=w===O.a.NOT_EXISTS||Boolean(w===O.a.EXISTS&&K&&i.e.equal(K.reserve0.raw,i.e.BigInt(0))&&i.e.equal(K.reserve1.raw,i.e.BigInt(0))),$=Object(p.d)(null!==t&&void 0!==t?t:void 0,null===K||void 0===K?void 0:K.liquidityToken),L=Boolean($&&i.e.greaterThan($.raw,i.e.BigInt(0))),X=Object(n.useCallback)(e=>{o===I.TOKEN0?k(e):C(e)},[o]),z=Object(T.jsx)(j.b,{padding:"45px 10px",children:Object(T.jsx)(r.xb,{textAlign:"center",children:c(t?"Select a token to find your liquidity.":"Connect to a wallet to find pools")})}),[D]=Object(r.Ob)(Object(T.jsx)(x.a,{onCurrencySelect:X,showCommonBases:!0,selectedCurrency:null!==(e=o===I.TOKEN0?A:S)&&void 0!==e?e:void 0}),!0,!0,"selectCurrencyModal");return Object(T.jsx)(v.a,{children:Object(T.jsxs)(m.a,{children:[Object(T.jsx)(m.b,{title:c("Import Pool"),subtitle:c("Import an existing pool"),backTo:"/pool"}),Object(T.jsxs)(d.a,{style:{padding:"1rem"},gap:"md",children:[Object(T.jsx)(E,{endIcon:Object(T.jsx)(r.z,{}),onClick:()=>{D(),N(I.TOKEN0)},children:S?Object(T.jsxs)(b.d,{children:[Object(T.jsx)(s.a,{currency:S}),Object(T.jsx)(r.xb,{ml:"8px",children:S.symbol})]}):Object(T.jsx)(r.xb,{ml:"8px",children:c("Select a Token")})}),Object(T.jsx)(d.b,{children:Object(T.jsx)(r.a,{})}),Object(T.jsx)(E,{endIcon:Object(T.jsx)(r.z,{}),onClick:()=>{D(),N(I.TOKEN1)},children:A?Object(T.jsxs)(b.d,{children:[Object(T.jsx)(s.a,{currency:A}),Object(T.jsx)(r.xb,{ml:"8px",children:A.symbol})]}):Object(T.jsx)(r.xb,{as:b.d,children:c("Select a Token")})}),L&&Object(T.jsxs)(d.b,{style:{justifyItems:"center",backgroundColor:"",padding:"12px 0px",borderRadius:"12px"},children:[Object(T.jsx)(r.xb,{textAlign:"center",children:c("Pool Found!")}),Object(T.jsx)(g.a,{to:"/pool",children:Object(T.jsx)(r.xb,{textAlign:"center",children:c("Manage this pool.")})})]}),S&&A?w===O.a.EXISTS?L&&K?Object(T.jsx)(a.a,{pair:K}):Object(T.jsx)(j.b,{padding:"45px 10px",children:Object(T.jsxs)(d.a,{gap:"sm",justify:"center",children:[Object(T.jsx)(r.xb,{textAlign:"center",children:c("You don\u2019t have liquidity in this pool yet.")}),Object(T.jsx)(g.a,{to:`/add/${Object(f.a)(S)}/${Object(f.a)(A)}`,children:Object(T.jsx)(r.xb,{textAlign:"center",children:c("Add Liquidity")})})]})}):B?Object(T.jsx)(j.b,{padding:"45px 10px",children:Object(T.jsxs)(d.a,{gap:"sm",justify:"center",children:[Object(T.jsx)(r.xb,{textAlign:"center",children:c("No pool found.")}),Object(T.jsx)(g.a,{to:`/add/${Object(f.a)(S)}/${Object(f.a)(A)}`,children:c("Create pool.")})]})}):w===O.a.INVALID?Object(T.jsx)(j.b,{padding:"45px 10px",children:Object(T.jsx)(d.a,{gap:"sm",justify:"center",children:Object(T.jsx)(r.xb,{textAlign:"center",fontWeight:500,children:c("Invalid pair.")})})}):w===O.a.LOADING?Object(T.jsx)(j.b,{padding:"45px 10px",children:Object(T.jsx)(d.a,{gap:"sm",justify:"center",children:Object(T.jsxs)(r.xb,{textAlign:"center",children:[c("Loading"),Object(T.jsx)(y.a,{})]})})}):null:z]})]})})}},883:function(e,t,c){"use strict";var n=c(58),i=c(3);const r=Object(i.e)(n.a)`
  text-decoration: none;
  cursor: pointer;
  color: ${e=>{let{theme:t}=e;return t.colors.primary}};
  font-weight: 500;

  :hover {
    text-decoration: underline;
  }

  :focus {
    outline: none;
    text-decoration: underline;
  }

  :active {
    text-decoration: none;
  }
`;t.a=r}}]);
//# sourceMappingURL=9.94e919c5.chunk.js.map
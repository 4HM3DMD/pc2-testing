# AI Chat icon assets

The AI Chat experience is a native PC2 GUI window (see
`src/gui/src/UI/UIWindowAIChat.js`), not an iframe-served webapp,
so this folder contains only icon assets — no `index.html`.

`favicon-192.png` is the source for the base64-embedded icon
returned by `loadIconAsBase64('ai-chat')` in
`pc2-node/src/api/info.ts`. To regenerate after replacing the
master image, run the same `magick` resize chain used for the DAO
icon and re-embed via the Node script in that file.

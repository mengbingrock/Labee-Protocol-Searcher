# Vendored residential-proxy agent

These four files are ported verbatim from the browserless repository
(`src/residential-proxy/`), with only one change: import specifiers use `.ts`
rather than `.js`, because this package runs from source under
`--experimental-strip-types` and bundles with tsdown.

They are kept byte-similar to upstream on purpose, so a future upstream change
can be diffed and re-applied rather than reverse-engineered. That is also why
their formatting (single quotes) differs from the rest of this codebase — do
not reformat them. New code that *uses* them belongs in `../residential.ts`,
written in this repo's own style.

Upstream depends on nothing but `ws` and Node builtins, which is what makes it
viable as a thin layer on a user's PC.

| File | Role |
| --- | --- |
| `protocol.ts` | Wire types and framing constants shared with the server |
| `secure-channel.ts` | X25519 + ChaCha20-Poly1305 handshake and frame sealing |
| `control-proxy.ts` | Optional SOCKS5/CONNECT dialer for the control channel only |
| `agent.ts` | The agent itself: registration, tunnel open/close, allowlists |

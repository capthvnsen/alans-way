# Cloud/local continuity: target and acceptance gates

The intended product has one cloud-primary assistant. Phone and Mac Desktop are interfaces to that same authoritative conversation. The Mac can be offline while cloud work continues. Returning to Desktop shows the phone exchange and current task progress without copying memory or changing brains.

**This alpha does not implement that complete lifecycle.** Native Hermes already supplies much of the surface; companion coordination must be proven against one authenticated runtime before it can bridge entry points.

## Hard constraints

1. One authoritative transcript and state writer; no live SQLite synchronization.
2. Desktop and mobile connection identity must bind to the reviewed owner/profile/session. A profile name supplied by a client is not attestation.
3. Messaging adapters are replaceable. Immutable principal/chat/thread bindings stay with each request and reply; changing platforms cannot retarget pending replies.
4. Cloud work survives Mac unavailability. Mac-specific work waits explicitly or fails visibly; it never executes on the VPS as a fallback.
5. Sensitive actions require a real, request-bound approval path. Missing approval transport means the action is unsupported.
6. Use public Hermes APIs/configuration and MCP only. Missing core contracts are upstream requirements, not permission for private patches.
7. An API accepting a message is not proof that it was delivered or read. Uncertain prompts or replies are not automatically resubmitted.

## Promotion gates

- [ ] Authenticate Desktop and a second client to the **same existing cloud process**, not two independently launched processes reading one database.
- [ ] Verify exact profile/session identity before and after attachment.
- [ ] Exercise simultaneous subscribers, Desktop disconnect, and ongoing cloud execution.
- [ ] Replay nonempty events and open requests without dropping or answering the wrong request.
- [ ] Route approval/clarification requests to the authorized surface; verify no withdrawal caused by a passive client.
- [ ] Demonstrate phone input and reply in the canonical transcript, then Desktop continuation with no handoff to a different writer.
- [ ] Test VPS process restart, uncertain prompt acceptance, and recovery with no silent retries or duplicate provider turns.
- [ ] Physically disconnect the Mac, complete cloud work, fail a Mac call visibly, reconnect and confirm subsequent calls return to the reviewed Mac.
- [ ] Confirm both source installations remain stock and pass checks after upgrades.

Passing unit tests, an isolated protocol fixture or a raw MCP exchange is not a substitute for these gates. Do not call this alpha a complete replacement for a hosted assistant.

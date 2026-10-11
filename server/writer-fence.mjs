import { ABUSE_RATE_TABLES } from "./abuse-rate-buckets.mjs";
import { OAUTH_PROVIDER_TABLES } from "./oauth-provider-store.mjs";

// Upgrade compatibility fence, not authentication against a database administrator.
// Older service connections do not register this function, so ordinary writes fail
// after the schema transaction commits, even if the connection predates migration.
export const STORE_SCHEMA_VERSION = 38;
export const WRITER_FUNCTION = `project_room_writer_v${STORE_SCHEMA_VERSION}`;
export const writerVersions = Object.freeze([6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38]);
const v6Tables = ["rooms", "events", "commands", "accounts", "member_accounts", "account_access_events",
  "credentials", "cursors", "projection_checkpoints", "account_credentials", "account_session_slots",
  "membership_invitations", "membership_invitation_events", "membership_invitation_journal"];
const v7Tables = [...v6Tables, "share_links", "share_link_joins"];
const v8Tables = [...v7Tables, "private_reminders", "private_reminder_commands"];
const v14Tables = [...v8Tables, "agent_connections", "agent_connection_operations"];
const v17Tables = [...v14Tables, "private_inbox_sources", "private_inbox_versions", "private_inbox_drafts", "private_inbox_commands"];
const tables = [...v17Tables, "private_email_connections", "private_email_folders", "private_email_commands"];
const v27Tables = [...tables, "agent_identities", "identity_links"];
// Two lineages previously reused v28: rebuilt main added rooms.archived_at,
// while the deployed lineage fenced agent_invite_codes + room_attachments and
// later advanced to v33. v34 converges them without rewriting either history.
const deployedV28Tables = [...v27Tables, "agent_invite_codes", "room_attachments"];
const rebuiltAdditiveTables = ["agent_invite_codes", "wake_queue", "wake_queue_commands", "private_attention_prefs", "private_attention_commands", "pending_channel_updates", "wake_queue_pause", "message_reports"];
// private_inbox_reads (per-source read markers) is purely additive at v34 and
// intentionally NOT fenced: verifyWriterFence rejects triggers it does not know,
// so fencing it would break same-schema packaged fallbacks that predate the
// table ("Database writer fence requires operator reconciliation" on rollback).
// This restores the pre-v34 additive pattern (application table, outside the
// fence): older writers have no code path to the table, and Inbox.verify()
// replays the read/unread journal against actual rows as the integrity gate.
export const unfencedAdditiveTables = Object.freeze([
  "public_work_tasks", "public_work_requests", "public_work_receipts", "public_work_claim_writer_permit", // Public namespaces use a separate transaction permit; v36 private claims remain compatible.
  "agent_invite_redeem_receipts", // G1 idempotent redeem (PRODUCT-200 D7): purely additive retry-receipt journal; older writers have no code path to it.
  "public_work_reviews", "public_work_review_requests", // Private review projections/journals never alter existing claims, receipts or awards.
  "public_work_successors", "public_work_successor_requests", // Additive follow-up lineage and replay journal; older writers never mutate these tables.
  "project_offers", "project_offer_requests", // Owner-authored public terms, additive; older writers have no routes.
  "room_assistant_config", "room_assistant_runs", "room_assistant_ops",
  "room_trial_tasks", "room_trial_requests", "room_vetting_keys", "room_vetting_receipts", "demigod_offer_profiles", "demigod_offer_requests", "demigod_contracts", "demigod_contract_requests", "buyer_signoff_loops", "buyer_signoff_requests", // Additive private record-only rails; older writers have no routes.
  "request_runs", // Permanent host reservations; older writers have no execution route.
  "private_inbox_reads",
  "access_requests",
  // room_access_auto_approve (standing auto-approve rule, RC-2026-09-29-3603):
  // purely additive and intentionally NOT fenced — older writers have no code
  // path to it, and the manage_members-only config rule plus the
  // never-admin config validation are the integrity gate.
  "room_access_auto_approve",
  // membership_delegation_grants (owner-granted membership administration
  // for agent identities, RC-2026-09-18-038): purely additive and
  // intentionally NOT fenced — older writers have no code path to it, and
  // the grant journal's grant→revoke transitions plus the owner-only grant
  // rule are the integrity gate.
  "membership_delegation_grants",
  "membership_delegation_journal",
  "membership_delegation_pending",
  // owner_delegate_grants + owner_delegate_journal (owner-granted
  // owner-delegation for agent identities, server/owner-delegates.mjs):
  // purely additive and intentionally NOT fenced — older writers have no
  // code path to them, and the owner-only grant rule is the integrity gate.
  "owner_delegate_grants",
  "owner_delegate_journal",
  // account_login_methods + account_passkey_credentials + account_magic_codes
  // + account_recovery_codes (multi-method login, slice 1): purely additive,
  // outside the fence like access_requests — older writers have no code path
  // to them and method rows are always scoped to an existing account.
  "account_login_methods",
  "account_passkey_credentials",
  "account_magic_codes",
  "account_recovery_codes",
  // account_security_events (verified-email audit): additive and unfenced.
  // Older writers have no code path to it. Rows name an account and an event type.
  "account_security_events",
  // agent_room_ownership (agent room creation provenance) is purely additive
  // at v34 and intentionally NOT fenced: same rationale as
  // private_inbox_reads above — older writers have no code path to it, and
  // the projection's ownerId plus the event log are the integrity gate.
  "agent_room_ownership",
  // direct_channel_sends (direct gmail/telegram send journal) is purely
  // additive and intentionally NOT fenced: same rationale — older writers
  // have no code path to it, and the journal's pending→sent|failed
  // transitions are the integrity gate.
  "direct_channel_sends",
  // inbox_handoffs (agent handoff protocol, task 23) is purely additive and
  // intentionally NOT fenced: same rationale — older writers have no code
  // path to it, and the journal's open→accepted→completed|released
  // transitions plus the one-open-handoff-per-thread rule are the gate.
  "inbox_handoffs",
  // private_next_action_dismissals + private_next_action_suppressions
  // (RC-2026-09-25-911, ranked next-actions) are purely additive and
  // intentionally NOT fenced: same rationale as private_attention_prefs —
  // older writers have no code path to them, and the rows are always scoped
  // to an existing (room_id, member_id).
  "private_next_action_dismissals",
  "private_next_action_suppressions",
  // private_update_marks + private_update_commands (Updates projection):
  // per-member read/done/clear marks. Purely additive and intentionally NOT
  // fenced — older writers have no code path to them, and every row is scoped
  // to an existing room member. A new source revision stops matching the mark.
  "private_update_marks",
  "private_update_commands",
  // inbox_handoff_rooms records which room a collab-route handoff was made in,
  // so an agent acting under the owner's account is held to that room. Purely
  // additive beside inbox_handoffs, with no path from any older writer.
  "inbox_handoff_rooms",
  // handoff_envelopes (typed handoff envelopes, RC-2026-09-19-062) is purely
  // additive and intentionally NOT fenced: same rationale — older writers
  // have no code path to it, and the journal's
  // proposed→accepted→completed|rejected|expired|escalated|cancelled
  // transitions plus the recipient/sender actor rules are the gate.
  "handoff_envelopes",
  // Lane C inbox collaboration (task RC-2026-09-18-011): collab_assignments,
  // collab_notes, collab_draft_locks, collab_approvals, collab_routing_events.
  // Purely additive and intentionally NOT fenced: older writers have no code
  // path to them, and each journal verifies its own op log on replay.
  // Sequenced after the Lane D agent_* entries (RC-2026-09-18-010), preserving
  // their order.
  "agent_api_keys",
  "agent_directory_cards",
  "agent_webhook_subs",
  // RC-2026-09-19-064: agent_webhook_deliveries (durable per-delivery
  // journal for signed dispatch). Purely additive and intentionally NOT
  // fenced: older writers have no code path to it, and the idempotency_key
  // uniqueness plus the pending->delivered|failed->dead_letter transitions
  // are the integrity gate.
  "agent_webhook_deliveries",
  // Escrowed bounties (agent work exchange, slice 1): bounty_journal,
  // bounty_records, bounty_disputes, bounty_events, bounty_idempotency,
  // bounty_watchers, bounty_sequences. Slice 6 adds bounty_rubric_versions
  // (pinned rubric history); slice 8 adds bounty_flakes; slice 10 adds
  // bounty_sybil_flags (correlated-cluster flags).
  // Purely additive and intentionally NOT fenced: older writers have no code
  // path to them, and the append-only hash-chained journal plus the
  // conservation verifier are the integrity gate.
  "bounty_journal",
  "bounty_records",
  "bounty_disputes",
  "bounty_events",
  "bounty_idempotency",
  "bounty_watchers",
  "bounty_sequences",
  "bounty_rubric_versions",
  "bounty_flakes",
  "bounty_review_packets",
  "bounty_sybil_flags",
  // Slice 4 (reputation): bounty_reputation_packets (probation-gate review
  // packets). Purely additive and intentionally NOT fenced: older writers
  // have no code path to it, and the packet journal verifies its own schema
  // on open; rows never drive bans, slashes, or balances.
  "bounty_reputation_packets",
  // RC-2026-09-18-049: agent_identity_verification (owner attestations) and
  // room_verification_policy (per-room gate). Purely additive and
  // intentionally NOT fenced: older writers have no code path to them, and
  // each store verifies its own schema on open.
  "agent_identity_verification",
  "room_verification_policy",
  // Wakeable agent presence (RC-2026-09-18-051): agent_hosts and
  // agent_wake_signals. Purely additive and intentionally NOT fenced:
  // older writers have no code path to them, every row is scoped to an
  // agent identity, and AgentHeartbeats.verifySchema() is read-only-safe.
  "agent_hosts",
  "agent_wake_signals",
  // Opt-in work delivery: additive pointer journal and host preferences,
  // verified by WorkWakes on open; never execution or permission records.
  "agent_work_wake_hosts",
  "agent_work_wakes",
  // Push wake path (RC-2026-09-24-203): agent_push_configs. Same rationale
  // as agent_hosts — purely additive, per-identity rows, self-verified
  // schema on open; rows never drive bans, slashes, or balances.
  "agent_push_configs",
  // plan-wake-live: agent_wake_polls (per-agent last-polled-at). Purely
  // additive: one row per agent identity, written only on poll/heartbeat
  // activity, read by the wakeable / not-wakeable lists; older writers have
  // no code path to it and AgentHeartbeats.verifySchema() is read-only-safe.
  "agent_wake_polls",
  "collab_assignments",
  "collab_notes",
  "collab_draft_locks",
  "collab_approvals",
  "collab_routing_events",
  // spam_quarantine (spam-guard quarantine journal) is purely additive and
  // intentionally NOT fenced: same rationale — older writers have no code
  // path to it, and the journal's held→released|dismissed transitions plus
  // the reviews-are-final rule are the gate.
  "spam_quarantine",
// quarantine_thread_splits (quarantine review "split" action) is purely
  // additive and intentionally NOT fenced: older writers have no code path to
  // it, and the journal verifies its own schema on open.
  "quarantine_thread_splits",
// sla_breach_alerts (SLA-breach alert journal, task 26) is purely additive
  // and intentionally NOT fenced: same rationale — older writers have no code
  // path to it, and the journal's immutable receipts plus the per-produced-
  // record idempotency key are the gate.
  "sla_breach_alerts",
  // oauth_pending_states (OAuth PKCE pending states for Google/GitHub
  // sign-in) is purely additive and intentionally NOT fenced: older writers
  // have no code path to it, rows are short-lived (10min TTL, pruned on
  // write), and single-use consumption is the integrity gate.
  "oauth_pending_states",
  "gmail_mailboxes", "gmail_linked_mailboxes", "gmail_pending", "gmail_operations", "account_setup",
  // Cross-channel thread stitching (task #19): stitch_identities,
  // stitch_links, stitch_revocations, stitch_suggestions, stitch_receipts.
  // Hash-only, purely additive, intentionally NOT fenced — older writers
  // have no code path to them, and the stitch store verifies its own schema.
  "stitch_identities",
  "stitch_links",
  "stitch_revocations",
  "stitch_suggestions",
  "stitch_receipts",
  // share_link_codes: short human invite aliases of existing #join/ share-links.
  // Purely additive and intentionally NOT fenced — older writers have no code
  // path to them, and share_links.verify() plus hash-only storage are the gate.
  "share_link_codes",
  // share_link_join_redemptions: per-(link, redemptionId) idempotency for the
  // membership-reuse join path, which writes no share_link_joins row (the
  // #770 lost-cookie gap). Purely additive and intentionally NOT fenced —
  // older writers have no code path to it; the immutable triggers are the gate.
  "share_link_join_redemptions",
  // dm_consents (directional DM-consent journal) + room_public_settings
  // (opt-in public read-only face settings) are purely additive and intentionally
  // NOT fenced: older writers have no code path to them, and each module
  // verifies its own schema on open.
  "dm_consents",
  // agent_bonds + peer_dm_threads + peer_dm_messages (mutual agent bond and
  // the peer DM channel it gates). Purely additive and intentionally NOT
  // fenced: older writers have no code path to them. The bond state machine
  // and participant-only reads are the integrity gate; room events are receipts.
  "agent_bonds",
  "peer_dm_threads",
  "peer_dm_messages",
  "room_public_settings",
  // room_directory_settings (#605 opt-in public room directory) is purely
  // additive and intentionally NOT fenced, same as room_public_settings.
  "room_directory_settings",
  // mention_states + room_mention_settings (#658 mention lifecycle) are
  // purely additive and intentionally NOT fenced: older writers have no code
  // path to them, and the lifecycle module owns its schema.
  "mention_states",
  "room_mention_settings",
  // agent_key_registry (integration map slice 9): Ed25519 public-key
  // directory with validity windows and rotation overlap. Purely additive
  // and intentionally NOT fenced — older writers have no code path to it,
  // every row is scoped to an agent identity, and the table is append-only.
  "agent_key_registry",
  // guest_invites + guest_members (GX guest-invite public handoff,
  // RC-2026-09-23-100): hash-only invite rows and per-room guest membership
  // seats. Purely additive and intentionally NOT fenced — older writers have
  // no code path to them, and the module verifies its own schema on open.
  "guest_invites",
  "guest_members",
  // guest_selfserve + guest_selfserve_idem (self-serve guest entry,
  // RC-2026-09-25-912): per-room self-serve seat LRU bookkeeping and
  // request-ID idempotency records. Purely additive and intentionally NOT
  // fenced — older writers have no code path to them, and the module
  // verifies its own schema on open.
  "guest_selfserve",
  "guest_selfserve_idem",
  // guest_link_exchanges (GA-2, issue #941): single-use ga1. link
  // redemption records. Purely additive and intentionally NOT fenced —
  // older writers have no code path to it, and the redemption is recorded
  // in the same transaction as the credential exchange.
  "guest_link_exchanges",
  // activity_events + read_horizons + saved_messages
  // (attention: activity feed, mark unread, save for later) are purely
  // additive and intentionally NOT fenced: older writers have no code path
  // to them, and the activity module owns its schema.
  "activity_events",
  "read_horizons",
  "saved_messages",
  // web_fetch_cache + web_fetch_log (room-side web fetch, RC-2026-09-23-102):
  // page cache and the per-request fetch journal (no page content journaled).
  // Purely additive and intentionally NOT fenced — older writers have no
  // code path to them, and the module verifies its own schema on open.
  "web_fetch_cache",
  "web_fetch_log",
  // web_fetch_cache_rooms (room-scoped fetch visibility, RC-2026-09-24-310
  // follow-up): which rooms fetched each cached URL. Purely additive and
  // intentionally NOT fenced — older writers have no code path to it, and the
  // module verifies its own schema on open.
  "web_fetch_cache_rooms",
  // web_research_log (knowledge router, RC-2026-09-24-310): per-request
  // research journal (question hash, never the question). Purely additive and
  // intentionally NOT fenced — older writers have no code path to it, and the
  // module verifies its own schema on open.
  "web_research_log",
  // thread_mutes (per-thread mutes): one row per (room, member, thread
  // root). Purely additive and intentionally NOT fenced — older writers have
  // no code path to it, and muting is a private read-time filter, never a
  // room-visible state change. DDL is shared with server/thread-mutes.mjs
  // (convergent).
  "thread_mutes",
  // referrals (referral attribution): one row per joined referee, the
  // queryable source of truth behind the referral board. Purely additive
  // and intentionally NOT fenced — older writers have no code path to it,
  // and the referrals module verifies its own schema on open.
  "referrals",
  // jev_shadow_decisions (Jev-harness shadow-decision journal,
  // docs/JEV-GATES.md): append-only measurement rows (gate, score,
  // would-be decision). Purely additive and intentionally NOT fenced —
  // older writers have no code path to it, IPs are stored hash-only, and
  // the journal verifies its own schema on open.
  "jev_shadow_decisions",
  // agent_autonomy_tiers (graduated autonomy tiers, #928 rescope):
  // one row per (room, member) with the operator-set tier. Purely additive
  // and intentionally NOT fenced — older writers have no code path to it,
  // and the module verifies its own schema on open. Replaces the slice 1/3
  // agent_operator_controls table (module removed).
  "agent_autonomy_tiers",
  // agent_skill_cards (RC-2026-09-24-202: members-directory skill cards).
  // Purely additive and intentionally NOT fenced — older writers have no
  // code path to it, and the module verifies its own shape on write.
  "agent_skill_cards",
  // identity_link_codes (RC-2026-09-24-210: identity-holder
  // proof-of-possession for identityId enrollment). Single-use codes are
  // hash-only rows with a 10-minute TTL, minted by the identity holder and
  // consumed atomically on enrollment. Purely additive and intentionally
  // NOT fenced — older writers have no code path to it, and the
  // mint/consume module verifies its own schema on open.
  "identity_link_codes",
  // inbox_attachment_bytes (identity-scoped staged inbox files for hosted
  // MCP). Purely additive and intentionally NOT fenced — older writers have
  // no code path to it, rows are scoped to one agent identity, and
  // InboxAttachmentBytes.verifySchema() is the integrity gate. This is not
  // the account-session inbox descriptor table.
  "inbox_attachment_bytes",
  // land_queue (per-room pull-request land queue). Purely additive and
  // intentionally NOT fenced — older writers have no code path to it, and
  // the module verifies its own schema on open. Rows never grant permission.
  "land_queue",
  "land_queue_idempotency",
  // agent_capability_grants (UFO-steal slice 1, RC-2026-09-27-2728:
  // per-agent capability grant edges). One row per (room, agent,
  // capability); revocation stamps revoked_at, expiry is lazy/fail-closed.
  // Purely additive and intentionally NOT fenced — older writers have no
  // code path to it, and server/grants.mjs verifies its own schema on open.
  "agent_capability_grants",
  // spend_grant_terms + spend_authorizations + spend_room_reservations
  // (spend-primitive MVP, qa4-spend-mvp-jill; reservations added by
  // qaD-fix-spend-race for cumulative room-allowance enforcement):
  // per-agent spend caps, the charge-then-forward ledger, and the
  // in-flight room-allowance reservations. Purely additive and
  // intentionally NOT fenced — older writers have no code path to them,
  // and server/spend-grants.mjs verifies its own schema on open. Rows
  // never grant permission by themselves; the capability edge in
  // agent_capability_grants is the liveness switch.
  "spend_grant_terms",
  "spend_authorizations",
  "spend_room_reservations",
  // referral_invite_keys + referral_invites + referral_chain_members
  // (signed agent-carried referral invites): per-room Ed25519 signing keys
  // (private half never leaves the database), the private mint/redeem/
  // rejection journal, and per-member chain depths. Purely additive and
  // intentionally NOT fenced — older writers have no code path to them,
  // tokens are bearer (never stored), and the module verifies its own
  // schema on open. DDL is shared with server/referral-invites.mjs
  // (convergent).
  "referral_invite_keys",
  "referral_invites",
  "referral_chain_members",
  // telegram_live_status (durable Telegram live-delivery/send facts, task 10)
  // is purely additive and intentionally NOT fenced: same rationale — older
  // writers have no code path to it, and the class verifies its own schema.
  "telegram_live_status",
  // Durable live work claims: additive, verified on open, included in recovery.
  "work_claims",
  "work_claim_config",
  // human_push_subscriptions (browser push for human members): one row per
  // device endpoint in a room. Purely additive and intentionally NOT fenced
  // — older writers have no code path to it. Rows are a delivery address,
  // never room content and never a grant.
  "human_push_subscriptions",
  // human_push_preferences (wave-2 #1601: per-member push-channel switches,
  // one row per member in a room). Same rationale as subscriptions: purely
  // additive, older writers have no code path to it, and the row only gates
  // delivery — it never grants anything.
  "human_push_preferences",
  // board_vtwo_* (BOARD-v2 SQLite persistence, PR #1144): board_vtwo_claims,
  // board_vtwo_events, board_vtwo_mirror, board_vtwo_idempotency. Purely additive
  // and intentionally NOT fenced — older writers have no code path to them,
  // and the module verifies its own schema on open.
  "board_vtwo_claims",
  "board_vtwo_events",
  "board_vtwo_mirror",
  "board_vtwo_idempotency",
  // integrity_snapshot (cold-start checksum): one row written only after the
  // yielding integrity job finishes. Purely additive and intentionally NOT
  // fenced — older writers have no code path to it, and a missing or stale
  // row only means the next cron rechecks. The constructor never uses it to
  // decide to replay the event log.
  "integrity_snapshot",
  // room_schema_stamp: one hash of the DDL this process applies. A match
  // skips schema setup on the next wake. integrity_job_cursor: which
  // deferred integrity step the cron runs next. Neither is room content.
  "room_schema_stamp",
  "integrity_job_cursor",
  // Public page read model. Written when an owner opts in, and removed when
  // they opt out. Older writers have no path to these tables. Public pages
  // read only these rows. The constructor creates the empty tables; the
  // cron backfill copies rooms that opted in before the tables existed.
  "public_receipts",
  "public_rooms",
  "public_directory_entries",
  "public_read_model_backfill",
  // Per-room sequence and projection size for the incremental integrity
  // check. The cron writes it; a missing row means that room is due.
  "integrity_room_state",
  // messages_backfill_cursor (MSG-2): per-room replay cursor for events that
  // landed before the messages table, plus importEvents and initialize.
  // The integrity cron writes it. Older writers have no path to it. A missing
  // row means that room has not been replayed. The parity check is the gate.
  "messages_backfill_cursor",
  // agent_wants_work (BOARD-WAKE-2): an agent's opt-in ready-work filter and
  // its last wake time. Older writers have no path to it. A missing row means
  // off, so a rollback only stops the ready_work wakes.
  "agent_wants_work",
  // room_code_drops / room_code_checks: code drop metadata and review checks.
  // The bytes live in room_attachments. Older writers have no path to them.
  "room_code_drops",
  "room_code_checks",
  // share_link_access: member / co-admin link options. A missing row is a guest link.
  "share_link_access",
  // projection_bodies: Phase 1a message bodies at rest. Older writers have no
  // path to it; rooms.projection rows they write carry full bodies.
  "projection_bodies",
  // LEGAL: terms acceptance, public abuse reports, and operator unpublish.
  // Additive and unfenced. Older writers have no code path to them.
  "account_terms",
  "public_abuse_reports",
  "public_unpublish",
  // operator_actions (CP-ADMIN-0): append-only operator audit. Purely additive
  // and intentionally NOT fenced — older writers have no path to it. The
  // append-only triggers are the integrity gate.
  "operator_actions",
  // squads (plan-squads): named groups with goal, roster, and thread channel.
  // Purely additive and intentionally NOT fenced — older writers have no code
  // path to it; the owner-managed roster rules in server/squads.mjs are the
  // integrity gate.
  "squads"
]);
// Created on first use, not in the constructor. A database that has never
// issued an OAuth grant or persisted an abuse rate bucket does not have
// these tables; a database that has must still pass the recovery audit.
// Retired Emissary growth layer (Batch 1, PR #1402): no module creates
// these tables anymore, but databases written before the removal still
// carry them (no DROP was issued, for data preservation). They stay in
// the allowed set so the recovery audit passes on upgraded databases,
// while fresh databases simply do not have them.
const RETIRED_EMISSARY_TABLES = Object.freeze([
  "external_identities",
  "external_receipts",
  "emissary_drops",
  "emissary_invite_attribution",
  "emissary_idempotency",
  "emissary_journal",
]);
// Retired operator-prerequisites slice 1/3 (PR #928, rescope #953): no
// module creates agent_operator_controls anymore, but databases opened while
// 25ac6ce1 was live (2026-09-24 06:52–21:52 UTC) still carry it (no DROP was
// issued, for data preservation). It stays in the allowed set so the
// recovery audit passes on upgraded databases, while fresh databases simply
// do not have it.
const RETIRED_OPERATOR_TABLES = Object.freeze([
  "agent_operator_controls",
]);
// Analytics tables (server/analytics/schema.mjs) + the claim-bond P0 shadow
// journal (server/analytics/claim-bond-shadow.mjs) + the P1 claim-reputation
// signal journal (server/claim-reputation.mjs): created on demand by
// analytics tooling (the tail, the backfill script, claim-bond-shadow --sync)
// directly in the room database, never by the store constructor. They stay
// in the recovery audit's allowed set so backupRoom/room-export keep passing
// on databases where the tooling ran (auditRecovery gates both), while a
// database that never ran the tooling simply does not have them — allowed,
// never required.
const ANALYTICS_ADDITIVE_TABLES = Object.freeze([
  "analytics_events",
  "analytics_room_cursor",
  "analytics_table_cursor",
  "analytics_firsts",
  "analytics_daily",
  "analytics_ctx",
  "claim_bond_shadow",
  "claim_reputation_signals",
]);
// seeker_declarations + work_offer_terms (matchmaking, Fo ship-train
// 2026-10-05, server/work-declarations.mjs): purely additive, created on
// first use — allowed by the recovery audit but not required in every DB.
const MATCHMAKING_ADDITIVE_TABLES = Object.freeze([
  "seeker_declarations",
  "work_offer_terms",
]);
// Wake-lease tables (durable listener queue, server/agent-heartbeats.mjs):
// purely additive, created lazily on first lease use.
const WAKE_LEASE_ADDITIVE_TABLES = Object.freeze(["agent_wake_listener_leases", "agent_wake_signal_claims"]);
export const lazyAdditiveTables = Object.freeze([...OAUTH_PROVIDER_TABLES, ...ABUSE_RATE_TABLES, ...RETIRED_EMISSARY_TABLES, ...RETIRED_OPERATOR_TABLES, ...ANALYTICS_ADDITIVE_TABLES, ...MATCHMAKING_ADDITIVE_TABLES, ...WAKE_LEASE_ADDITIVE_TABLES]);
// (Audit-fix F-2 intent preserved: analytics tables are lazy/additive, never
// required — they live in ANALYTICS_ADDITIVE_TABLES above.)
// messages (MSG-1) is fenced at v37 only. v34–v36 files do not have the
// table or its triggers; verifyWriterFence(36) must not require them.
const v34FencedTables = Object.freeze([...new Set([...deployedV28Tables, ...rebuiltAdditiveTables])]);
const v37FencedTables = Object.freeze([...v34FencedTables, "messages"]);
export const applicationTables = Object.freeze([...new Set([...deployedV28Tables, ...rebuiltAdditiveTables, ...unfencedAdditiveTables, "messages"])]);
const tablesFor = version => version <= 27 ? ({ 6: v6Tables, 7: v7Tables, 8: v8Tables, 9: v14Tables, 10: v14Tables, 11: v14Tables, 12: v14Tables, 13: v14Tables, 14: v14Tables, 15: v17Tables, 16: v17Tables, 17: v17Tables, 18: tables, 19: tables, 20: tables, 21: tables, 22: tables, 23: tables, 24: tables, 25: tables, 26: tables, 27: v27Tables })[version]
  : version === 28 ? v27Tables : version <= 33 ? deployedV28Tables : version <= 36 ? v34FencedTables : v37FencedTables;
export const fenceDefinitions = version => Object.freeze(tablesFor(version).flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
  const name = `writer_v${version}_${table}_${operation.toLowerCase()}`;
  return Object.freeze({ name, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT CASE WHEN project_room_writer_v${version}() IS NOT ${version} THEN RAISE(ABORT,'unsupported database writer') END; END` });
})));
// v28's deployed lineage included attachment triggers; accept them as known
// history while requiring only the rebuilt set when opening a rebuilt v28 DB.
const deployedV28FenceDefinitions = Object.freeze(deployedV28Tables.flatMap(table => ["INSERT", "UPDATE", "DELETE"].map(operation => {
  const name = `writer_v28_${table}_${operation.toLowerCase()}`;
  return Object.freeze({ name, sql: `CREATE TRIGGER ${name} BEFORE ${operation} ON ${table} BEGIN SELECT CASE WHEN project_room_writer_v28() IS NOT 28 THEN RAISE(ABORT,'unsupported database writer') END; END` });
})));
export const writerFenceDefinitions = fenceDefinitions(STORE_SCHEMA_VERSION);

export function registerWriter(db) {
  db.function("project_room_writer_v6", () => 6); // Retained migration-era guards.
  db.function("project_room_writer_v7", () => 7);
  db.function("project_room_writer_v8", () => 8);
  db.function("project_room_writer_v9", () => 9);
  db.function("project_room_writer_v10", () => 10);
  db.function("project_room_writer_v11", () => 11);
  db.function("project_room_writer_v12", () => 12);
  db.function("project_room_writer_v13", () => 13);
  db.function("project_room_writer_v14", () => 14);
  db.function("project_room_writer_v15", () => 15);
  db.function("project_room_writer_v16", () => 16);
  db.function("project_room_writer_v17", () => 17);
  db.function("project_room_writer_v18", () => 18);
  db.function("project_room_writer_v19", () => 19);
  db.function("project_room_writer_v20", () => 20);
  db.function("project_room_writer_v21", () => 21);
  db.function("project_room_writer_v22", () => 22);
  db.function("project_room_writer_v23", () => 23);
  db.function("project_room_writer_v24", () => 24);
  db.function("project_room_writer_v25", () => 25);
  db.function("project_room_writer_v26", () => 26);
  db.function("project_room_writer_v27", () => 27);
  for (const version of [28, 29, 30, 31, 32, 33, 34, 35, 36, 37]) db.function(`project_room_writer_v${version}`, () => version);
  db.function(WRITER_FUNCTION, () => STORE_SCHEMA_VERSION);
}

export function installWriterFence(db) {
  if (!db.isTransaction) throw new Error("Writer fence installation requires the migration transaction");
  for (const { name, sql } of writerFenceDefinitions) {
    const existing = db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name);
    if (!existing) db.exec(sql);
    else if (existing.sql !== sql) throw new Error("Database writer fence requires operator reconciliation");
  }
  db.exec(`PRAGMA user_version=${STORE_SCHEMA_VERSION}`);
}

export function verifyWriterFence(db, version = STORE_SCHEMA_VERSION) {
  const histories = writerVersions.filter(v => v <= version).flatMap(fenceDefinitions);
  if (version >= 28) histories.push(...deployedV28FenceDefinitions);
  const expected = new Map(histories.map(def => [def.name, def.sql]));
  for (const row of db.prepare("SELECT name,sql FROM sqlite_master WHERE type='trigger' AND name GLOB 'writer_v*'").all()) {
    if (expected.get(row.name) !== row.sql) throw new Error("Database writer fence requires operator reconciliation");
  }
  // The fence guarantees every table present is fenced; a missing table is a
  // schema-presence concern, not a fence concern. Purely additive tables are
  // recreated (with their fences) by the writable migration, while read-only
  // verification reports the specific missing schema instead of the fence.
  const present = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  const prefix = `writer_v${version}_`;
  for (const { name, sql } of fenceDefinitions(version)) {
    if (!present.has(name.slice(prefix.length).replace(/_(insert|update|delete)$/, ""))) continue;
    if (db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").get(name)?.sql !== sql) {
      throw new Error("Database writer fence requires operator reconciliation");
    }
  }
}

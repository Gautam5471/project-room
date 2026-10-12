import { uiText } from "./strings.js";
import { installOwnerProjectOffers } from "./owner-project-offers-ui.js";
import { createMemberDisplayNames } from "./member-display-names.js";
import { installRoomLayout, syncSidebarSections } from "./room-layout.js";
import { EVENT_TYPES as T, MAX_MESSAGE_BODY_CHARS, WORK_STATES as S, roomPolicy, roomTrust, distinctMemberOwnerIds, roomKind, isRoomArchived, spendAllowance, pinnedMessages, isPinned, PIN_LIMIT, isMutedBy, channelList, messageChannelId, DEFAULT_CHANNEL_ID } from "./events.js";
import { AccountClient, RoomClient, draftCommand, retryUnconfirmed } from "./client.js";
import { ReturnBrief, groupBriefHistory } from "./return-brief.js";
import { attentionPreview, needsAttention, workInvolvingMe, contributionSteps, searchWork, draftFeedback, completedResults, currentResult, roomOrientation } from "./work-selectors.js";
import { menuOpensUp, TIMELINE_WINDOW, windowTimeline, createTimelinePin, arrivalsAfterShown, windowToInclude, conversationIndex, searchMessages, ConversationDrafts, channelDraftKey, DraftRecovery, draftRecoveryScope, shouldPreserveDrafts, sendsOnEnter, escapeChatAction, messageCluster, mentionQuery, mentionMatches, createBodyHtmlCache, kindLabel, memberStatus, memberHandle, memberPresence, memberDoneChip, presenceLabel, addressMember, shouldAddressPresenceClick, messageMentionsMember, replyAuthorToAddress, composerPlaceholder, removeMention, parseSearchQuery, reactionPills } from "./conversation.js";
import { canonicalReaction, clipGraphemes, emojiCatalog, emojiMatches, emojiName, emojiQuery, foldedReactionMap, frequentEmoji, insertEmoji, renderEmojiShortcodes } from "./emoji.js";
import { nextWorkStep, workStatus, workActions, renderWorkActions, activeClaim, terminalWork, doneChip, reusableWorkDefinition, confirmsWorkProposal, confirmsWorkAction, matchesReceipt, producerKnown as hasReportedProducer, changeDescription, diffResultLines, diffResultSummary, workRecipeOptions } from "./workflow.js";
import { coordinationLoops } from "./work-loops.js";
import { RECIPE_CATALOG, activeRecipes, previewAllRecipes } from "./work-recipes.js";
import { attemptReceipts, attemptLedger, cancellationState, workContinuity, spendLedger } from "./work-item-session.js";
import { consumeJoinFragment, installShareLinks, canRetryInvitation, requestFailureMessage } from "./share-links.js";
import { FIRST_ROOM_SETUP_FAILURE } from "./first-room-copy.js";
import { dmConsentPeerSummary, incomingDmRequests, dmConsentPairDescription, dmConsentActionsForPeer, fetchDmConsents, requestDmConsent, decideDmConsent, revokeDmConsent, blockDmMember, unblockDmMember, dmConsentFailureMessage, DM_CONSENT_REFUSAL_CODES } from "./dm-consents.js";
import { identityIdOf, mergeFriendBonds, bondWithPeer, friendChrome, friendBondCommand, friendFailureMessage, friendFocusTarget, friendMessageHtml } from "./friend-bond.js";
import { installAgentConnections } from "./agent-connections.js";
import { catalogById } from "./room-roster.js";
import { installRoomInstructions } from "./room-instructions.js";
// JDOT-MEMBER-PERMS-UI begin
import { createNeedsAttentionCard, installMemberPermissions } from "./needs-attention.js";
// JDOT-MEMBER-PERMS-UI end
import { mountUpdates } from "./updates-ui.js";
import { installReminders } from "./reminders.js";
import { installPortableWork, installResultCopy } from "./portable-work.js";
import { replyDraftKey, replyDraftData, validReplyDraft, replyFollowUp, creditQuestion, confirmsReplyCommand, REPLY_CANCELLED } from "./reply-requests.js";
import { workHelpContext, validateHelpData } from "./work-help.js";
import { workOffersContext, validateHelpOfferData } from "./help-offers.js";
import { installInbox } from "./inbox-ui.js";
import { nameBeforeFirstRoom } from "./account-setup-ui.js";
import { createAccountSettingsUI, applyStoredTheme, organizeRoomSettings, ACCOUNT_DELETED_MESSAGE } from "./account-settings-ui.js";
import { createAuthSigninUI, classifyAuthLink } from "./auth-signin-ui.js";
import { createAgentSigninUI } from "./agent-signin-ui.js";
import { stashPendingInvite, clearPendingInvite, takeRestoredInvite, stashPendingJoin, clearPendingJoin, takeRestoredJoin, inviteRequestDoor, defaultRequestPermissions, validateAccessRequestForm, newAccessRequestId, stashAccessRequest, readAccessRequest, AGENT_INVITE_CODE_PATTERN, agentInviteJoinPath } from "./invite-context.js";
import { selectedRoomFromLocation as roomFromLocation, roomIdFromHash, roomIdFromNext, ROOM_ACCESS_NOTICE } from "./room-deep-link.js";
import { installAgentInvites } from "./agent-invite-ui.js";
import { rememberLastRoom, rememberAccountHint, readLastRoom, readAccountHint, hasSessionHint, clearBrowserSessionHints, rememberMemberRoom, readMemberRoom, clearStoredPasswords, signInRoomTarget } from "./browser-session.js";
import { attachmentFromBytes, composerAudienceNote, composerAudiencePickerVisible, COMPOSER_FILE_BYTES, fileChipLabel } from "./composer-files.js";
import { formatSessionExpiry } from "./session-expiry.js";
import { handoffEnvelopeListHtml, envelopesForWork } from "./handoff-envelope-ui.js";
import { installHumanPush } from "./human-push.js";
import { chatSuggestions, ASK_AGENT_AFTER_MS } from "./chat-suggestions.js";
import { paintClaimChat } from "./board-ui.js";
import { installHumanExperience } from "./human-experience.js";
import { createSpendPricingKillSwitch } from "./spend-pricing-ui.js";
const bodyHtmlCache = createBodyHtmlCache();

// Keep a connector/native consent journey through password or provider login.
// Only our exact consent path is a return target; never follow arbitrary URLs.
const oauthReturnKey = "project-room:oauth-return:v1";
let initialDesktopProvider = null;
function validatedOAuthReturn(value) {
  if (typeof value !== "string" || !value.startsWith("/oauth/authorize?") || value.length > 4096) return null;
  try {
    const target = new URL(value, location.origin);
    return target.origin === location.origin && target.pathname === "/oauth/authorize" && !target.hash
      && !target.username && !target.password ? target.pathname + target.search : null;
  } catch { return null; }
}
try {
  const params = new URLSearchParams(location.search);
  const target = params.get("oauth") === "login" ? validatedOAuthReturn(params.get("return")) : null;
  if (target) {
    sessionStorage.setItem(oauthReturnKey, target);
    const providers = params.getAll("provider"), consent = new URL(target, location.origin).searchParams;
    const nativeConsent = consent.getAll("client_id").length === 1 && consent.get("client_id") === "project-room-macos"
      && consent.getAll("redirect_uri").length === 1 && consent.get("redirect_uri") === location.origin + "/api/auth/desktop/callback"
      && consent.getAll("state").length === 1 && /^[A-Za-z0-9_-]{43}$/.test(consent.get("state") || "")
      && consent.getAll("code_challenge").length === 1 && /^[A-Za-z0-9_-]{43}$/.test(consent.get("code_challenge") || "")
      && consent.getAll("code_challenge_method").length === 1 && consent.get("code_challenge_method") === "S256";
    if (nativeConsent && params.getAll("return").length === 1 && params.getAll("oauth").length === 1
      && providers.length === 1 && ["google", "github"].includes(providers[0])) initialDesktopProvider = providers[0];
    // Consume intent in this document only, so refresh/cancel cannot restart it.
    if (providers.length) {
      const entrance = new URL(location.href);
      entrance.searchParams.delete("provider");
      history.replaceState(history.state, "", entrance.href);
    }
  }
} catch { /* A blocked storage leaves ordinary sign-in available. */ }
function resumeOAuthConsent() {
  if (!accountClient.session?.authenticated || accountClient.session.terms?.required) return false;
  try {
    const target = validatedOAuthReturn(sessionStorage.getItem(oauthReturnKey));
    sessionStorage.removeItem(oauthReturnKey);
    if (target) { location.assign(target); return true; }
  } catch { /* No arbitrary redirect fallback. */ }
  return false;
}

const $ = selector => document.querySelector(selector);
applyStoredTheme();
organizeRoomSettings($("#settings-dialog"));
const accountSettingsButton = $("#account-settings-button");
if (accountSettingsButton) accountSettingsButton.textContent = "Account";
const accountSettingsSummary = document.querySelector("#account-settings > summary");
if (accountSettingsSummary) accountSettingsSummary.textContent = "Account";
// The static hero is the whole page for no-JS strangers and crawlers (QA
// 2026-10-03 P1-1). It comes down the moment the app boots so it never
// double-renders with the live UI. Module top level: runs before any render.
$("#static-hero")?.remove();
$("#skip-link").addEventListener("click", event => {
  event.preventDefault();
  const target = !$("#inbox-panel").hidden ? "#inbox-heading"
    : !$("#main").hidden ? "#conversation-title"
    : $("#auth-panel").hidden ? "#connection-status"
    : "#auth-title";
  $(target).focus();
});
const setText = (selector, text) => { const node = $(selector); if (node.textContent !== text) node.textContent = text; };
const invitationTokenPattern = /^[A-Za-z0-9_-]{43}$/;
function consumeInvitationFragment() {
  if (!location.hash.startsWith("#invite/")) return null;
  const candidate = location.hash.slice("#invite/".length);
  history.replaceState(history.state, "", `${location.pathname}${location.search}`);
  // QA-200 P1: a #invite/RM-<code> fragment is an agent-invite link in the
  // SPA's fragment form. The SPA's invitation dialog only redeems 43-char
  // human share-link tokens, so without a redirect this rendered "This
  // invitation link is unavailable." before any API call — even though the
  // code is redeemable on the /join page. Flag it; the call sites navigate.
  if (AGENT_INVITE_CODE_PATTERN.test(candidate)) return { valid: false, secret: candidate, redirect: true };
  return invitationTokenPattern.test(candidate)
    ? { valid: true, secret: candidate }
    : { valid: false, secret: null };
}
// Navigate an agent-invite fragment (#invite/RM-<code>) to the join page
// that can actually redeem it. Returns true when a navigation was started.
function redirectAgentInvite(fragment) {
  if (!fragment?.redirect) return false;
  const path = agentInviteJoinPath(`#invite/${fragment.secret}`, location.pathname);
  if (path) location.assign(path);
  return true;
}
function selectedRoomFromLocation() {
  const nextRoom = roomIdFromNext(new URLSearchParams(location.search).get("next"));
  if (nextRoom) return nextRoom;
  return roomFromLocation({ search: location.search, hash: location.hash });
}
function accountHomeFromLocation() {
  const values = new URLSearchParams(location.search).getAll("account");
  return values.length === 1 && values[0] === "1";
}
// One-shot signal from the Google OAuth callback: the flow genuinely failed
// (denied consent, bad state). Read and stripped before boot runs so the
// failure surfaces exactly once, as an auth-panel message, never as a
// silent bounce back to the login form.
function googleErrorFromLocation() {
  const values = new URLSearchParams(location.search).getAll("google");
  return values.length === 1 && ["error", "unavailable"].includes(values[0]) ? values[0] : null;
}
function accountDeletedFromLocation() {
  const values = new URLSearchParams(location.search).getAll("account-deleted");
  return values.length === 1 && values[0] === "1";
}
const initialAccountDeleted = accountDeletedFromLocation();
if (initialAccountDeleted) {
  const url = new URL(location.href);
  url.searchParams.delete("account-deleted");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
const initialGoogleFailed = googleErrorFromLocation();
const googleSigninFailureMessage = initialGoogleFailed === "unavailable"
  ? "Google sign-in isn’t available here yet. Choose another way to sign in."
  : "Google sign-in didn’t finish. Try again or choose another way to sign in.";
if (initialGoogleFailed) {
  const url = new URL(location.href);
  url.searchParams.delete("google");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
// GitHub OAuth callback errors land here (slice 7); the param is stripped
// immediately so a refresh does not replay the failure message.
function githubErrorFromLocation() {
  const values = new URLSearchParams(location.search).getAll("github");
  return values.length === 1 && values[0] === "error";
}
const initialGitHubFailed = githubErrorFromLocation();
if (initialGitHubFailed) {
  const url = new URL(location.href);
  url.searchParams.delete("github");
  history.replaceState(history.state, "", `${url.pathname}${url.search}${url.hash}`);
}
const initialJoinFragment = (() => {
  // [QA-Join]: a Google/GitHub OAuth round-trip drops the #join/ fragment (it
  // never reaches the server). Restore a stashed join link one-shot before
  // consuming, so the join dialog re-opens after OAuth sign-in instead of the
  // first-sign-in default-room flow creating a stray personal room. Same
  // contract as #invite/ below; a fresh #join/ hash always wins over the stash.
  const restored = takeRestoredJoin({ storage: window.sessionStorage, hash: location.hash, search: location.search });
  if (restored) { try { location.hash = restored.fragment; } catch { /* ignore */ } }
  return consumeJoinFragment();
})();
// Start a room: the door's main button opens /?start=room. The intent rides
// sessionStorage through an OAuth round-trip in this tab, and after sign-in
// the visitor lands inside their room instead of the Inbox.
const START_ROOM_KEY = "pr-start-room";
let startRoomIntent = (() => {
  try {
    const url = new URL(location.href);
    if (url.searchParams.get("start") === "room") {
      window.sessionStorage.setItem(START_ROOM_KEY, "1");
      url.searchParams.delete("start");
      history.replaceState(history.state, "", url.pathname + url.search + url.hash);
    }
    return window.sessionStorage.getItem(START_ROOM_KEY) === "1";
  } catch { return false; }
})();
// --- GR1: a public receipt footer lands on /?start=room&ref=<owner name>.
// Stash the name and prefill "Who referred you?" on the access-request form.
const RECEIPT_REF_KEY = "pr-receipt-ref";
try {
  const refUrl = new URL(location.href);
  const ref = refUrl.searchParams.get("ref");
  if (ref && ref.length <= 80 && !/[\u0000-\u001f\u007f]/.test(ref)) {
    window.sessionStorage.setItem(RECEIPT_REF_KEY, ref);
    refUrl.searchParams.delete("ref");
    history.replaceState(history.state, "", refUrl.pathname + refUrl.search + refUrl.hash);
  }
} catch { /* storage or the URL may be blocked */ }
function receiptReferrer() {
  try { return window.sessionStorage.getItem(RECEIPT_REF_KEY) || ""; } catch { return ""; }
}
// --- end GR1 ---
// --- GR2: template start, public-room join, and directory invite survive sign-in. ---
const ACQUISITION_KEY = "pr-acquisition";
const TEMPLATE_ROOM_KEY = "pr-template-room";
try {
  const acqUrl = new URL(location.href);
  const start = acqUrl.searchParams.get("start");
  const intent = start === "template"
    ? { kind: "template", template: acqUrl.searchParams.get("template") || "" }
    : start === "invite-agent"
      ? { kind: "invite-agent", agent: acqUrl.searchParams.get("agent") || "" }
      : acqUrl.searchParams.has("request")
        ? { kind: "request", roomId: acqUrl.searchParams.get("request") || "" }
        : null;
  if (intent) {
    window.sessionStorage.setItem(ACQUISITION_KEY, JSON.stringify(intent));
    acqUrl.searchParams.delete("start");
    acqUrl.searchParams.delete("template");
    acqUrl.searchParams.delete("agent");
    acqUrl.searchParams.delete("request");
    history.replaceState(history.state, "", acqUrl.pathname + acqUrl.search + acqUrl.hash);
  }
} catch { /* storage or the URL may be blocked */ }
function readAcquisition() {
  try { return JSON.parse(window.sessionStorage.getItem(ACQUISITION_KEY) || "null"); }
  catch { return null; }
}
function clearAcquisition() {
  try { window.sessionStorage.removeItem(ACQUISITION_KEY); } catch { /* storage may be blocked */ }
}
// --- end GR2 ---
function consumeStartRoomIntent() {
  const wanted = startRoomIntent;
  startRoomIntent = false;
  try { window.sessionStorage.removeItem(START_ROOM_KEY); } catch { /* storage may be blocked */ }
  return wanted;
}
// A Google/GitHub OAuth round-trip drops the #invite/ fragment (it never
// reaches the server). Restore a stashed invitation one-shot when landing
// without a room context, so the dialog re-opens after OAuth sign-in.
const initialInvitationFragment = consumeInvitationFragment()
  || takeRestoredInvite({ storage: window.sessionStorage, hash: location.hash, search: location.search });
// QA-200 P1: a #invite/RM-<code> landing navigates to the join page
// immediately instead of booting the SPA's invitation dialog, which cannot
// redeem agent-invite codes.
redirectAgentInvite(initialInvitationFragment);
// Stash the live invitation secret at the exact moment an OAuth navigation
// starts. The #invite/ fragment never reaches the server, so without this
// the Google/GitHub round-trip would drop the invitation. The secret touches
// sessionStorage only for the round-trip (cleared on dialog close/accept and
// consumed one-shot at boot); merely previewing an invitation never stores it.
function stashInviteForOAuth() {
  if (invitation.secret) stashPendingInvite(window.sessionStorage, invitation.secret);
  // [QA-Join]: the #join/ share-link fragment is dropped by the OAuth
  // round-trip exactly like #invite/. Stash the live address-bar token (put
  // back by the join dialog when a join was attempted but not landed) so the
  // dialog re-opens after sign-in. A stale stash from an abandoned OAuth is
  // cleared when no join link is live, so it can't resurrect a phantom invite.
  const pendingJoin = shareLinksUI?.pendingFragment() || location.hash;
  if (typeof pendingJoin === "string" && pendingJoin.startsWith("#join/")) stashPendingJoin(window.sessionStorage, pendingJoin);
  else clearPendingJoin(window.sessionStorage);
}
// The Google entry point is a plain anchor: stash a live invitation before
// the navigation, since the OAuth round-trip drops the #invite/ fragment.
{ const googleButton = $("#google-signin");
  if (googleButton) googleButton.addEventListener("click", stashInviteForOAuth); }
let shareLinksUI = null;
let briefReconcileNote = ""; // Catch-up reconciliation failure, shown in the brief while the dialog is open.
let portableWorkUI = null;
let resultCopyUI = null;
let remindersUI = null;
let agentConnectionsUI = null;
let agentInvitesUI = null;
let referralBoardUI = null;
let landQueueUI = null;
let openQuestionsUI = null;
let retentionUI = null;
let instructionsUI = null;
let inboxUI = null;
let state = null, session = null, pendingMessage = null, pendingWork = null, pendingAction = null;
// JDOT-COH-NAV begin
let updatesUi = null, resetNavigationBoard = null, navigationBoardReady = null;
const workNavigationOrigins = new Map();
let activeWorkNavigation = null, activeWorkNavigationId = null, workNavigationEpoch = 0, workHistoryReplayKey = null;
let navigationBoardEpoch = 0;
// JDOT-COH-NAV end
// Phase 2 channels: the visible channel; persisted per room, defaults to the main channel.
let activeChannelId = DEFAULT_CHANNEL_ID, activeChannelRoomId = null;
let workDraftId = null, replyToId = null, busy = false;
let workFormEpoch = 0, workRetryLocked = false;
let actionEpoch = 0;
let offerContextVersion = null;
let currentThreadId = null, conversation = null, drafts = new ConversationDrafts();
let requestRuns = {}, requestRunsReading = false, requestRunsReadKey = "";
let assistantDraft = null;
let requestMode = null, requestReading = false, requestEpoch = 0;
const composerKey = () => requestMode ? replyDraftKey(requestMode, currentThreadId) : assistantDraft ? `assistant:${assistantDraft.runId}` : currentThreadId ?? channelDraftKey(activeChannelId);
const conversationViewKey = () => currentThreadId ? `thread:${currentThreadId}` : `room:${activeChannelId}`;
// The room timeline renders only its newest TIMELINE_WINDOW root messages; the
// "Show earlier messages" control adds another page. A room with thousands of
// messages otherwise builds thousands of rows (and layout reads over them) on
// open. timelineWindow maps a view key to how many roots that view shows.
const TIMELINE_PAGER_KEY = "pager:earlier";
const timelineWindow = new Map();
let timelineRevealing = false;
const viewPositions = new Map(), pendingReactions = new Map(), pendingPins = new Set(), locallyOwnedMessageIds = new Set();
const timelinePin = createTimelinePin();
let pinScrollTop = null; // where the pin last moved the list; that scroll event is not the reader's
let newVisibleMessages = 0, unreadAnchorId = null, mentionIndex = 0, emojiIndex = 0;
let mutedThreads = new Set(), threadMuteBusy = false;
let roomCursor = 0, catchUpBoundary = 0, roomGeneration = -1, showAllAttention = false, returnClock = null;
let signoutOperationId = 0, signoutLoading = false;
let refreshOperationId = 0, submitOperationId = 0;
let submitControls = null, noticeTimer = null, noticeVersion = 0, workFormOpener = null;
let accessEndContext = null;
let lastComposerSelection = null;
let lastInvitationOpener = null;
let roomActionsContext = null;
// C6: owner-facing agent controls. agentPauses is the owner's last-read paused
// roster (memberId -> { pausedAt, reason }); armedRemoval is the one agent whose
// Remove button is waiting for its confirming second click.
let agentPauses = new Map(), armedRemoval = null, memberActionBusy = false;
const invitation = {
  phase: "idle", version: 0, secret: null, preview: null, redemptionId: null,
  opener: null, openerSelection: null, requestAccess: null
};
const invitationIsCommitting = () => ["authenticating", "accepting", "opening"].includes(invitation.phase)
  || (humanAuthBusy && Boolean(invitation.secret));
const accountClient = new AccountClient();
document.addEventListener("focusin", event => {
  if (!$("#invitation-dialog").contains(event.target)
    && event.target.matches?.("button, input, textarea, select, a[href], [tabindex]")) lastInvitationOpener = event.target;
});
document.addEventListener("pointerdown", event => {
  if (event.target !== $("#message-input") && !$("#invitation-dialog").contains(event.target)) lastComposerSelection = null;
});
document.addEventListener("keydown", event => {
  if (event.key === "Tab" && event.target === $("#message-input")) lastComposerSelection = null;
});
let recovery;
let leavingPage = false;
let composerFiles = [];
let roomFilesByMessage = new Map();
const messageFileDownloads = new Map();
try { recovery = new DraftRecovery(navigator.userAgent.includes("ProjectRoomMac/") ? window.localStorage : window.sessionStorage); } catch { recovery = new DraftRecovery(null); }
const draftScope = draftRecoveryScope;
const client = new RoomClient({
  accountClient,
  // Live refresh: a peer's consent decision arrives as dm.consent_changed.
  onConsentChange: () => { void refreshDmConsents(); },
  onSnapshot(snapshot, identity) {
    const firstSnapshot = !state;
    const presenceBoundary = firstSnapshot || state.room?.id !== snapshot.state.room?.id || roomGeneration !== client.generation;
    if (presenceBoundary) stopPresencePoll();
    state = snapshot.state; session = identity;
    displayNames = createMemberDisplayNames(state.members);
    void refreshRequestRuns();
    offerContextVersion = snapshot.offerContextVersion === 1 ? 1 : null;
    roomCursor = snapshot.cursor;
    // R28-1: the chip counts from the catch-up boundary (your own unbroken run of
    // events is not news); the resume cursor above stays the stored marker.
    catchUpBoundary = Number.isSafeInteger(snapshot.catchUpCursor) ? Math.max(snapshot.cursor, snapshot.catchUpCursor) : snapshot.cursor;
    roomGeneration = client.generation;
    const roomId = state.room?.id ?? identity.roomId;
    if (roomId !== activeChannelRoomId) { activeChannelRoomId = roomId; restoreActiveChannel(); }
    const roomTitle = state.room?.title ?? roomId;
    $("#room-title").textContent = roomTitle;
    $("#mobile-room-name").textContent = roomTitle;
    $("#room-overview-open").setAttribute("aria-label", `${roomTitle}, Room overview`);
    $(".room-purpose").textContent = state.room?.purpose ?? "";
    $("#main").hidden = false; $("#auth-panel").hidden = true; $("#auth-panel").setAttribute("aria-busy", "false");
    $("#account-rooms-panel").hidden = true;
    $(".connection-bar").hidden = false;
    $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
    const hasAccount = Boolean(accountClient.session?.authenticated && accountClient.session.account);
    $("#account-settings-button").hidden = hasAccount ? false : true;
    $("#create-account-button").hidden = hasAccount ? true : false;
    syncSessionMenu();
    $("#identity-label").textContent = displayName(session.member.id);
    $("#identity-label").title = `${memberLabel(session.member.id)} · ${kindLabel(session.member.kind)}`;
    $("#cursor-label").textContent = `Your caught-up marker: ${snapshot.cursor} · room event ${snapshot.sequence}`;
    render();
    syncRoomLifecycle();
    shareLinksUI?.sync();
    remindersUI?.sync();
    syncNotifications();
    syncAttention();
    agentConnectionsUI?.sync();
    agentInvitesUI?.sync();
    referralBoardUI?.sync();
    landQueueUI?.sync();
    openQuestionsUI?.sync();
    retentionUI?.sync();
    if (presenceBoundary) startPresencePoll();
    if (firstSnapshot) {
      rememberLastRoom(roomId, undefined, state.room?.title);
      const accountId = accountClient.session?.account?.id ?? session?.account?.id;
      if (accountId) rememberMemberRoom(accountId, roomId, undefined, state.room?.title);
      if (session?.member?.id) rememberMemberRoom(session.member.id, roomId, undefined, state.room?.title);
      void refreshRoomFiles();
      void refreshDmConsents();
      void refreshFriendBonds();
      void refreshSavedIds();
      void applyHorizonAnchor();
      void refreshMutedThreads();
    }
    instructionsUI?.sync();
    resultCopyUI?.sync();
    portableWorkUI?.sync();
    inboxUI?.sync();
    if (firstSnapshot) {
      // JDOT-MEMBER-PERMS-UI begin
      // render() synchronizes the existing attention card for owners/admins.
      // JDOT-MEMBER-PERMS-UI end
      const saved = recovery.read(draftScope(identity), state);
      if (saved) {
        drafts = saved.drafts; currentThreadId = saved.threadId;
        if (state.channels?.[saved.channelId] && !state.channels[saved.channelId].archivedAt) activeChannelId = saved.channelId;
        syncChannelChrome();
        const draft = drafts.get(saved.activeKey);
        requestMode = draft.mode ?? null;
        restoreComposer(draft);
        updateReply(); renderMessages(); syncRequestComposer(); renderComposerError();
      }
    }
    if (!briefView.owns(briefView.chain)) loadReturnBrief();
    if (firstSnapshot) revealLocationHash();
  },
  onStatus(text) { setConnectionStatus(text); },
  onTyping(typists) { renderTyping(typists); },
  onAccessEnded() {
    closeRoomActions(false);
    const hadRoom = Boolean(state);
    const endedContext = accessEndContext;
    accessEndContext = null;
    const pendingSignout = signoutLoading;
    const keepAccount = !leavingPage && !pendingSignout && endedContext !== "account-switch" && accountClient.session?.authenticated;
    // E-H2: an unexpected access end (401/403 session expiry, not sign-out,
    // room/account switch, or page unload) must not destroy the in-flight
    // draft. The user didn't leave; the credential died. Preserve the
    // persisted backup, the in-memory drafts, and the composer text so
    // re-authentication restores them.
    const sessionExpired = shouldPreserveDrafts({ leavingPage, pendingSignout, endedContext });
    // Opening a room from the room list ends "access" first, with no room open. That
    // must not wipe the draft an expired session left for this same room (E-H2).
    const openingFromList = !hadRoom && ["accepted-room-switch", "invited-room-switch"].includes(endedContext);
    if (!leavingPage && !sessionExpired && !openingFromList) recovery.clear();
    releaseSubmission(submitControls);
    submitOperationId += 1; busy = false;
    displayNames = createMemberDisplayNames({});
    state = null; session = null; pendingMessage = null; pendingWork = null; pendingAction = null; offerContextVersion = null; actionEpoch++;
    // JDOT-COH-NAV begin
    clearWorkNavigation(); updatesUi?.reset();
    // JDOT-COH-NAV end
    mutedThreads = new Set(); threadMuteBusy = false;
    dmConsents = []; dmConsentSeq++;
    friendBonds = []; friendSeq++; friendBusy = false; friendDmPeerId = null;
    $("#friend-dm-dialog")?.close();
    stopPresencePoll();
    accessPreviews.clear();
    handoffEnvelopes.receipts = null; handoffEnvelopes.loading = false;
    $("#resume-action").hidden = true; $("#refresh-action").hidden = true;
    $("#action-evidence").hidden = true; $("#action-evidence").removeAttribute("href");
    $("#action-text").hidden = true; $("#action-text-body").textContent = ""; $("#action-text-origin").textContent = "";
    clearResultComparison($("#action-result-diff"));
    closeResult(false);
    selectWorkView("work");
    renderContent("#room-results-list", "");
    roomCursor = 0; catchUpBoundary = 0; roomGeneration = -1; showAllAttention = false; clearTimeout(returnClock); returnClock = null;
    ownerOffersUI?.reset();
    shareLinksUI?.resetManagement();
    portableWorkUI?.reset();
    resultCopyUI?.reset();
    remindersUI?.reset();
    resetNotifications();
    resetAttention();
    // JDOT-MEMBER-PERMS-UI begin
    memberPermissionsUI?.reset();
    ownerAttentionCard.hide();
    // JDOT-MEMBER-PERMS-UI end
    agentConnectionsUI?.reset();
    agentInvitesUI?.reset();
    referralBoardUI?.reset();
    landQueueUI?.reset();
    openQuestionsUI?.reset();
    retentionUI?.reset();
    $("#room-more").open = false;
    $("#advanced-room-tools").open = false;
    instructionsUI?.reset();
    if (!keepAccount) {
      clearPrivateWorkspace({ preservePending: leavingPage });
      if (pendingSignout || endedContext === "account-switch") clearBrowserSessionHints();
    }
    else inboxUI?.detachRoom();
    workDraftId = null; replyToId = null; workFormEpoch++; setWorkRetry(false);
    syncRoomLifecycle();
    $("#work-reuse-hint").hidden = true;
    currentThreadId = sessionExpired ? currentThreadId : null; conversation = null;
    if (!sessionExpired) {
      drafts = new ConversationDrafts();
      $("#message-input").value = "";
    }
    requestRuns = {}; assistantDraft = null; requestMode = null; requestReading = false; requestEpoch++; syncRequestComposer();
    renderComposerError();
    viewPositions.clear(); timelineWindow.clear(); pendingReactions.clear(); locallyOwnedMessageIds.clear(); newVisibleMessages = 0; briefView.reset();
    if (!pendingSignout) signoutOperationId += 1;
    refreshOperationId += 1;
    $("#signout-button").disabled = pendingSignout;
    workFormOpener = null; clearNotice();
    $("#main").hidden = true; $("#auth-panel").hidden = false; $("#signout-button").hidden = true;
    humanExperience?.sync();
    $("#account-settings-button").hidden = true;
    syncSessionMenu();
    $("#auth-panel").setAttribute("aria-busy", pendingSignout ? "true" : "false");
    $("#identity-label").textContent = "Not signed in";
    $("#identity-label").removeAttribute("title");
    for (const id of ["message-list", "event-list", "presence-list", "summary-grid", "reply-context", "source-context", "action-context", "action-fields", "cursor-label", "presence-count", "event-count", "rb-attention-list", "rb-involving-list", "rb-history-list", "decision-list", "usage-grid", "usage-period", "usage-status", "record-export-status"]) {
      const node = $(`#${id}`); node.replaceChildren(); delete node._content;
    }
    $("#usage-refresh").hidden = true; $("#record-export-html").disabled = false; exportRequest += 1;
    for (const id of ["message-to-select", "assignee-select", "verifier-select"]) { $(`#${id}`).replaceChildren(); delete $(`#${id}`).dataset.signature; }
    for (const form of document.querySelectorAll("form")) {
      if (sessionExpired && form.id === "message-form") continue;
      if (!keepAccount || !form.closest("#inbox-panel")) form.reset();
    }
    if (!humanAuthBusy) signinUI?.clear();
    showSigninMethods();
    agentSigninUI?.clear();
    clearStoredPasswords();
    composerFiles = [];
    roomFilesByMessage = new Map();
    messageFileDownloads.clear();
    renderComposerFiles();
    $("#work-dialog").close();
    $("#room-overview-dialog").close();
    $("#room-overview-title").textContent = "Room overview";
    $("#room-overview-purpose").textContent = "";
    $("#room-overview-content").replaceChildren();
    delete $("#room-overview-content")._content;
    if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
    // Restore the authored human defaults: People stays quiet until disclosed.
    for (const id of ["work-options", "connection-details", "rb-history-section", "rb-involving-section", "decision-section", "usage-panel", "people-panel"]) $(`#${id}`).open = false;
    $("#room-about").open = true;
    agentPauses = new Map(); armedRemoval = null;
    setFormStatus($("#new-work-status"), ""); setFormStatus($("#action-error"), ""); setFormStatus($("#composer-status"), ""); setFormStatus($("#room-about-status"), ""); briefReconcileNote = "";
    $("#action-dialog").close(); $("#new-work-form").hidden = true; $("#reply-bar").hidden = true;
    for (const id of ["review-criteria", "review-summary", "review-next", "decision-review-label", "decision-review-by", "decision-review-text", "decision-review-version"]) setText(`#${id}`, "");
    $("#review-brief").hidden = true; $("#review-notes").open = false;
    $("#decision-review").hidden = true; $("#decision-review").open = false;
    $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = "";
    $("#thread-title").textContent = ""; $("#thread-context").textContent = "";
    $("#thread-bar").hidden = true; $("#search-results").hidden = true; $("#new-messages-button").hidden = true;
    $("#search-mentions")?.setAttribute("aria-pressed", "false"); $("#search-pinned")?.setAttribute("aria-pressed", "false"); $("#message-search").value = ""; $("#clear-search").hidden = true;
    $("#conversation-announcement").textContent = ""; delete $("#message-list").dataset.view;
    for (const id of ["rb-attention-list", "rb-involving-list", "rb-history-list"]) delete $(`#${id}`)._content;
    $("#rb-current-boundary").textContent = ""; $("#rb-history-boundary").textContent = ""; $("#decision-count").textContent = "";
    $("#rb-ack-button").textContent = "Mark caught up"; $("#return-brief-panel").open = false;
    renderReturnBrief();
    if (keepAccount) {
      showAccountWorkspace();
      if (!["accepted-room-switch", "invited-room-switch"].includes(endedContext)) confirmAccount();
      // The room credential died while the account is still signed in: say so, and
      // say how to get back, instead of silently dropping to the room list.
      if (hadRoom && sessionExpired) { $("#account-status").textContent = uiText("room.session_ended"); $("#account-status").hidden = false; }
      return;
    }
    const openingAcceptedRoom = endedContext === "accepted-room-switch";
    const openingInvitedRoom = endedContext === "invited-room-switch";
    const switchedAccount = endedContext === "account-switch";
    setFormStatus($("#auth-error"), openingAcceptedRoom || openingInvitedRoom || $("#invitation-dialog").open ? ""
      : switchedAccount ? "The browser account changed; private Room state and drafts were cleared."
        : "Session ended; private drafts were cleared.", true);
    setConnectionStatus(openingAcceptedRoom || openingInvitedRoom ? "Opening Room…" : "Not connected");
    if ($("#invitation-dialog").open && invitation.preview) {
      if (!accountClient.session?.authenticated && ["ready", "wrong-account", "changed-account"].includes(invitation.phase)) invitation.phase = "needs-account";
      renderInvitation();
    }
    if (!pendingSignout) queueMicrotask(() => {
      if (!$("#invitation-dialog").open) focusSignin();
    });
  }
});
const ownerOffersUI = installOwnerProjectOffers({ client, getState: () => state, getSession: () => session, host: $(".room-more-actions") });
const briefView = new ReturnBrief(client, {
  onChange: renderReturnBrief,
  // A recoverable catch-up error belongs to its own status region. It does not
  // establish that the room's separate live connection has disconnected.
  onError: error => { if ([401, 403].includes(error.status)) client.handleFailure(error); },
  onReconciliationFailure: () => {
    if (!state) return;
    // Shown in the brief's own status line while catch-up is open, for the
    // same reason as the feed: a page notice sits under the dialog backdrop.
    briefReconcileNote = "Your caught-up position was saved, but the latest room view could not be refreshed. Refresh before relying on this brief.";
    if ($("#catchup-dialog")?.open) renderReturnBrief(); else notice(briefReconcileNote, true);
  }
});
// Keep secondary views off the room-entry path. Installed views retain their
// normal reset lifecycle; an import completing after reset cannot activate one.
function lazyDisclosure({ panel, load, install, onError }) {
  let view = null, flight = null, generation = 0;
  const disclosed = () => {
    if (!panel.open) return false;
    for (let ancestor = panel.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor.tagName === "DIALOG" && !ancestor.open) return false;
      if (ancestor.tagName === "DETAILS" && !ancestor.open) return false;
    }
    return true;
  };
  async function sync() {
    if (!disclosed()) return;
    if (view) { view.sync(); return; }
    if (flight) return;
    const epoch = generation;
    const pending = load();
    flight = pending;
    try {
      const module = await pending;
      if (epoch !== generation || !disclosed()) return;
      view = install(module);
      view.sync();
    } catch (error) {
      if (epoch === generation && disclosed()) onError(error);
    } finally {
      if (flight === pending) flight = null;
    }
  }
  panel.addEventListener("toggle", () => { void sync(); });
  return {
    sync,
    reset() {
      generation++;
      flight = null;
      panel.open = false;
      view?.reset();
    }
  };
}

remindersUI = installReminders({ client, getState: () => state, onSaved: text => notice(text) });
agentConnectionsUI = installAgentConnections({ client, getState: () => state });
agentInvitesUI = installAgentInvites({ client, getState: () => state, getSession: () => session });
referralBoardUI = lazyDisclosure({ panel: $("#referral-panel"),
  load: () => import("./referral-board.js"),
  install: module => module.installReferralBoard({ client, getState: () => state, getSession: () => session }),
  onError: () => notice("Could not load referrals. Close and reopen to retry.", true) });
landQueueUI = lazyDisclosure({ panel: $("#land-queue-panel"),
  load: () => import("./land-queue-board.js"),
  install: module => module.installLandQueueBoard({ client, getSession: () => session }),
  onError: () => notice("Could not load the land queue. Close and reopen to retry.", true) });
// Open-questions radar (read-only view of the server's open-questions endpoint).
openQuestionsUI = lazyDisclosure({ panel: $("#open-questions-panel"),
  load: () => import("./open-questions-ui.js"),
  install: module => module.installOpenQuestionsPanel({ client, getState: () => state, getSession: () => session }),
  onError: () => notice("Could not load open questions. Close and reopen to retry.", true) });
// Retention dashboard (read-only view of the work-claims retention endpoint).
retentionUI = lazyDisclosure({ panel: $("#retention-panel"),
  load: () => import("./retention-ui.js"),
  install: module => module.installRetentionPanel({ client, getState: () => state, getSession: () => session }),
  onError: () => notice("Could not load the retention dashboard. Close and reopen to retry.", true) });
instructionsUI = installRoomInstructions({ client, getState: () => state, onSaved: text => notice(text) });
// #662: owner "needs your attention" card (owner-gated; hidden for everyone else).
// JDOT-MEMBER-PERMS-UI begin
const ownerAttentionCard = createNeedsAttentionCard({ client, section: $("#needs-attention"), getState: () => state });
const memberPermissionsUI = installMemberPermissions({ client, getState: () => state, getSession: () => session });
// JDOT-MEMBER-PERMS-UI end
// UPDATES HOOK (U batch). Palette Catch up, Activity, Mentions, and Saved for
// later open this destination with the matching filter. Room UI v2 removes
// the old entries later. The badge counts actionable updates only.
// JDOT-COH-NAV begin
updatesUi = mountUpdates({ client, host: document.querySelector(".room-main"), getContext: workNavigationContext,
  onOpenWork: (id, origin) => navigateWorkRecord("work", id, { type: "updates", updates: origin }),
  onOpenMessage: (id, origin) => navigateWorkRecord("message", id, { type: "updates", updates: origin }) });
// JDOT-COH-NAV end
portableWorkUI = installPortableWork({ client, getState: () => state, onSaved: messageId => {
  const visible = conversation?.byId.has(messageId);
  if (visible) revealMessage(messageId);
  notice(visible ? "Draft posted. Work status is unchanged." : "Draft posted. Refresh to view it. Work status is unchanged.");
} });
resultCopyUI = installResultCopy({ client, getState: () => state });
inboxUI = installInbox({ account: accountClient, room: client, getRoom: () => state, onOpenWork: id => revealWork(id),
  onAccountEnded: endAccountAccess, onRooms: () => loadAccountRooms(),
  onNavigate: () => { if (!$("#status").classList.contains("error")) clearNotice(); },
  onShared: async (receipt, isCurrent) => {
  try { await client.refresh(); if (state && isCurrent()) revealMessage(receipt.messageId); }
  catch { if (isCurrent()) notice("Shared. Refresh the room to view it.", true); }
} });
let accountCheckFlight = null, roomListVersion = 0, roomListCursor = null;
// Account-session restore flight: declared before the sign-in UI mounts.
// The magic-link auto-redeem runs synchronously during mount (page load
// with ?magic=), so ensureAccountSession must not sit in the temporal dead
// zone below — a TDZ ReferenceError here silently broke one-tap sign-in
// (RC-2026-09-19-066): the redeem failed before any network call and the
// user was left on the welcome screen.
let accountRestoreFlight = null;
let humanAuthBusy = false;
let signinView = "password-login", signinHistoryReplay = false, resetJourneyPending = false;
let resumeResetJourney = false;
function ensureAccountSession() {
  if (accountClient.session) return Promise.resolve(accountClient.session);
  if (accountRestoreFlight) return accountRestoreFlight;
  accountRestoreFlight = accountClient.restore().finally(() => { accountRestoreFlight = null; });
  return accountRestoreFlight;
}
// Sign-in & security settings (slice 7): mounted inside the account rooms
// panel's <details>, opened from the session menu.
const accountSettingsUI = createAccountSettingsUI({
  accountClient,
  onAccountDeleted: async () => {
    try { await client.logout(); } catch { /* deletion already ended the account session */ }
    location.assign("/?account-deleted=1");
  }
});
const profileSettingsUI = createAccountSettingsUI({ accountClient, profileOnly: true,
  onProfileSaved: () => $("#account-profile-dialog").close() });
$("#account-profile-button").textContent = uiText("profile.title");
$("#account-profile-title").textContent = uiText("profile.title");
$("#account-profile-close").textContent = uiText("profile.close");
// Multi-method sign-in / create-account (slice 7): mounts into the auth
// panel next to the Google button. After a
// browser sign-in the cookie changed, so restore the in-memory session and
// restore the account and continue the current invitation or room.
const signinUI = createAuthSigninUI({
  accountClient,
  ensureAccountSession,
  onViewChange: syncSigninView,
  onBack: handleSigninBack,
  onPasswordResetComplete: async () => {
    endAccountAccess();
    clearPrivateWorkspace();
    await accountClient.restore();
    const deferred = resetJourneyPending;
    resetJourneyPending = false;
    if (deferred && (initialInvitationFragment || initialJoinFragment)) resumeResetJourney = true;
    else if (invitation.secret) renderInvitation();
    else if (shareLinksUI.pendingFragment()) await shareLinksUI.resumeSignedIn();
    else { showSigninMethods(); $("#auth-panel").hidden = false; }
  },
  onBusyChange: value => {
    humanAuthBusy = value;
    shareLinksUI?.syncAccountSigninBusy();
    if (!value && resumeResetJourney) {
      resumeResetJourney = false;
      queueMicrotask(() => {
        if (initialInvitationFragment && !initialInvitationFragment.redirect) openInvitation(initialInvitationFragment);
        else shareLinksUI.open(initialJoinFragment);
      });
    }
    if (invitation.secret) {
      renderInvitation();
      if (!value && invitation.phase === "ready" && $("#invitation-methods").hidden
        && !$("#invitation-accept").hidden && !$("#invitation-accept").disabled) $("#invitation-accept").focus();
    }
  },
  beforeSignIn: () => !$("#invitation-methods").contains($("#auth-signin-ui")) || confirmInvitationSignin(),
  onAccountSwitch: () => window.confirm("Switch accounts? This clears unsent drafts and private setup."),
  onMagicLinkRequest: () => {
    const destination = new URL(location.href);
    destination.pathname = "/";
    destination.search = "";
    const roomId = selectedRoomFromLocation();
    if (roomId) destination.searchParams.set("room", roomId);
    else if (accountHomeFromLocation()) destination.searchParams.set("account", "1");
    destination.hash = invitation.secret ? `#invite/${invitation.secret}` : (shareLinksUI?.pendingFragment() || "");
    return `${destination.pathname}${destination.search}${destination.hash}`;
  },
  onSignInUncertain: async () => {
    endAccountAccess();
    clearPrivateWorkspace();
    await accountClient.restore();
    if (accountClient.session?.authenticated) showAccountWorkspace();
    if (invitation.secret) renderInvitation();
  },
  // Keep failed emailed-link redemption visible when opening the email step.
  onMagicLinkFailure: message => {
    if (invitation.secret) { $("#invitation-email").click(); signinUI.showMagic(); }
    else openEmailAuth("magic", { recordHistory: false });
    setFormStatus($("#auth-link-error"),
      `${message} Request a new link or continue with Google.`, true);
  },
  onSignedIn: async () => {
    const restoration = accountClient.restore();
    const restoreGeneration = accountClient.generation;
    try {
      const restored = await restoration;
      if (restoreGeneration !== accountClient.generation) return;
      if (!restored?.authenticated) throw new Error("Sign-in could not be confirmed. Try again.");
    } catch (error) {
      if (restoreGeneration !== accountClient.generation) return;
      endAccountAccess();
      clearPrivateWorkspace();
      if (invitation.secret) renderInvitation();
      throw error;
    }
    if (invitation.secret) {
      accessEndContext = "account-switch";
      client.endAccess();
      clearPrivateWorkspace();
      showAccountWorkspace();
      if (!invitation.secret) return;
      invitation.phase = "ready";
      setInvitationFeedback("Review the invitation before joining.");
      restoreInvitationSignin();
      renderInvitation();
      $("#invitation-accept").focus();
      return;
    }
    if (initialJoinFragment && !shareLinksUI?.pendingFragment()) return;
    if (await shareLinksUI?.resumeSignedIn()) return;
    await landAfterSignIn();
  }
});
const initialAuthLink = classifyAuthLink(new URLSearchParams(location.search));
const initialPasswordReset = initialAuthLink.kind === "reset";
if (initialAuthLink.kind === "none" && !initialGoogleFailed) signinUI.showPassword();
const initialSignin = signinUI.mount($("#auth-signin-ui"));

// Agent sign-in (RC-2026-09-23): agents choose their own account (identity
// ID + secret) or fall back to human account sign-in. On success the room
// cookie is set, so restore the client session for that room.
const agentSigninUI = createAgentSigninUI({
  onSignedIn: async (session) => {
    const roomId = session?.roomId;
    if (!roomId) return;
    // Agent sign-in creates a room cookie, not a human account session.
    const identity = await client.restore();
    if (!identity || identity.roomId !== roomId || !state) return;
    $("#message-input").focus();
    if (state) revealLocationHash();
  },
  // Agent first-run orientation (2026-09-24): the card mounts itself after
  // an agent browser sign-in and only when the browser hasn't seen it.
  // greet focuses the composer so the agent can introduce itself; discover
  // opens the People panel; the card's skill step links /agents.json.
  firstRunActions: {
    greet: () => $("#message-input")?.focus(),
    discover: () => { const panel = $("#people-panel"); if (panel) panel.open = true; },
    baseUrl: location.origin
  }
});
agentSigninUI.mount($("#agent-signin-ui"));
function openAccountSettings() {
  setSessionMenuOpen(false);
  if (!accountClient.session?.authenticated) return;
  inboxUI.showRoomList();
  const details = $("#account-settings");
  details.open = true;
  accountSettingsUI.mount($("#account-settings-body"));
  details.scrollIntoView({ block: "nearest" });
}
function clearPrivateWorkspace(options) {
  $("#account-profile-dialog").close(); profileSettingsUI.reset();
  inboxUI?.reset(options); roomListVersion++;
  $("#account-rooms-list").replaceChildren(); $("#account-rooms-status").textContent = "";
  $("#account-status").textContent = ""; $("#account-status").hidden = true;
  $("#account-settings").open = false; $("#account-settings-body").replaceChildren();
}
function endAccountAccess() {
  const current = accountClient.session;
  if (current) accountClient.invalidate(accountClient.generation, current);
  $(".connection-bar").hidden = false;
  accessEndContext = "account-switch"; client.endAccess();
  configureAuthPanel();
}
function rememberedRoomId() {
  const accountId = accountClient.session?.account?.id;
  const fromAccount = accountId ? readMemberRoom(accountId)?.roomId : null;
  if (fromAccount) return fromAccount;
  const memberId = session?.member?.id;
  return (memberId ? readMemberRoom(memberId)?.roomId : null) || readLastRoom();
}
function showRoomAccessNotice() {
  const status = $("#account-status");
  if (!status) return;
  status.textContent = ROOM_ACCESS_NOTICE;
  status.hidden = false;
}
async function openRememberedRoomOrInbox() {
  const roomId = rememberedRoomId();
  if (!roomId) { showAccountWorkspace(); return false; }
  try {
    history.replaceState(history.state, "", roomHandoffLocation(roomId));
    configureAuthPanel(roomId);
    const identity = await client.restore(roomId);
    if (!identity || !state) throw Object.assign(new Error("Room unavailable"), { status: 403 });
    return true;
  } catch (error) {
    if (![401, 403].includes(error.status)) throw error;
    history.replaceState(history.state, "", `${location.pathname}?account=1`);
    showAccountWorkspace();
    return false;
  }
}
// --- Q3-C: signup with no chosen room opens that account's room. ---
async function openPersonalRoomAfterSignup() {
  const owned = accountClient.session;
  // /?start=room already asks for the name and then creates the room.
  // A second create here would make the room while that dialog is still open.
  if (startRoomIntent || startRoomFlight) {
    showAccountWorkspace();
    if (startRoomFlight) await startRoomFlight;
    return;
  }
  showAccountWorkspace();
  if (accountClient.session !== owned || state) return;
  const body = await ensureDefaultRoom();
  if (accountClient.session !== owned || state) return;
  const roomId = body?.room?.id;
  if (!roomId) { showAccountWorkspace(); return; }
  history.replaceState(null, "", roomHandoffLocation(roomId));
  try { await client.restore(roomId); inboxUI.showRooms(); inboxUI.refreshSetup?.(); }
  catch { if (accountClient.session === owned && !state) showAccountWorkspace(); }
}
// --- end Q3-C ---
async function landAfterSignIn() {
  if (resumeOAuthConsent()) return;
  const target = signInRoomTarget({
    nextRoom: roomIdFromNext(new URLSearchParams(location.search).get("next")),
    deepLinkRoom: roomFromLocation({ search: location.search, hash: location.hash }),
    rememberedRoom: rememberedRoomId()
  });
  if (!target.explicit) {
    if (target.roomId) await openRememberedRoomOrInbox();
    // ?account=1 is the inbox. A sign-in with no room and no account home
    // opens that account's room after the name step.
    else if (accountHomeFromLocation()) showAccountWorkspace();
    else await openPersonalRoomAfterSignup();
    return;
  }
  try {
    const identity = await client.restore(target.roomId);
    if (!identity || !state || session?.member.id !== identity.member.id || session?.roomId !== identity.roomId) {
      showAccountWorkspace();
      showRoomAccessNotice();
      return;
    }
    $("#message-input").focus();
    if (state) revealLocationHash();
  } catch (error) {
    if ([401, 403].includes(error.status)) {
      showAccountWorkspace();
      showRoomAccessNotice();
      return;
    }
    setFormStatus($("#auth-error"), unreachableRoomMessage(error), true);
  }
}
let startRoomFlight = null;
function showAccountWorkspace() {
  if (!accountClient.session?.authenticated) return;
  if (resumeOAuthConsent()) return;
  if (accountClient.session.terms?.required) {
    $("#main").hidden = true;
    $("#auth-panel").hidden = false;
    $("#signin-methods").hidden = false;
    $("#email-auth-step").hidden = true;
    $("#signin-controller").prepend($("#auth-signin-ui"));
    signinUI.requireTerms(accountClient.session);
    return;
  }
  rememberAccountHint();
  $("#auth-panel").hidden = true; $("#signout-button").hidden = false; $("#signout-button").disabled = signoutLoading;
  $("#account-settings-button").hidden = false;
  syncSessionMenu();
  if (!state) {
    $("#identity-label").textContent = "Personal account";
    $("#identity-label").title = accountClient.session.account.id;
    setConnectionStatus("Room not open");
    $(".connection-bar").hidden = true;
  }
  inboxUI.sync();
  if (!state && startRoomIntent && !initialInvitationFragment && !initialJoinFragment && consumeStartRoomIntent()) {
    startRoomFlight = openStartedRoom().finally(() => { startRoomFlight = null; });
    return;
  }
  // --- GR2 ---
  if (!state && !startRoomFlight && readAcquisition() && !initialInvitationFragment && !initialJoinFragment) {
    startRoomFlight = runAcquisitionIntent().finally(() => { startRoomFlight = null; });
    return;
  }
  // --- end GR2 ---
  if (!state) {
    if (["#pr-view/rooms", "#pr-view/room-list"].includes(location.hash)) inboxUI.showRoomList();
    else inboxUI.open();
  }
}
async function openStartedRoom() {
  const owned = accountClient.session;
  try { await inboxUI.askSetupName?.(); } catch { /* setup is optional; the room still opens */ }
  if (accountClient.session !== owned || state) return;
  const body = await ensureDefaultRoom();
  if (accountClient.session !== owned || state) return;
  const roomId = body?.room?.id;
  if (!roomId) { inboxUI.open(); return; }
  history.replaceState(null, "", roomHandoffLocation(roomId));
  try { await client.restore(roomId); inboxUI.showRooms(); inboxUI.refreshSetup?.(); }
  catch { if (accountClient.session === owned && !state) { inboxUI.showRoomList(); $("#account-rooms-status").textContent = "Couldn’t open your room. Choose it below."; } }
}
async function confirmAccount() {
  if (accountCheckFlight || !accountClient.session?.authenticated || signoutLoading || invitationIsCommitting() || leavingPage) return accountCheckFlight;
  const owned = accountClient.session;
  accountCheckFlight = (async () => {
    try {
      const confirmed = await accountClient.confirm();
      if (confirmed === false && accountClient.session === null) endAccountAccess();
      else if (confirmed && $("#account-status").textContent === "Couldn’t confirm account. Refresh to retry.") {
        $("#account-status").textContent = ""; $("#account-status").hidden = true;
      }
      return confirmed;
    } catch {
      if (accountClient.session === owned) { $("#account-status").textContent = "Couldn’t confirm account. Refresh to retry."; $("#account-status").hidden = false; }
      return null;
    }
  })().finally(() => { accountCheckFlight = null; });
  return accountCheckFlight;
}
async function loadAccountRooms(more = false) {
  const version = ++roomListVersion, owned = accountClient.session;
  if (!owned?.authenticated) return;
  if (!more) { roomListCursor = null; $("#account-rooms-list").replaceChildren(); }
  $("#account-rooms-more").hidden = true; $("#account-rooms-status").textContent = "Loading…";
  try {
    const value = await accountClient.rooms(more ? roomListCursor : null);
    if (version !== roomListVersion || accountClient.session !== owned || !value) return;
    for (const room of value.rooms) {
      const button = document.createElement("button"); button.type = "button"; button.className = "inbox-row";
      button.dataset.accountRoom = room.id;
      // Issue #6 A2: an archived room is never presented as a working room; it
      // opens read only (reading and export stay) and says so before the click.
      const archived = room.archived === true;
      button.dataset.roomArchived = archived ? "true" : "false";
      const title = typeof room.title === "string" ? room.title.trim() : "";
      const named = title && title !== room.id;
      const heading = document.createElement("strong");
      heading.textContent = named ? title : room.id;
      const meta = document.createElement("small");
      meta.className = "inbox-row-kind";
      meta.textContent = roomKindLabel(room.kind) + (archived ? " · Archived" : "");
      const action = document.createElement("span");
      action.textContent = archived ? "Read only" : "Open";
      button.append(heading, meta, action);
      button.setAttribute("aria-label", `${archived ? "Read archived room" : "Open"} ${named ? title : room.id}`);
      button.addEventListener("click", () => openAccountRoom(room.id)); $("#account-rooms-list").append(button);
    }
    roomListCursor = value.nextCursor; $("#account-rooms-more").hidden = !roomListCursor;
    $("#account-rooms-status").textContent = $("#account-rooms-list").children.length ? "" : roomListCursor ? "No available rooms on this page." : "No rooms yet.";
    // RC-2026-09-19-088: first sign-in must never land in an empty void. A
    // fresh account with no rooms and no pending invitation gets its default
    // room created and opened.
    if (!more && !$("#account-rooms-list").children.length && !roomListCursor
      && !startRoomIntent && !startRoomFlight) nameThenEnsureDefaultRoom();
  } catch (error) {
    if (version !== roomListVersion || (accountClient.session && accountClient.session !== owned)) return;
    if ([401, 403].includes(error.status) || !accountClient.session) endAccountAccess();
    else $("#account-rooms-status").textContent = "Couldn’t load rooms. Choose Rooms to retry.";
  }
}
// RC-2026-09-19-088: ensure a fresh account's default room. Never runs when an
// invitation is being redeemed — the invite flow owns the landing. Idempotent
// server-side; a second call returns the existing room.
let defaultRoomFlight = null;
const nameThenEnsureDefaultRoom = nameBeforeFirstRoom({
  askName: () => inboxUI.askSetupName?.(), ensure: () => ensureDefaultRoom(), session: () => accountClient.session });
async function ensureDefaultRoom() {
  if (defaultRoomFlight) return defaultRoomFlight;
  // Never create a default room when entering through an invitation or a
  // shared join link — those flows own the landing.
  if (initialInvitationFragment || initialJoinFragment || invitation.secret) return null;
  const owned = accountClient.session;
  if (!owned?.authenticated) return null;
  defaultRoomFlight = (async () => {
    try {
      $("#account-rooms-status").textContent = "Setting up your first room…";
      const body = await accountClient.request("/api/account/ensure-default-room", { method: "POST", data: {}, session: owned });
      if (accountClient.session !== owned) return null;
      // Refresh the list to show the new room (or the existing one).
      if (body?.room?.id) await loadAccountRooms();
      else $("#account-rooms-status").textContent = FIRST_ROOM_SETUP_FAILURE;
      return body;
    } catch {
      if (accountClient.session === owned) $("#account-rooms-status").textContent = FIRST_ROOM_SETUP_FAILURE;
      return null;
    } finally { defaultRoomFlight = null; }
  })();
  return defaultRoomFlight;
}
async function openAccountRoom(roomId) {
  if (invitationIsCommitting() || signoutLoading) return;
  if (state) saveComposer();
  if (state && (drafts.hasText() || pendingAction || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending()
      || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || ownerOffersUI?.hasPending() || !$("#new-work-form").hidden)
      && !window.confirm("Switch rooms and clear unsent room drafts and pending retries? Saved work stays.")) return;
  const owned = accountClient.session;
  if (await confirmAccount() !== true || accountClient.session !== owned) return;
  accessEndContext = "accepted-room-switch"; client.endAccess();
  history.replaceState(null, "", "?room=" + encodeURIComponent(roomId) + "#pr-view/rooms");
  try { await client.restore(roomId); }
  catch {
    if (accountClient.session !== owned) return;
    showAccountWorkspace(); inboxUI.showRoomList();
    $("#account-rooms-status").textContent = "Couldn’t open that room. Refresh rooms to retry.";
  }
}
// Issue #6 A2: room lifecycle — create (account home), archive (owner), leave (member).
const roomKindLabel = kind => (kind === "organization" ? "Organization" : "Personal");
function syncRoomLifecycle() {
  const room = state?.room ?? null, viewer = state && session ? state.members[session.member.id] : null;
  const archived = Boolean(state) && isRoomArchived(state);
  const badge = $("#room-kind-badge");
  badge.textContent = room ? roomKindLabel(roomKind(room)) : ""; badge.hidden = !room;
  const note = $("#room-archived-note");
  note.hidden = !archived;
  note.textContent = archived ? `Archived ${new Date(room.archivedAt).toLocaleString()}${room.archivedById ? ` by ${displayName(room.archivedById)}` : ""} · read only. Reading and export stay available; nothing new is recorded.` : "";
  $("#main").classList.toggle("room-archived", archived); // The composer and New work follow in syncRequestComposer and render.
  const owner = Boolean(viewer) && viewer.kind === "human" && viewer.id === room?.ownerId;
  $("#room-archive-button").hidden = !viewer || archived || !owner;
  $("#room-leave-button").hidden = !viewer || archived || owner || viewer.kind !== "human";
}
$("#room-archive-button").addEventListener("click", async () => {
  if (!state || !session || busy) return;
  if (!window.confirm("Archive this room? Everyone keeps reading and export; nothing new can be recorded, and this cannot be undone here.")) return;
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id, button = $("#room-archive-button");
  button.disabled = true; setFormStatus($("#room-about-status"), "");
  try {
    await client.send({ id: crypto.randomUUID(), type: T.ROOM_ARCHIVED, data: {} });
    if (sameSession(generation, roomId, memberId)) {
      // Everything this changed is outside the dialog the button lives in: the
      // read-only note in the room chrome, the composer, the switcher. Leaving
      // the modal up hides its own result behind itself.
      if ($("#settings-dialog")?.open) $("#settings-dialog").close();
      notice("Room archived. It is read only now; export stays available.");
    }
  } catch (error) {
    if (!sameSession(generation, roomId, memberId)) return;
    dialogNotice("#room-about-status", error.code === "room_archived" ? "This room is already archived." : "Couldn’t archive the room. Refresh and try again.", true);
  } finally { button.disabled = false; }
});
$("#room-leave-button").addEventListener("click", async () => {
  if (!state || !session || busy) return;
  const member = state.members[session.member.id];
  if (!member || member.active === false) return;
  if (!window.confirm("Leave this room? You lose access to it and need a new invitation to return. Your messages stay in the room.")) return;
  const generation = client.generation, roomId = session.roomId, button = $("#room-leave-button");
  button.disabled = true; setFormStatus($("#room-about-status"), "");
  try {
    await client.send({ id: crypto.randomUUID(), type: T.MEMBER_ACCESS_CHANGED,
      data: { memberId: member.id, expectedMemberRevision: member.revision, permissions: [...member.permissions], active: false } });
    // Same reason as archiving: access to this room has ended, and what the
    // member sees next is the account's room list, not this dialog.
    if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  } catch (error) {
    if (!sameSession(generation, roomId, member.id)) return;
    dialogNotice("#room-about-status", error.code === "room_archived" ? "This room is archived; leaving is not recorded." : "Couldn’t leave the room. Refresh and try again.", true);
  } finally { button.disabled = false; }
});
$("#account-room-form").addEventListener("submit", async event => {
  event.preventDefault();
  const form = $("#account-room-form"), status = $("#account-room-status"), owned = accountClient.session;
  if (!owned?.authenticated || form.dataset.busy === "true" || invitationIsCommitting() || signoutLoading) return;
  const title = $("#account-room-title").value.trim(), purpose = $("#account-room-purpose").value.trim(), displayName = $("#account-room-name").value.trim();
  const kind = $("#account-room-kind").value;
  if (!title || !purpose || !displayName) { setFormStatus(status, "Room name, purpose and your name are required.", true); return; }
  // One id per attempt: a retry after a lost response finds the same room instead of creating a twin.
  const roomId = form.dataset.roomId || (form.dataset.roomId = "room-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12));
  // --- GR2: a chosen template uses the same room id and the same retry. ---
  const template = $("#account-room-template")?.value || "";
  const ref = receiptReferrer();
  // --- end GR2 ---
  form.dataset.busy = "true"; $("#account-room-submit").disabled = true; setFormStatus(status, "Creating…");
  try {
    const session = accountClient.currentSession("creating a room", { authenticated: true });
    const result = template
      ? await accountClient.request("/api/account-rooms/from-template", { method: "POST", data: { roomId, template, title, purpose, kind, displayName, ...(ref ? { ref } : {}) }, session })
      : await accountClient.request("/api/account-rooms", { method: "POST", data: { roomId, title, purpose, kind, displayName }, session });
    if (accountClient.session !== owned) return;
    delete form.dataset.roomId; form.reset(); setFormStatus(status, ""); $("#account-room-create").open = false;
    await openAccountRoom(result.room.id);
  } catch (error) {
    if (accountClient.session !== owned) return;
    if (error.status === 401 || ["session_binding_changed", "account_session_required"].includes(error.code)) { endAccountAccess(); return; }
    if (error.code === "room_exists") delete form.dataset.roomId; // A lost response created it under another shape; the next attempt gets a fresh id.
    setFormStatus(status, error.code === "room_creation_denied" ? "Your first room is free to create, but more rooms need membership administration in one of your rooms."
      : error.code === "room_exists" ? "A room with that id already exists. Choose Rooms to refresh, then try again."
      : error.status === 429 ? "Too many rooms just now. Try again in a minute."
        : error.status === 422 ? "Check the room name, purpose and your name." : "Couldn’t create the room. Try again.", true);
  } finally { delete form.dataset.busy; $("#account-room-submit").disabled = false; }
});
$("#choose-room").addEventListener("click", () => inboxUI.showRoomList(true));
$("#account-rooms-more").addEventListener("click", () => loadAccountRooms(true));
window.addEventListener("focus", () => confirmAccount());
document.addEventListener("visibilitychange", () => { if (!document.hidden) confirmAccount(); });
setInterval(() => { if (!document.hidden) confirmAccount(); }, 5000);
const esc = value => String(value ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
// plan-dir-card: render a directory card inside the member chip's profile.
// owns[] and reach{} are host-supplied from live data (never fabricated);
// provenance tells a seeded placeholder from a self-published card.
function renderDirectoryCard(card) {
  if (!card || typeof card !== "object") return uiText("directory.card.copy.001");
  const reach = card.reach && typeof card.reach === "object" ? card.reach : null;
  const reachLine = reach
    ? `Wake ${reach.wakeMode ?? "unknown"}`
      + `${reach.lastPollAt ? ` · last poll ${new Date(reach.lastPollAt).toLocaleString()}` : ""}`
      + ` · ${reach.pendingUnacked ?? 0} unacked`
      + ` · bonds ${reach.bondStatus ?? "unknown"}`
      + `${reach.host ? ` · host ${reach.host}` : ""}`
    : uiText("directory.card.copy.002");
  const owns = Array.isArray(card.owns) && card.owns.length ? card.owns.join(", ") : "—";
  const provenance = card.provenance === "seeded"
    ? `<span class="card-provenance card-provenance-seeded" title="Seeded by the room owner from live room data; the agent has not published a card yet">Seeded</span>`
    : `<span class="card-provenance card-provenance-self">Self-published</span>`;
  return ["<div class=\"member-card-badges\">", provenance, "<span class=\"card-visibility\">", esc(card.visibility), "</span></div>"].join('')
    + `<p><strong>${esc(card.name)}</strong></p>`
    + (card.description ? `<p class="form-hint">${esc(card.description)}</p>` : "")
    + `<p>Capabilities: ${esc((card.capabilities ?? []).join(", ") || "—")}</p>`
    + `<p>Owns: ${esc(owns)}</p>`
    + `<p class="form-hint">${esc(reachLine)}</p>`;
}
const humanize = value => String(value).replaceAll("_", " ").replaceAll(".", " ");
const memberLabel = id => id == null ? "Unassigned" : state.members[id] ? ["", state.members[id].displayName, " (", id, ")"].join('') : `Unknown member (${id})`;
// Keep ordinary conversation readable; exact IDs remain in details and decision
// controls. Duplicate names retain the full ID so attribution stays unambiguous.
let displayNames = createMemberDisplayNames({});
const displayName = id => humanExperience?.assistantName(id) || displayNames(id);
const name = displayName; // Ordinary summaries use the same duplicate-aware attribution as authors.
const can = capability => state?.members[session?.member.id]?.permissions.includes(capability);
const sameSession = (generation, roomId, memberId) => generation === client.generation && state
  && session?.roomId === roomId && session?.member.id === memberId;
// First letter or digit of each word, so "Maya (tester)" is "MT", not "M(".
const initials = text => esc(String(text ?? "").split(/\s+/).map(w => w.match(/[\p{L}\p{N}]/u)?.[0] ?? "").join("").slice(0, 2).toUpperCase() || "?");
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const time = value => timeFormat.format(new Date(value));
function safeUrl(value) { try { const u = new URL(value); return u.protocol === "https:" ? esc(u.href) : "#"; } catch { return "#"; } }
const recordDomId = (kind, id) => `pr-${kind}-record-${[...String(id)].map(character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
// Keep application-owned fragments outside the valid record-id alphabet. Earlier
// `#work-${id}` links were ambiguous with legacy raw work ids such as `work-123`.
const recordHref = (kind, id) => `#pr-record/${kind}/${encodeURIComponent(id)}`;
const workDomId = id => recordDomId("work", id);
const workHref = id => recordHref("work", id);
function setConnectionStatus(text) {
  const normalized = /^(Reconnecting|Connection interrupted)/.test(text)
    ? "Connection interrupted · reconnecting; displayed history may be stale"
    : text;
  const status = $("#connection-status");
  const connected = normalized === "Connected to room service · no peer read or processing receipt";
  const visible = connected ? "Connected" : normalized;
  status.dataset.state = connected ? "connected"
    : /^Not connected · (account )?sign.in required$/.test(normalized) ? "signed-out" : "other";
  if (status.textContent !== visible) status.textContent = visible;
  $("#connection-explanation").textContent = normalized;
}
function setFormStatus(status, text, error = false) {
  if (status.textContent === text && status.classList.contains("visible") === Boolean(text)
    && status.classList.contains("error") === (Boolean(text) && error)) return;
  status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text) && error);
}
function composerOverLimit() { return $("#message-input").value.length > MAX_MESSAGE_BODY_CHARS; }
function renderComposerLength() {
  const input = $("#message-input"), over = composerOverLimit();
  const limit = new Intl.NumberFormat("en-US").format(MAX_MESSAGE_BODY_CHARS);
  const message = over ? `Message is too long. Shorten it to ${limit} characters or fewer; emoji may count as two. Your draft has not been shortened.` : "";
  input.setCustomValidity(message);
  if (over) input.setAttribute("aria-invalid", "true"); else input.removeAttribute("aria-invalid");
  const status = $("#message-length-status");
  status.hidden = !over; setFormStatus(status, message, over);
}
function renderComposerError() {
  renderComposerLength();
  const text = drafts.get(composerKey()).error;
  const status = $("#composer-status");
  if (status.textContent !== text) status.textContent = text;
  status.classList.toggle("visible", Boolean(text));
  status.classList.toggle("error", Boolean(text));
}
function setComposerError(text) {
  drafts.save(composerKey(), { error: text });
  renderComposerError();
}
const noticeText = () => $("#status").querySelector(".status-text")?.textContent ?? $("#status").textContent;
function resetNotice(status) {
  status.replaceChildren();
  status.classList.remove("visible", "error");
  // One live region: polite status for successes, alert for errors (set before text lands).
  status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
}
function clearNotice() {
  noticeVersion += 1;
  clearTimeout(noticeTimer);
  noticeTimer = null;
  resetNotice($("#status"));
}
// A notice raised from inside an open modal dialog is painted under that
// dialog's backdrop: #status is fixed-position in the page, and a showModal()
// dialog sits in the top layer above everything in the page. So a failure
// from a button in a dialog looked like the click did nothing. Report it in
// the dialog's own status region while the dialog is open, and fall back to
// the page notice when it is not.
function dialogNotice(statusSelector, text, error = false) {
  const status = $(statusSelector);
  if (status?.closest("dialog")?.open) setFormStatus(status, text, error);
  else notice(text, error);
}
function notice(text, error = false) {
  const status = $("#status"), version = ++noticeVersion;
  clearTimeout(noticeTimer); noticeTimer = null;
  const show = () => {
    if (version !== noticeVersion) return;
    status.setAttribute("role", error ? "alert" : "status");
    status.setAttribute("aria-live", error ? "assertive" : "polite");
    const body = document.createElement("span");
    body.className = "status-text"; body.textContent = text;
    status.replaceChildren(body);
    if (error) {
      // Errors stay until dismissed or replaced so they can be read, selected and copied.
      const dismiss = document.createElement("button");
      dismiss.type = "button"; dismiss.className = "status-dismiss";
      dismiss.textContent = "Dismiss"; dismiss.setAttribute("aria-label", "Dismiss error");
      dismiss.addEventListener("click", () => { if (version === noticeVersion) clearNotice(); });
      status.append(dismiss);
    }
    status.classList.add("visible");
    status.classList.toggle("error", error);
    if (!error) noticeTimer = setTimeout(() => { if (version === noticeVersion) resetNotice(status); }, 6000);
  };
  // Repeated successful actions still deserve one fresh status announcement each.
  if (noticeText() === text) { status.replaceChildren(); queueMicrotask(show); }
  else show();
}
function handleFailureNotice(error) {
  client.handleFailure(error);
  if (state) notice(requestFailureMessage(error), true);
}
// Signed-out load failures: a service outage (5xx) reads differently from a
// browser that cannot reach the service at all (network error, no status).
function unreachableRoomMessage(error) {
  return error?.status >= 500 ? "The room service is unavailable right now. Try refreshing in a moment."
    : "Can’t reach the room. Check your connection, then try refreshing.";
}
function sameAccountTuple(left, right) {
  return Boolean(left?.account && right?.account)
    && left.account.id === right.account.id
    && left.account.authEpoch === right.account.authEpoch
    && left.sessionRevision === right.sessionRevision
    && left.sessionBinding === right.sessionBinding;
}
function currentInvitation(version, secret) {
  return invitation.version === version && invitation.secret === secret && $("#invitation-dialog").open;
}
function setInvitationFeedback(text, error = false) {
  $("#invitation-status").textContent = error ? "" : text;
  $("#invitation-error").textContent = error ? text : "";
  if (error && text) {
    const version = invitation.version;
    queueMicrotask(() => {
      if (version !== invitation.version || !$("#invitation-dialog").open || $("#invitation-error").textContent !== text) return;
      const usable = element => !element.disabled && element.getClientRects().length > 0;
      const target = [$("#invitation-email"), $("#invitation-accept"), $("#invitation-retry"), $("#invitation-dismiss")].find(usable) ?? $("#invitation-title");
      target.focus({ preventScroll: false });
    });
  }
}
function roomHandoffLocation(roomId) {
  // In-app navigation keeps the historical ?room= contract. Door Open/People
  // already attach both ?room= and #room/ so hash-dropping browsers survive.
  return `${location.pathname}?room=${encodeURIComponent(roomId)}`;
}
function configureAuthPanel(roomId = selectedRoomFromLocation()) {
  $("#auth-title").textContent = "PROJECT ROOM";
  // Fresh auth paint clears any stale magic-link failure banner (QAX-002).
  setFormStatus($("#auth-link-error"), "");
  const roomHint = $("#auth-room-hint");
  if (roomHint) {
    roomHint.hidden = !startRoomIntent;
    roomHint.textContent = startRoomIntent ? "Sign in to start your room. It’s free." : "";
  }
  syncSessionMenu();
}
function syncSessionMenu() {
  $("#account-profile-button").hidden = !accountClient.session?.authenticated;
  const menu = $("#session-menu");
  const signedIn = Boolean(state || accountClient.session?.authenticated);
  const leftovers = Boolean(readLastRoom() || readAccountHint());
  const clearBtn = $("#clear-session-menu");
  if (clearBtn) clearBtn.hidden = signedIn || !leftovers;
  menu?.classList.toggle("empty", !signedIn && !leftovers);
  // Genuine session-expiration display: the server stamps every browser
  // session's real expiry (sessionView.expiresAt / accountView.expiresAt).
  // The room session gates the current view, so it wins; the account session
  // shows only when the account workspace is open with no room.
  const expiryEl = $("#session-expiry");
  if (expiryEl) {
    const roomExpiry = client.session?.expiresAt ?? null;
    const accountExpiry = !state && accountClient.session?.authenticated ? accountClient.session.expiresAt : null;
    const formatted = signedIn ? formatSessionExpiry(roomExpiry ?? accountExpiry) : null;
    if (formatted) {
      expiryEl.textContent = `${roomExpiry != null ? "Session" : "Account session"} expires ${formatted}`;
      expiryEl.hidden = false;
    } else {
      expiryEl.textContent = "";
      expiryEl.hidden = true;
    }
  }
}
async function clearSavedBrowserSession() {
  if (signoutLoading || busy) return;
  clearBrowserSessionHints();
  if (accountClient.session) {
    try { await accountClient.logout(); } catch { /* slot may already be anonymous */ }
    endAccountAccess();
  }
  syncSessionMenu();
  setFormStatus($("#auth-error"), "Saved session on this browser was cleared.", true);
}
function maybeShowGuestUpgradeHint() {
  // One-time hint for guests after their first message: surface the
  // account-upgrade path at the moment they've gotten value.
  try {
    if (localStorage.getItem("pr-guest-upgrade-hint-seen") === "1") return;
  } catch { return; }
  // Don't show while the account session is still loading: an authenticated
  // user looks like a guest until restore() completes, and flashing the hint
  // for them is wrong (it also broke the quiet-design large-text layout check
  // in CI by squeezing #message-list).
  if (!accountClient.session) return;
  const hasAccount = Boolean(accountClient.session.authenticated && accountClient.session.account);
  if (hasAccount || !state || !session?.member) return;
  const hint = $("#guest-upgrade-hint");
  if (!hint) return;
  $("#guest-upgrade-name").textContent = displayName(session.member.id);
  hint.hidden = false;
  try { localStorage.setItem("pr-guest-upgrade-hint-seen", "1"); } catch {}
}
$("#guest-upgrade-dismiss")?.addEventListener("click", () => {
  $("#guest-upgrade-hint").hidden = true;
});
$("#guest-upgrade-link")?.addEventListener("click", () => {
  $("#guest-upgrade-hint").hidden = true;
  $("#create-account-button")?.click();
});
function syncComposerChrome() {
  const to = $("#message-to-select")?.value;
  const bar = $("#composer-toolbar");
  // bu-09: the audience picker is the broadcast-vs-DM control and stays
  // visible whenever there is someone to address. Hiding it until a
  // recipient was already chosen made room-chat DMs undiscoverable — the
  // hidden control was the only way to start one.
  if (bar) bar.hidden = !composerAudiencePickerVisible({
    members: state?.members ? Object.values(state.members) : [],
    selfId: session?.member?.id,
    requestMode: Boolean(requestMode),
  });
  const note = $("#audience-note");
  if (note) {
    // RC-2026-09-19-070: a message addressed to one member is private to the
    // two parties — say so truthfully where the sender picks the recipient.
    // DMs are open by default (2026-09-24): only an explicit denial
    // (blocked/rejected/revoked) is surfaced, so a refusal is never a
    // surprise. No row / pending / approved needs no callout.
    const audience = composerAudienceNote(state?.members, to);
    if (audience) {
      note.textContent = audience;
      const consent = dmConsentPeerSummary(dmConsents, state.members, session?.member?.id, to);
      if (consent && consent.outgoing === "blocked") {
        note.textContent += " They aren't accepting DMs from you.";
      } else if (consent && (consent.outgoing === "rejected" || consent.outgoing === "revoked")) {
        note.textContent += " They declined DMs from you — ask in the room instead.";
      }
      note.hidden = false;
    } else note.hidden = true;
  }
  syncAlsoSend();
}
function renderInvitation() {
  const preview = invitation.preview;
  const phase = invitation.phase;
  const pending = preview?.status === "pending" && phase !== "terminal";
  const accepted = preview?.status === "accepted" && phase !== "terminal";
  const authenticated = Boolean(accountClient.session?.authenticated && accountClient.session.account);
  const switchingAccount = ["wrong-account", "changed-account"].includes(phase);
  const loading = ["previewing", "authenticating", "accepting", "opening"].includes(phase) || invitationIsCommitting();
  $("#invitation-dialog").setAttribute("aria-busy", loading ? "true" : "false");
  $("#invitation-retry").hidden = phase !== "preview-failed";
  $("#invitation-details").hidden = !preview;
  if (preview) {
    $("#invitation-room").textContent = preview.roomTitle || preview.roomId;
    $("#invitation-purpose").textContent = preview.roomPurpose || "Not provided";
    const counts = preview.memberCounts;
    $("#invitation-members").textContent = counts
      ? `${counts.humans} human${counts.humans === 1 ? "" : "s"} · ${counts.agents} agent${counts.agents === 1 ? "" : "s"}`
      : "Not shown";
    $("#invitation-display-name").textContent = preview.displayName;
    $("#invitation-member-id").textContent = preview.memberId;
    $("#invitation-role").textContent = humanize(preview.role);
    $("#invitation-permissions").textContent = preview.permissions.length
      ? preview.permissions.map(humanize).join(", ")
      : "Conversation only";
    $("#invitation-issuer").textContent = preview.invitedByDisplayName || "Room administrator";
    const expiry = new Date(preview.expiresAt);
    $("#invitation-expires").dateTime = expiry.toISOString();
    $("#invitation-expires").textContent = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(expiry);
  }
  let summary = phase === "terminal" ? "This invitation is unavailable." : "Checking invitation…";
  if (preview && phase !== "terminal") summary = pending
    ? ""
    : accepted ? "This invitation has already been accepted. Sign in with an authorized account to open the Room."
      : preview.status === "expired" ? "This invitation has expired. Ask a current Room administrator for a new one."
        : preview.status === "revoked" ? "This invitation was revoked. Ask a current Room administrator if you still need access."
          : "The inviter’s authority changed. Ask a current Room administrator for a new invitation.";
  if (phase === "unknown") summary = "Acceptance has not been confirmed. Check the result before leaving this invitation.";
  if (phase === "preview-failed") summary = "Could not check this invitation.";
  $("#invitation-summary").textContent = summary;
  const mayAuthenticate = Boolean(preview && (pending || accepted));
  $("#invitation-signin").hidden = !mayAuthenticate || (authenticated && !switchingAccount) || phase === "accepting" || phase === "opening";
  for (const control of $("#invitation-signin").querySelectorAll("input, button")) control.disabled = loading;
  $("#invitation-account-warning").hidden = !state;
  const action = $("#invitation-accept");
  action.hidden = !(authenticated && (pending || accepted) && !switchingAccount);
  action.disabled = loading;
  // Onboarding Slice 4: name the acting account so nobody accepts from the
  // wrong account. The app calls an account session "Personal account".
  const actingName = authenticated ? "Personal account" : null;
  const actingLine = $("#invitation-acting-account");
  actingLine.hidden = !(actingName && preview && phase !== "terminal");
  if (actingName && preview && phase !== "terminal") actingLine.textContent = `You’ll join as ${actingName}.`;
  action.textContent = accepted
    ? (actingName ? `Open room as ${actingName}` : "Open room")
    : phase === "unknown" ? "Check acceptance again"
    : actingName ? `Accept and open as ${actingName}` : "Accept and open room";
  $("#invitation-dismiss").disabled = invitationIsCommitting();
  syncRequestAccessDoor();
}
function closeInvitation({ returnFocus = true } = {}) {
  if (invitationIsCommitting()) return;
  if (invitation.phase === "unknown" && !window.confirm("Acceptance may already have completed. Closing clears this tab’s retry information. To check later, reopen the original invitation link and sign in with the same account. Close anyway?")) {
    $("#invitation-accept").focus({ preventScroll: false });
    return;
  }
  const opener = invitation.opener;
  invitation.version += 1;
  const selection = invitation.openerSelection;
  Object.assign(invitation, { phase: "idle", secret: null, preview: null, redemptionId: null, opener: null, openerSelection: null, requestAccess: null });
  resetRequestAccessDoor();
  clearPendingInvite(window.sessionStorage);
  setInvitationFeedback("");
  restoreInvitationSignin();
  if ($("#invitation-dialog").open) $("#invitation-dialog").close();
  $("#connection-status").setAttribute("aria-live", "polite");
  if (returnFocus) queueMicrotask(() => {
    const usable = node => node?.isConnected && !node.disabled && !node.hidden && node.getClientRects().length > 0;
    const fallback = state ? $("#message-input") : $("#google-signin");
    const target = usable(opener) ? opener : fallback;
    target?.focus({ preventScroll: true });
    const retainedSelection = selection || (target === $("#message-input") ? lastComposerSelection : null);
    if (retainedSelection && typeof target?.setSelectionRange === "function" && target.value === retainedSelection.value) {
      target.setSelectionRange(retainedSelection.start, retainedSelection.end, retainedSelection.direction);
    }
  });
}
async function openInvitation(fragment) {
  // A newly opened fragment must not replace the owner of an in-flight account change.
  if (invitationIsCommitting()) return;
  if (invitation.phase === "unknown" && $("#invitation-dialog").open) {
    setInvitationFeedback("Check the current acceptance result or close it explicitly before reviewing another invitation.", true);
    return;
  }
  invitation.version += 1;
  const active = document.activeElement === document.body ? null : document.activeElement;
  const composer = $("#message-input");
  const selectedComposer = state && lastComposerSelection?.value === composer.value ? composer : null;
  const opener = selectedComposer || (lastInvitationOpener?.isConnected ? lastInvitationOpener : active);
  const liveSelection = opener && typeof opener.selectionStart === "number"
    ? { value: opener.value, start: opener.selectionStart, end: opener.selectionEnd, direction: opener.selectionDirection }
    : null;
  // Some browsers collapse a textarea selection as the hash changes, before the
  // hashchange handler runs. Retain the last non-collapsed user selection for this
  // exact composer value; user input/pointer/keyboard events clear stale captures.
  const openerSelection = opener === $("#message-input") && liveSelection?.start === liveSelection?.end
    && lastComposerSelection?.value === opener.value ? lastComposerSelection : liveSelection;
  Object.assign(invitation, {
    phase: fragment.valid ? "previewing" : "terminal",
    secret: fragment.secret,
    preview: null,
    redemptionId: null,
    opener,
    openerSelection,
    requestAccess: null
  });
  setInvitationFeedback(fragment.valid ? "Checking the invitation without joining the Room…" : "This invitation link is unavailable.", !fragment.valid);
  renderInvitation();
  $("#connection-status").setAttribute("aria-live", "off");
  if (!$("#invitation-dialog").open) $("#invitation-dialog").showModal();
  queueMicrotask(() => $("#invitation-title").focus({ preventScroll: true }));
  if (!fragment.valid) return;
  await previewCurrentInvitation();
  if (initialGoogleFailed && invitation.phase === "needs-account") setInvitationFeedback(googleSigninFailureMessage, true);
  if (initialAuthLink.kind === "invalid" && fragment.secret === initialInvitationFragment?.secret && invitation.phase === "needs-account") {
    setInvitationFeedback("This sign-in link is incomplete or invalid. Request a new link or sign in below.", true);
  }
}
async function previewCurrentInvitation() {
  const { version, secret } = invitation;
  const retryHadFocus = document.activeElement === $("#invitation-retry");
  invitation.phase = "previewing";
  setInvitationFeedback("Checking the invitation…");
  renderInvitation();
  try {
    const [preview] = await Promise.all([
      accountClient.previewInvitation(secret),
      ensureAccountSession().catch(() => null)
    ]);
    if (!currentInvitation(version, secret)) return;
    invitation.preview = preview;
    invitation.phase = ["pending", "accepted"].includes(preview.status)
      ? (accountClient.session?.authenticated ? "ready" : "needs-account") : "terminal";
    setInvitationFeedback(preview.status === "pending"
      ? (accountClient.session?.authenticated ? "Review the exact scope, then accept only if it is right." : "Sign in to continue.")
      : preview.status === "accepted" ? "This invitation has already been accepted. Sign in with an authorized account to open the Room."
        : preview.status === "expired" ? "This invitation has expired. Ask a current Room administrator for a new one."
          : preview.status === "revoked" ? "This invitation was revoked. Ask a current Room administrator if you still need access."
            : "The inviter’s authority changed. Ask a current Room administrator for a new invitation.", invitation.phase === "terminal");
    renderInvitation();
    if (retryHadFocus && [document.body, $("#invitation-retry")].includes(document.activeElement)) {
      const target = invitation.phase === "needs-account" ? "#invitation-email"
        : invitation.phase === "ready" ? "#invitation-accept" : "#invitation-title";
      $(target).focus({ preventScroll: true });
    }
  } catch (error) {
    if (!currentInvitation(version, secret)) return;
    invitation.phase = canRetryInvitation(error) ? "preview-failed" : "terminal";
    setInvitationFeedback(invitation.phase === "preview-failed" ? "Connection interrupted. Try again."
      : "This invitation is unavailable. It may be invalid, expired, revoked, or no longer authorized.", true);
    renderInvitation();
  }
}
// RC-2026-09-19-071 (QAJ-001): the request-access door. When the invitation
// dialog lands terminal on a preview that still names the room, the stranger
// gets a way in: file a self-serve access request against that room. The
// pure policy (which previews qualify, form validation, stash keys) lives in
// src/invite-context.js; this is the dialog wiring.
function requestAccessDoor() {
  return invitation.phase === "terminal" ? inviteRequestDoor(invitation.preview) : null;
}
function resetRequestAccessDoor() {
  invitation.requestAccess = null;
  $("#invitation-request-door").hidden = true;
  $("#invitation-request-access").hidden = false;
  $("#invitation-request-access").disabled = false;
  $("#invitation-request-form").hidden = true;
  $("#invitation-request-form").reset();
  $("#invitation-request-status").textContent = "";
}
function syncRequestAccessDoor() {
  const door = requestAccessDoor();
  const block = $("#invitation-request-door");
  if (!door) { block.hidden = true; return; }
  // A fresh terminal preview resets the door; an in-flight submit keeps its
  // state across renderInvitation calls (phase does not change mid-submit).
  if (!invitation.requestAccess) resetRequestAccessDoor();
  block.hidden = false;
}
function openRequestAccessForm() {
  const door = requestAccessDoor();
  if (!door || invitation.requestAccess) return;
  invitation.requestAccess = { phase: "form", roomId: door.roomId };
  $("#invitation-request-access").hidden = true;
  const stashed = readAccessRequest(window.sessionStorage, door.roomId);
  if (stashed?.displayName) $("#invitation-request-name").value = stashed.displayName;
  // GR1: prefill the receipt footer referrer when the field is still empty.
  const referred = $("#invitation-request-referred");
  const fromReceipt = receiptReferrer();
  if (referred && !referred.value && fromReceipt) referred.value = fromReceipt;
  $("#invitation-request-form").hidden = false;
  $("#invitation-request-status").textContent = stashed
    ? `You already asked to join “${door.roomTitle}” from this browser. Sending again files a second request for the owner.`
    : "";
  queueMicrotask(() => $("#invitation-request-name").focus({ preventScroll: true }));
}
function setRequestAccessStatus(text, error = false) {
  const node = $("#invitation-request-status");
  node.textContent = text;
  node.classList.toggle("error", error);
}
async function submitRequestAccessForm(event) {
  event.preventDefault();
  const flow = invitation.requestAccess;
  const door = requestAccessDoor();
  if (!door || !flow || flow.phase !== "form") return;
  const checked = validateAccessRequestForm({
    displayName: $("#invitation-request-name").value,
    note: $("#invitation-request-note").value,
    referredBy: $("#invitation-request-referred")?.value,
  });
  if (!checked.ok) { setRequestAccessStatus(checked.error, true); return; }
  const submit = $("#invitation-request-submit");
  submit.disabled = true;
  flow.phase = "sending";
  setRequestAccessStatus("Sending your request…");
  try {
    // Reuse this browser's identity for the room so a retry does not mint
    // (and rate-limit-burn) a fresh identity per click.
    let stashed = readAccessRequest(window.sessionStorage, door.roomId);
    let identityId = stashed?.identityId ?? null, secret = stashed?.secret ?? null;
    if (!identityId) {
      const minted = await accountClient.mintAccessIdentity(checked.displayName);
      identityId = minted?.identityId; secret = minted?.secret ?? null;
      if (!identityId) throw new Error("The identity service did not return an identity.");
    }
    const requestId = newAccessRequestId();
    // Stash BEFORE the submit (M-37): a failed submit must not orphan the
    // freshly minted identity — the record stays stashed so the retry reuses
    // it instead of burning another mint.
    stashAccessRequest(window.sessionStorage, door.roomId, { identityId, secret, requestId, displayName: checked.displayName });
    await accountClient.submitAccessRequest({
      roomId: door.roomId,
      identityId,
      displayName: checked.displayName,
      requestedPermissions: defaultRequestPermissions(invitation.preview),
      note: checked.note,
      referredBy: checked.referredBy,
      requestId,
    });
    flow.phase = "sent";
    $("#invitation-request-form").hidden = true;
    setRequestAccessStatus(`Request sent — the owner of “${door.roomTitle}” has been notified and will review it. Your request ID is ${requestId}.`);
  } catch (error) {
    flow.phase = "form";
    submit.disabled = false;
    const message = error?.code === "rate_limited" || error?.status === 429
      ? "Too many requests from this browser — wait a little and try again."
      : error?.code === "already_member"
        ? "This identity is already in the room — ask the owner directly if you need anything."
        : typeof error?.message === "string" && error.message
          ? error.message
          : "Could not send the request. Check your connection and try again.";
    setRequestAccessStatus(message, true);
    queueMicrotask(() => $("#invitation-request-name").focus({ preventScroll: true }));
  }
}
$("#invitation-request-access").addEventListener("click", openRequestAccessForm);
$("#invitation-request-form").addEventListener("submit", submitRequestAccessForm);
async function openAcceptedRoom(roomId, message, { acceptanceConfirmed = true } = {}) {
  invitation.phase = "opening";
  invitation.secret = null;
  clearPendingInvite(window.sessionStorage);
  renderInvitation();
  setInvitationFeedback("");
  $("#invitation-dialog").close();
  $("#connection-status").setAttribute("aria-live", "polite");
  restoreInvitationSignin();
  accessEndContext = acceptanceConfirmed ? "accepted-room-switch" : "invited-room-switch";
  client.endAccess();
  history.replaceState(history.state, "", roomHandoffLocation(roomId));
  configureAuthPanel(roomId);
  try {
    const restored = await client.restore(roomId);
    if (!restored) throw new Error("The browser account changed before the Room could open");
    inboxUI.showRooms();
    Object.assign(invitation, { phase: "idle", preview: null, redemptionId: null, opener: null, openerSelection: null });
    notice(message);
    queueMicrotask(() => $("#conversation-title").focus({ preventScroll: true }));
  } catch (error) {
    Object.assign(invitation, { phase: "terminal", preview: null, redemptionId: null, opener: null, openerSelection: null });
    setFormStatus($("#auth-error"), acceptanceConfirmed
      ? "Your membership was accepted, but the conversation could not be loaded. Refresh or sign in with the same account; do not accept the invitation again."
      : [401, 403].includes(error.status) ? "This account could not open the invited Room. Sign in with the account that accepted the invitation."
        : "This invitation was already accepted, but the Room could not be loaded. Refresh to try again; no new acceptance is needed.", true);
    setConnectionStatus(acceptanceConfirmed ? "Membership accepted · conversation not loaded" : "Invitation already accepted · Room not loaded");
    $("#auth-panel").hidden = false;
    queueMicrotask(() => focusSignin());
  }
}
function selectOptions(selector, members, blank) {
  const select = $(selector), previous = select.value;
  const signature = JSON.stringify(members.map(m => [m.id, m.displayName]));
  if (select.dataset.signature === signature) return;
  select.innerHTML = `<option value="">${esc(blank)}</option>${members.map(m => `<option value="${esc(m.id)}">${esc(memberLabel(m.id))} · ${esc(kindLabel(m.kind))}</option>`).join("")}`;
  if (previous && !members.some(m => m.id === previous)) select.insertAdjacentHTML("beforeend", `<option value="${esc(previous)}" disabled>Previously selected member unavailable — choose again</option>`);
  if (previous) select.value = previous;
  select.dataset.signature = signature;
}
const WORK_PERMISSIONS = ["accept_work", "complete_work"];
function syncWorkForm() {
  if (!state || busy) return;
  setWorkRetry(workRetryLocked);
  if (workRetryLocked) {
    if ($("#work-dialog").open && [document.body, $("#new-work-form button[type='submit']")].includes(document.activeElement)) $("#retry-work-button").focus();
    return;
  }
  const active = Object.values(state.members).filter(member => member.active !== false);
  const writing = $("#work-mode-select").value === "write";
  syncWorkPolicy();
  const reviewing = $("#require-verification").checked;
  const assignable = active.filter(member => [...WORK_PERMISSIONS, ...(writing ? ["write_external"] : [])]
    .every(permission => member.permissions.includes(permission)));
  selectOptions("#assignee-select", assignable, "Choose assignee");
  const waiting = active.filter(member => member.kind === "agent" && !assignable.includes(member));
  if ($("#assignee-hint")) {
    $("#assignee-hint").hidden = waiting.length === 0;
    $("#assignee-hint").textContent = waiting.length ? `${waiting.map(m => m.displayName).join(", ")} can't take work yet. Change that in People.` : "";
  }
  const reviewers = active.filter(member => member.permissions.includes("verify") && member.id !== $("#assignee-select").value);
  selectOptions("#verifier-select", reviewers, "Choose reviewer");
  $("#reviewer-unavailable").hidden = !reviewing || !$("#assignee-select").value || reviewers.length > 0;
  $("#verifier-field").hidden = !reviewing;
  $("#verifier-select").disabled = !reviewing;
  $("#verifier-select").required = reviewing;
  const checks = [reviewing && "Review", $("#require-decision").checked && "approval"].filter(Boolean);
  $("#work-options-summary").textContent = !reviewing && active.length === 1 && active[0].kind === "human" && active[0].id === session.member.id
    ? uiText("human.workNoReview") : `${checks.join(" + ") || "Evidence only"} · ${writing ? "external write" : "read only"}`;
  for (const id of ["assignee-select", "verifier-select"]) {
    const select = $(`#${id}`);
    select.setCustomValidity(!select.disabled && select.selectedOptions[0]?.disabled ? "This member is no longer eligible. Choose another member." : "");
  }
}
// Quiet Focus A1/A2: a background snapshot must not collapse open disclosures or
// steal focus. Capture keyed disclosure + focus state before replacing list
// contents, restore it after. Keys are stable per host record, never positional.
function disclosureKey(details) {
  const host = details.closest("[data-disclosure-host]");
  return (host ? host.dataset.disclosureHost : "root") + ">" + (details.className || "details");
}
function captureDisclosures(container) {
  const openKeys = new Set();
  container.querySelectorAll("details[open]").forEach(d => openKeys.add(disclosureKey(d)));
  const active = document.activeElement;
  const focusKey = active && container.contains(active) ? active.dataset.focusKey ?? null : null;
  const focusHost = active && container.contains(active) ? active.closest("[data-disclosure-host]")?.dataset.disclosureHost ?? null : null;
  return { openKeys, focusKey, focusHost };
}
function restoreDisclosures(container, snap) {
  container.querySelectorAll("details").forEach(d => {
    if (snap.openKeys.has(disclosureKey(d))) d.open = true;
  });
  if (!snap.focusKey) return;
  const exact = [...container.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === snap.focusKey);
  const fallback = snap.focusHost
    ? [...container.querySelectorAll("[data-disclosure-host]")].find(node => node.dataset.disclosureHost === snap.focusHost)
    : null;
  (exact || fallback)?.focus({ preventScroll: true });
}
// Quiet Focus A3: a live update that reorders timeline nodes must not silently
// discard the user's text selection. Chromium collapses a selection when its
// containing node is moved (even when the node itself survives), so capture the
// range as the stable row key plus descendant paths + offsets inside that row,
// and restore it after the reorder. Paths resolve against equivalent
// replacement content, so a selection inside a node whose innerHTML was
// refreshed comes back too. A selection outside the list is never touched, and
// if the selected row is gone the selection is left alone.
function captureTimelineSelection(list) {
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!list.contains(range.commonAncestorContainer)) return null;
  const row = range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
    ? range.commonAncestorContainer.closest(":scope > *")
    : range.commonAncestorContainer.parentElement?.closest(":scope > *");
  const key = row?.dataset?.key;
  if (!row || !key) return null;
  const pathOf = node => {
    const path = [];
    let current = node;
    while (current && current !== row) {
      const parent = current.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, current));
      current = parent;
    }
    return current === row ? path : null;
  };
  const start = pathOf(range.startContainer), end = pathOf(range.endContainer);
  if (!start || !end) return null;
  return { key, start, startOffset: range.startOffset, end, endOffset: range.endOffset };
}
function restoreTimelineSelection(list, saved) {
  if (!saved) return;
  const row = list.querySelector(`:scope > [data-key="${CSS.escape(saved.key)}"]`);
  if (!row) return;
  const nodeAt = path => {
    let node = row;
    for (const index of path) {
      node = node.childNodes[index];
      if (!node) return null;
    }
    return node;
  };
  const clampOffset = (node, offset) => {
    const max = node.nodeType === Node.TEXT_NODE ? (node.nodeValue || "").length : node.childNodes.length;
    return Math.max(0, Math.min(offset, max));
  };
  const startNode = nodeAt(saved.start), endNode = nodeAt(saved.end);
  if (!startNode || !endNode) return;
  try {
    const range = document.createRange();
    range.setStart(startNode, clampOffset(startNode, saved.startOffset));
    range.setEnd(endNode, clampOffset(endNode, saved.endOffset));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  } catch { /* selected content changed shape; leave the selection alone */ }
}
function renderContent(selector, html) {
  const container = $(selector);
  if (container._content === html) return;
  const saved = captureDisclosures(container);
  container.innerHTML = html; container._content = html;
  restoreDisclosures(container, saved);
}
// W4-43 H1: the three starter recipes surface as dismissible suggestion chips.
// Triggers and outcomes are derived in src/work-recipes.js from committed
// state; chips only open existing surfaces or prefill a draft - they never
// send, launch or spend on the member's behalf.
const dismissedRecipeChips = new Set();
const recipeChipKey = r => `${r.id}:${r.outcome.workItemId ?? r.outcome.requestId ?? ""}`;
function recipeChipHtml(r) {
  const meta = RECIPE_CATALOG.find(c => c.id === r.id), key = recipeChipKey(r);
  let label, action;
  if (r.id === "draft-catch-up") {
    label = `${r.trigger.unseen} new ${r.trigger.unseen === 1 ? "event" : "events"} since your caught-up marker`;
    action = `<button type="button" class="button ghost" data-recipe-action="open-catch-up">Open catch-up draft</button>`;
  } else if (r.id === "suggest-next-work") {
    label = `Next step: ${esc(r.outcome.label)}`;
    action = r.outcome.workItemId
      ? `<button type="button" class="button ghost" data-recipe-action="focus-work" data-work-id="${esc(r.outcome.workItemId)}" aria-label="Open suggested work: ${esc(r.outcome.label)}">Open work</button>`
      : `<button type="button" class="button ghost" data-recipe-action="open-chat" aria-label="Open suggested request: ${esc(r.outcome.label)}">Open request</button>`;
  } else {
    label = `"${esc(r.outcome.title ?? r.outcome.workItemId)}" has waited over a day for review`;
    action = `<button type="button" class="button ghost" data-recipe-action="draft-review" data-work-id="${esc(r.outcome.workItemId)}" data-to="${esc(r.outcome.toMemberId)}">Draft a review request</button>`;
  }
  return `<div class="recipe-chip" data-recipe-chip="${esc(key)}"><span class="recipe-chip-label"><strong>${esc(meta.title)}</strong> - ${label}</span>${action}<button type="button" class="button ghost" data-recipe-dismiss="${esc(key)}" aria-label="Dismiss suggestion: ${esc(meta.title)}">Dismiss</button></div>`;
}
// W4-47 H6: dry-run preview panel. Lists every catalog recipe with what it
// reads, its trigger, what it would do, and whether it would fire right now.
// previewAllRecipes is a pure read over committed state - opening this panel
// commits nothing, writes nothing and never marks intent handled.
function recipePreviewLabel(p) {
  if (!p.firesNow) return "Not firing right now";
  const o = p.preview;
  if (o.kind === "catch_up_draft") return "Firing now: would prepare a catch-up draft";
  if (o.kind === "work_suggestion") return `Firing now: would suggest ${esc(o.label)}`;
  if (o.kind === "review_request_draft") return `Firing now: would draft a review request for "${esc(o.title ?? o.workItemId)}"`;
  return "Firing now";
}
function recipePreviewHtml(p) {
  return `<div class="recipe-preview-item"><strong>${esc(p.title)}</strong>`
    + `<div>Reads: ${esc(p.reads.join("; "))}</div>`
    + `<div>Trigger: ${esc(p.trigger)}</div>`
    + `<div>Would do: ${esc(p.outcome)}</div>`
    + `<div class="recipe-preview-status">${recipePreviewLabel(p)}</div></div>`;
}
function syncRecipePreview() {
  const toggle = $("#recipe-preview-toggle"), panel = $("#recipe-preview");
  if (!toggle || !panel) return;
  if (!state || !session) { toggle.hidden = true; panel.hidden = true; panel.replaceChildren(); return; }
  toggle.hidden = false;
  if (panel.hidden) return;
  const previews = previewAllRecipes(state, session.member.id, { now: Date.now(), cursor: roomCursor, sequence: client.sequence });
  renderContent("#recipe-preview", previews.map(recipePreviewHtml).join(""));
}
function syncRecipeStrip() {
  const strip = $("#recipe-strip");
  if (!strip) return;
  if (!state || !session) { strip.hidden = true; strip.replaceChildren(); return; }
  const recipes = activeRecipes(state, session.member.id, { now: Date.now(), cursor: roomCursor, sequence: client.sequence })
    .filter(r => !dismissedRecipeChips.has(recipeChipKey(r)));
  strip.hidden = recipes.length === 0;
  renderContent("#recipe-strip", recipes.map(recipeChipHtml).join(""));
}
function render() {
  ownerOffersUI.sync();
  conversation = conversationIndex(state.messages);
  const members = Object.values(state.members), active = members.filter(m => m.active !== false);
  selectOptions("#message-to-select", active, "Everyone");
  syncWorkForm();
  syncActionForm();
  syncRecipeStrip();
  syncChatSuggestions();
  syncSidebarSections(state);
  syncRecipePreview();
  setText("#presence-count", `${active.length} ${active.length === 1 ? "member" : "members"}`);
  const railCtx = { workItems: state.workItems, messages: state.messages, now: Date.now() };
  const ownerView = Boolean(session && state.room.ownerId === session.member.id && can("manage_members"));
  const adminControl = m => !ownerView || m.id === state.room.ownerId || m.active === false ? "" : `<p class="form-hint">Room admins can invite and manage members. Ownership stays with you.</p><button type="button" class="text-button" data-member-admin="${esc(m.id)}"${memberActionBusy ? " disabled" : ""}>${m.permissions.includes("manage_members") ? "Remove admin role" : "Make room admin"}</button>`;
  // H4: agents that joined through a room link arrive with no permissions, so
  // they never appear as assignees. The click handler leaves owner-connected
  // agents alone, because changing their access retires their connection key.
  const workControl = m => !ownerView || m.kind !== "agent" || m.active === false
    || WORK_PERMISSIONS.every(p => m.permissions.includes(p)) ? ""
    : `<button type="button" class="text-button" data-member-work="${esc(m.id)}"${memberActionBusy ? " disabled" : ""}>Let them take work</button>`;
  // C6: Pause/Resume govern the agent's queued wakes; Remove ends access via
  // MEMBER_ACCESS_CHANGED and asks for a second click instead of a native dialog.
  const memberActions = m => {
    if (!ownerView || m.kind !== "agent" || m.active === false) return "";
    const paused = agentPauses.has(m.id), armed = armedRemoval === m.id;
    return `<div class="member-actions" data-member-actions="${esc(m.id)}"><button type="button" class="text-button" data-member-pause="${esc(m.id)}" data-pause-action="${paused ? "resume" : "pause"}" title="${paused ? "Let queued wakes start again" : "Queued wakes will not start; a running attempt finishes"}">${paused ? "Resume" : "Pause"}</button><button type="button" class="text-button member-remove${armed ? " armed" : ""}" data-member-remove="${esc(m.id)}" aria-pressed="${armed}">${armed ? "Confirm remove" : "Remove"}</button>${armed ? `<button type="button" class="text-button" data-member-remove-cancel="${esc(m.id)}">Keep</button>` : ""}</div>`;
  };
  const presenceStale = presenceUnrefreshed || presenceObservationAged();
  const presenceRow = m => {
    // #660: prefer the server-derived presence entry when we have one; it
    // carries the authoritative working state plus owner/scope projection.
    const serverPresence = m.active === false ? null : presenceStates.get(m.id);
    const merged = serverPresence ? { ...m, ...serverPresence } : m;
    const agent = m.kind === "agent" && m.active !== false;
    const presence = agent && presenceStale ? "unknown" : memberPresence(merged, railCtx);
    const availability = agent && presenceStale ? (presenceUnrefreshed ? "Availability not refreshed" : "Availability needs refresh") : presenceLabel(presence);
    // Keep names readable; duplicate names retain their IDs and every exact
    // identity remains available in the member disclosure and action choices.
    const handle = m.kind === "agent" ? memberHandle(m, displayName(m.id)) : displayName(m.id);
    const done = memberDoneChip(m, railCtx);
    const status = memberStatus(m, railCtx);
    const doneChip = done
      ? `<span class="done-chip" title="${esc(done.title)}" data-done-work="${esc(done.workItemId)}">${esc(done.label)}</span>`
      : "";
    const typeChip = m.kind === "agent" && m.agentType
      ? `<span class="agent-type-chip" data-agent-type="${esc(m.agentType)}">${esc(catalogById(m.agentType)?.label || m.agentType)}</span>`
      : "";
    // #660: state chip, owner chip, "working on {title}", "owned by".
    const serverState = serverPresence?.state;
    const stateChip = agent || serverState
      ? `<span class="member-state-chip" data-state="${esc(presence)}">${esc(availability)}</span>`
      : "";
    const ownerChip = m.id === state.room.ownerId
      ? `<span class="owner-chip" title="Room owner">Owner</span>`
      : m.active !== false && m.permissions.includes("manage_members") ? `<span class="owner-chip" title="Can invite and manage members">Admin</span>` : "";
    const workingOnTitle = !presenceUnrefreshed && serverState === "working" && serverPresence?.workingOn?.[0]?.title
      ? `<span class="member-working-on">${presenceStale ? "Last reported working on" : "working on"} ${esc(String(serverPresence.workingOn[0].title))}…</span>`
      : "";
    const ownedBy = serverPresence?.ownerIdentityId
      ? `<span class="member-owned-by">Agent identity: <code>${esc(serverPresence.ownerIdentityId)}</code></span>`
      : "";
    const hostReport = Number.isFinite(serverPresence?.presence?.lastSeenAt)
      ? `<p class="member-observation">Last host report: <time datetime="${esc(new Date(serverPresence.presence.lastSeenAt).toISOString())}">${esc(new Date(serverPresence.presence.lastSeenAt).toLocaleString())}</time></p>` : "";
    const lastReport = agent && presenceStale && serverState
      ? `<p class="member-observation">Last reported availability: ${esc(presenceLabel(serverState))}</p>` : "";
    return `<div id="${recordDomId("member", m.id)}" class="presence-member" tabindex="-1" data-member-record-id="${esc(m.id)}" data-presence="${esc(presence)}" data-disclosure-host="${esc(m.id)}" data-focus-key="member:${esc(m.id)}"${m.agentType ? ` data-agent-type="${esc(m.agentType)}"` : ""} ${m.active === false ? "" : `title="${esc(`Address ${m.displayName} in chat`)}"`}><div class="member-avatar ${m.kind}" aria-hidden="true"><span>${initials(m.displayName)}</span><i class="presence-dot presence-${esc(presence)}" title="${esc(availability)}"></i></div><div><div class="member-head"><strong class="member-handle${m.kind === "agent" ? " member-handle-agent" : ""}">${esc(handle)}</strong><span class="sr-only">${esc(availability)}</span>${doneChip}${agentPauses.has(m.id) && m.active !== false ? `<span class="pause-chip" data-paused-member="${esc(m.id)}" title="Queued wakes will not start; a running attempt may finish">Wakes paused</span>` : ""}${friendBondHtml(m)}</div>${agent ? `<span class="member-availability">${esc(availability)}</span>` : ""}${workingOnTitle}${agent ? `<p class="member-status member-assignment">${esc(status)}</p>` : ""}<details class="member-profile"><summary data-focus-key="member-profile:${esc(m.id)}" aria-label="Member options for ${esc(m.displayName)}" title="Member options"><span aria-hidden="true">···</span></summary><div class="member-profile-body"><p class="form-hint">Member ID: <code>${esc(m.id)}</code></p><div class="member-profile-badges">${typeChip}${stateChip}${ownerChip}</div><p class="member-status">${esc(status)}</p>${lastReport}${hostReport}${ownedBy}${agentPauses.has(m.id) && agent ? `<p class="member-pause-explanation">Queued wakes will not start; a running attempt may finish.</p>` : ""}${memberActions(m)}${workControl(m)}<details><summary data-focus-key="member-capabilities:${esc(m.id)}">Room capabilities</summary><p>${esc(m.permissions.join(", ") || "conversation only")}</p>${adminControl(m)}${muteControl(m)}</details>${dmConsentDetails(m)}${directoryCardDetails(m)}</div></details></div></div>`;
  };
  // E4: mute is the viewer's own preference; the owner (the appeal path) and yourself are never mutable.
  const muteControl = m => m.id === session?.member?.id || m.id === state.room.ownerId ? "" : `<button type="button" class="text-button mute-toggle" data-mute-member="${esc(m.id)}" data-muted="${isMutedBy(state, session?.member?.id, m.id)}" aria-pressed="${isMutedBy(state, session?.member?.id, m.id)}">${isMutedBy(state, session?.member?.id, m.id) ? `Unmute ${esc(m.displayName)}` : `Mute ${esc(m.displayName)} for me`}</button>`;
  // DM consent (PR #731): directional state + actions for the DM pairs
  // the signed-in member's pair with each other active member. Never rendered
  // for yourself or for the public read-only face (session is null there).
  // Agent↔agent Friend. Separate from the room-chat Direct messages disclosure
  // below. Propose and accept send no scopes; the server defaults all v1.
  const friendBondHtml = m => {
    if (!session || session.member.kind !== "agent" || m.kind !== "agent" || m.active === false || m.id === session.member.id) return "";
    const self = state.members[session.member.id] ?? session.member;
    const selfId = identityIdOf(self, presenceStates.get(session.member.id));
    const peerId = identityIdOf(m, presenceStates.get(m.id));
    const bond = bondWithPeer(mergeFriendBonds(friendBonds, state.bonds), selfId, peerId);
    const chrome = friendChrome({ bond, selfIdentityId: selfId });
    const chip = chrome.state === "none" ? "" : `<span class="friend-chip" data-friend-state="${esc(chrome.state)}">${esc(chrome.label)}</span>`;
    const names = {
      propose: `Friend ${m.displayName}`,
      accept: `Accept friend request from ${m.displayName}`,
      decline: `Decline friend request from ${m.displayName}`,
      revoke: `Revoke friend bond with ${m.displayName}`,
      dm: `Message ${m.displayName}`
    };
    const buttons = chrome.actions.map(action => {
      const bondAttr = chrome.bondId ? ` data-friend-bond="${esc(chrome.bondId)}"` : "";
      return `<button type="button" class="text-button friend-action" data-friend-action="${esc(action.action)}" data-friend-peer="${esc(m.id)}"${bondAttr} aria-label="${esc(names[action.action] || action.label)}"${friendBusy ? " disabled" : ""}>${esc(action.label)}</button>`;
    }).join("");
    return `<span class="friend-bond" tabindex="-1" data-friend-peer="${esc(m.id)}" data-friend-state="${esc(chrome.state)}" data-focus-key="friend-group:${esc(m.id)}" role="group" aria-label="Friend ${esc(m.displayName)}">${chip}${buttons}</span>`;
  };
  const dmConsentDetails = m => {
    if (!session || m.id === session.member.id || m.active === false) return "";
    const summary = dmConsentPeerSummary(dmConsents, state.members, session.member.id, m.id);
    const lines = dmConsentPairDescription(summary, m.displayName).map(line => `<p>${esc(line)}</p>`).join("");
    const actions = dmConsentActionsForPeer(summary).map(a => a.disabled
      ? `<span class="dm-consent-note">${esc(a.label)}</span>`
      : `<button type="button" class="text-button" data-dm-consent-action="${a.action}" data-dm-consent-peer="${esc(m.id)}">${esc(a.label)}</button>`).join("");
    return `<details class="dm-consent"><summary data-focus-key="member-dm:${esc(m.id)}">Direct messages</summary><div class="dm-consent-body">${lines}<div class="dm-consent-actions">${actions}</div></div></details>`;
  };
  // plan-dir-card: the member chip's directory card section. The card is
  // lazy-loaded on first expand from the member-card endpoint so the
  // presence roster stays light; cardAgentId on the member says whether a
  // visible card exists.
  const directoryCardDetails = m => {
    if (!m || m.kind !== "agent" || !m.cardAgentId || m.active === false) return "";
    return `<details class="member-directory-card" data-directory-card="${esc(m.id)}"><summary data-focus-key="member-card:${esc(m.id)}">Directory card</summary><div class="member-card-body" data-member-card-body="${esc(m.id)}"><p class="form-hint">Loading…</p></div></details>`;
  };
  // Incoming DM requests surface at the top of the People panel so they are
  // visible without opening any one member's details.
  const dmRequestInbox = () => {
    if (!session) return "";
    const requests = incomingDmRequests(dmConsents, state.members, session.member.id);
    if (!requests.length) return "";
    const rows = requests.map(r => {
      const member = state.members[r.requesterId];
      return `<li class="dm-request"><div><strong>${esc(member ? member.displayName : r.requester)}</strong>${r.reason ? `<p class="dm-request-reason">&ldquo;${esc(r.reason)}&rdquo;</p>` : ""}</div><div class="dm-consent-actions"><button type="button" class="text-button" data-dm-consent-action="approve" data-dm-consent-peer="${esc(r.requesterId)}">Approve</button><button type="button" class="text-button" data-dm-consent-action="reject" data-dm-consent-peer="${esc(r.requesterId)}">Reject</button><button type="button" class="text-button" data-dm-consent-action="block" data-dm-consent-peer="${esc(r.requesterId)}">Block</button></div></li>`;
    }).join("");
    return `<div class="dm-requests"><p class="presence-heading">Direct message requests (${requests.length})</p><ul>${rows}</ul></div>`;
  };
  const byPresence = (a, b) => (a.active === false) - (b.active === false) || a.displayName.localeCompare(b.displayName);
  const people = members.filter(m => m.kind !== "agent").sort(byPresence);
  const agents = members.filter(m => m.kind === "agent" && m.active !== false).sort(byPresence);
  const removedAgents = members.filter(m => m.kind === "agent" && m.active === false).sort(byPresence);
  // Membership revocation is different from idle presence. Keep active agents
  // visible and historical identities inspectable without crowding the rail.
  const removedAgentsHtml = removedAgents.length
    ? `<details class="removed-agents"><summary data-focus-key="removed-agents">Removed agents (${removedAgents.length})</summary>${removedAgents.map(presenceRow).join("")}</details>` : "";
  const presenceNote = presenceUnrefreshed ? "Availability could not refresh. Try again." : presenceStale ? "Availability needs refresh. Reports older than 60 seconds need another check." : "";
  const checked = presenceCheckedAt ? `${presenceStale ? "Last successful check" : "Last checked"}: ${time(new Date(presenceCheckedAt).toISOString())}` : "";
  const presenceRefresh = `<div class="presence-refresh"><button type="button" class="text-button" data-refresh-presence data-focus-key="refresh-presence">Refresh availability</button><span class="presence-check-note">${esc([presenceNote, checked].filter(Boolean).join(" "))}</span></div>`;
  renderContent("#presence-list", `${presenceRefresh}${dmRequestInbox()}${people.length ? `<p class="presence-heading">People</p>${people.map(presenceRow).join("")}` : ""}${agents.length ? `<p class="presence-heading">Agents</p>${agents.map(presenceRow).join("")}` : ""}${removedAgentsHtml}`);
  // JDOT-MEMBER-PERMS-UI begin
  memberPermissionsUI.sync();
  ownerAttentionCard.sync();
  // JDOT-MEMBER-PERMS-UI end
  const proposing = can("steer") && !isRoomArchived(state); // Issue #6 A2: no new work in an archived room.
  for (const id of ["new-work-button"]) {
    $("#" + id).hidden = !proposing; $("#" + id).disabled = !proposing;
  }
  syncComposerChrome();
  syncChannelChrome();
  syncTimelineWork();
  syncRequestComposer();
  renderRoomOverview();
  renderSpendAllowance();
  syncReports();
  syncRoomHealth();
  syncRoomTrust();
  syncPublicReceipts(); // GR1 owner control for the public receipts page
  syncHistoryVisibility(); // PRIV-2 owner control for new members' history
  syncAcquisitionControls(); // GR2 public room page, join link, name, and tasks
  $("#event-count").textContent = `${client.sequence}`;
  renderReturnBrief({ timelineRendered: true });
  setText("#decision-count", state.eventLog.filter(e => e.type === T.DECISION_RECORDED).length || "");
  renderRecordPanel();
  humanExperience?.sync();
  revealAgentSigninLink();
}
function renderRecordPanel() {
  if (!state || !$("#settings-dialog").open || $("#settings-dialog").classList.contains("results-only") || !$("#record-panel").open) return;
  renderContent("#event-list", [...state.eventLog].reverse().map(e => `<li id="${recordDomId("event", e.id)}" tabindex="-1" data-event-record-id="${esc(e.id)}" data-focus-key="event:${esc(e.id)}"><span>${esc(humanize(e.type))}</span><strong>${esc(memberLabel(e.actorId))}</strong><time datetime="${esc(e.at)}">${esc(time(e.at))}</time><code>${esc(e.id)}</code></li>`).join(""));

  // Decision register (backlog F2): the register is read from the event feed.
  const decisions = state.eventLog.filter(e => e.type === T.DECISION_RECORDED);
  setText("#decision-count", decisions.length || "");
  renderContent("#decision-list", [...decisions].reverse().map(e =>
    `<li><strong>${esc(e.data.statement)}</strong> <a class="source-link" href="${esc(recordHref("message", e.data.sourceMessageId))}" data-open-message="${esc(e.data.sourceMessageId)}" data-focus-key="decision-source:${esc(e.id)}">source</a>${e.data.note ? ` <span class="rb-detail">${esc(e.data.note)}</span>` : ""} <span class="rb-detail">${esc(memberLabel(e.actorId))} · ${esc(time(e.at))}</span></li>`).join("")
    || '<li class="rb-empty">No decisions recorded yet.</li>');
}
$("#record-panel").addEventListener("toggle", renderRecordPanel);
// Phase 2 channels: one main channel plus user-created channels. Chat and work
// share the timeline of the selected channel; work cards follow the channel of
// their proposal message (the main channel when there is none).
function channelStorageKey() { return `pr-channel:${activeChannelRoomId ?? "none"}`; }
function restoreActiveChannel() {
  activeChannelId = DEFAULT_CHANNEL_ID;
  try {
    const saved = localStorage.getItem(channelStorageKey());
    if (saved && state?.channels?.[saved] && !state.channels[saved].archivedAt) activeChannelId = saved;
  } catch { /* private mode: stay on the main channel */ }
}
function activeChannel() { return state?.channels?.[activeChannelId] ?? null; }
function setActiveChannel(id) {
  if (!state || busy || requestReading || composerFiles.some(file => file.status === "uploading")) return;
  const next = state.channels[id] && !state.channels[id].archivedAt ? id : DEFAULT_CHANNEL_ID;
  if (next === activeChannelId && !currentThreadId && !requestMode && !assistantDraft) return;
  saveComposer();
  viewPositions.set(conversationViewKey(), $("#message-list").scrollTop);
  requestEpoch++; requestReading = false; requestMode = null;
  currentThreadId = null; assistantDraft = null;
  activeChannelId = next;
  try { localStorage.setItem(channelStorageKey(), activeChannelId); } catch { /* private mode */ }
  restoreComposer(drafts.get(composerKey()));
  $("#also-send-to-channel").checked = false;
  syncChannelChrome(); updateReply(); syncRequestComposer(); renderComposerError();
  renderMessages(); persistDrafts();
}

function syncChannelChrome() {
  // If the active channel was archived elsewhere, fall back to the main channel.
  if (state && activeChannelId !== DEFAULT_CHANNEL_ID && state.channels[activeChannelId]?.archivedAt
    && !busy && !requestReading && !composerFiles.some(file => file.status === "uploading")) {
    setActiveChannel(DEFAULT_CHANNEL_ID);
    return;
  }
  const name = activeChannel()?.name ?? DEFAULT_CHANNEL_ID;
  setText("#conversation-title", `# ${name}`);
  const input = $("#message-input");
  if (input) input.placeholder = `Message #${name}`;
  renderChannels();
}
function renderChannels() {
  const list = $("#channel-list");
  if (!list || !state) return;
  const ownerView = Boolean(session && state.room.ownerId === session.member.id && can("manage_members"));
  const html = channelList(state).filter(c => !c.archivedAt).map(c => {
    const active = c.id === activeChannelId;
    const manage = ownerView && c.id !== DEFAULT_CHANNEL_ID
      ? `<button type="button" class="icon-button channel-manage" data-channel-manage="${esc(c.id)}" aria-label="Channel settings, ${esc(c.name)}" title="Channel settings">⋯</button>` : "";
    return `<li class="channel-row"><button type="button" class="channel${active ? " is-active" : ""}" data-channel="${esc(c.id)}"${active ? ' aria-current="page"' : ""}><span aria-hidden="true">#</span><span class="channel-name">${esc(c.name)}</span></button>${manage}</li>`;
  }).join("");
  if (list._html !== html) { list.innerHTML = html; list._html = html; }
}
// One-tap replies and a task nudge under the latest message in view
// (src/chat-suggestions.js). Plain chat stays the default; structure is one tap away.
const dismissedSuggestions = new Set();
let askAgentTimer = null;
function syncChatSuggestions() {
  const box = $("#chat-suggestions");
  if (!box) return;
  const messages = !state || !session ? [] : currentThreadId ? conversation.threads.get(currentThreadId) || []
    : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
  const latest = messages.at(-1);
  // "Ask @Agent" is for the channel view: a thread already has its own replies.
  const ask = latest && !currentThreadId
    ? { members: state.members, replyCount: (conversation.threads.get(latest.id)?.length ?? 1) - 1, now: Date.now() } : null;
  const offer = latest && !isRoomArchived(state) && !activeChannel()?.archivedAt
    ? chatSuggestions(latest, { viewerId: session.member.id, canCreateWork: can("steer"), dismissed: dismissedSuggestions, ask }) : null;
  // A question can cross the wait while nothing else changes, so check again then.
  clearTimeout(askAgentTimer);
  const waitLeft = ask && !offer?.agent ? Date.parse(latest.createdAt) + ASK_AGENT_AFTER_MS - ask.now : NaN;
  if (waitLeft > 0) askAgentTimer = setTimeout(syncChatSuggestions, waitLeft + 50);
  const signature = offer ? JSON.stringify(offer) : "";
  if (box.dataset.signature === signature) return;
  box.dataset.signature = signature;
  box.hidden = !offer;
  if (!offer) { box.replaceChildren(); return; }
  box.innerHTML = offer.choices.map(choice => `<button type="button" class="suggestion-chip" data-suggest-reply="${esc(choice)}">${esc(choice)}</button>`).join("")
    + (offer.task ? `<button type="button" class="suggestion-chip suggestion-task" data-suggest-task="${esc(offer.messageId)}">Make this a task</button>` : "")
    + (offer.agent ? `<button type="button" class="suggestion-chip suggestion-agent" data-suggest-agent="${esc(offer.agent.name)}" data-suggest-agent-for="${esc(offer.messageId)}">Ask @${esc(offer.agent.name)}</button>` : "")
    + `<button type="button" class="suggestion-dismiss" data-suggest-dismiss="${esc(offer.messageId)}" aria-label="Hide suggestions" title="Hide">×</button>`;
}
$("#chat-suggestions")?.addEventListener("click", e => {
  const reply = e.target.closest("[data-suggest-reply]"), task = e.target.closest("[data-suggest-task]"), dismiss = e.target.closest("[data-suggest-dismiss]");
  if (dismiss) { dismissedSuggestions.add(dismiss.dataset.suggestDismiss); syncChatSuggestions(); $("#message-input").focus(); return; }
  if (task) { dismissedSuggestions.add(task.dataset.suggestTask); syncChatSuggestions(); openWork(task.dataset.suggestTask); return; }
  const agent = e.target.closest("[data-suggest-agent]");
  if (agent) {
    // Prefill the mention only; the person writes the rest and sends it.
    const input = $("#message-input");
    if (!input.value.trim()) { input.value = `@${agent.dataset.suggestAgent} `; input.dispatchEvent(new Event("input", { bubbles: true })); }
    dismissedSuggestions.add(agent.dataset.suggestAgentFor); syncChatSuggestions();
    input.focus(); input.setSelectionRange(input.value.length, input.value.length);
    return;
  }
  if (!reply || busy || !state) return;
  const input = $("#message-input");
  // A chip only fills a message the person hasn't started, then sends it
  // through the normal composer (same retry and ownership rules).
  if (input.value.trim()) { input.focus(); return; }
  input.value = reply.dataset.suggestReply;
  $("#message-form").requestSubmit();
});
// Typing indicators: ephemeral, driven by synthetic `typing` SSE events.
// The server expires beats after 10s, so a missing update clears itself;
// this also clears on snapshot refresh and when the viewer sends.
function renderTyping(typists) {
  const el = $("#typing-indicator");
  if (!el) return;
  const names = (typists ?? []).map(t => t.displayName || t.memberId).filter(Boolean).slice(0, 3);
  const extra = (typists ?? []).length - names.length;
  if (!names.length) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  const who = extra > 0 ? `${names.join(", ")} and ${extra} other${extra === 1 ? "" : "s"}` : names.join(" and ");
  el.textContent = `${who} ${names.length + extra === 1 ? "is" : "are"} typing…`;
  el.hidden = false;
}
function renderMessages() {
  const list = $("#message-list"), view = currentThreadId ? `thread:${currentThreadId}` : `room:${activeChannelId}`;
  const sameView = list.dataset.view === view;
  if (!sameView) syncChatSuggestions();
  // The read-horizon anchor is recomputed when the view changes (room vs
  // thread, channel switch); a cached horizon applies synchronously, a miss
  // fetches and re-renders.
  if (view !== lastHorizonView && state) {
    lastHorizonView = view;
    const threadKey = currentThreadId ?? "";
    const messages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
    if (horizonCache.has(threadKey)) horizonAnchorId = horizonAnchorFor(messages, horizonCache.get(threadKey));
    else { horizonAnchorId = null; void applyHorizonAnchor(); }
  }
  const allMessages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
  const shownLimit = currentThreadId ? Infinity : timelineWindow.get(view) ?? TIMELINE_WINDOW;
  const { messages, hidden: hiddenCount } = windowTimeline(allMessages, shownLimit);
  const revealing = timelineRevealing; timelineRevealing = false;
  const previous = new Map([...list.children].map(e => [e.dataset.key, e]));
  const pageScroll = list.scrollHeight <= list.clientHeight;
  const listTop = Math.max(0, list.getBoundingClientRect().top);
  const listNearBottom = !pageScroll && list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const pinOnly = !pageScroll && !listNearBottom && timelinePin.holds(view, list); // at the newest only by the pin
  const nearBottom = pageScroll ? list.getBoundingClientRect().bottom <= innerHeight + 80 : pinOnly || listNearBottom;
  const anchor = [...list.children].find(e => {
    if (e.hasAttribute("data-claim-update") || e.dataset.key === TIMELINE_PAGER_KEY) return false; // removed and repainted below
    const bounds = e.getBoundingClientRect();
    return bounds.bottom > listTop && (!pageScroll || bounds.top < innerHeight);
  });
  const anchorOffset = anchor?.getBoundingClientRect().top;
  const focused = list.contains(document.activeElement) ? document.activeElement : null;
  const focusKey = focused?.closest("[data-key]")?.dataset.key;
  const focusedRect = focused?.getBoundingClientRect();
  const focusedOnScreen = Boolean(focusedRect && focusedRect.bottom > 0 && focusedRect.top < innerHeight);
  const focusAction = focused?.dataset.messageAction, focusReaction = focused?.dataset.reaction;
  const focusedFeedback = focused?.closest(".draft-feedback");
  // A control inside a work card is restored by setTimelineWorkNode when that
  // card is re-rendered, but the interleave can then move the card, and moving
  // a node drops focus. Remembered here, restored once at the end, when every
  // node is in its final place.
  const focusedKey = focused?.dataset.focusKey ?? null;
  const focusedMessage = focused?.matches(".message");
  const newMessages = sameView && !revealing ? arrivalsAfterShown(messages, m => previous.has(`message:${m.id}`)) : [];
  const newCount = newMessages.length;
  // Your own message, sent from this browser, always comes into view: it is
  // not news to you, and a "jump to latest" pill for it hides what you just said.
  const ownArrival = sameView && newMessages.some(m => locallyOwnedMessageIds.has(m.id));
  if (!sameView || nearBottom || ownArrival) unreadAnchorId = null;
  else if (!unreadAnchorId && newMessages[0]) unreadAnchorId = newMessages[0].id;
  // New arrivals while the user watches the bottom count as read (debounced).
  if (sameView && nearBottom && newCount > 0) scheduleHorizonAdvance();
  const pendingOutgoingId = pendingMessage?.command?.data?.messageId || pendingMessage?.command?.id;
  const announceCount = newMessages.filter(message => message.id !== pendingOutgoingId && !locallyOwnedMessageIds.has(message.id) && !isMutedBy(state, session?.member?.id, message.authorId)).length;
  newMessages.forEach(message => locallyOwnedMessageIds.delete(message.id));
  $("#thread-bar").hidden = !currentThreadId;
  syncThreadMuteButton();
  syncAlsoSend();
  $("#composer-label").textContent = currentThreadId ? "Reply in this thread" : "Message the room";
  if (currentThreadId) {
    const root = conversation.byId.get(currentThreadId);
    $("#thread-title").textContent = `Thread with ${name(root.authorId)}`;
    setText("#thread-context", `${messages.length - 1} ${messages.length === 2 ? "reply" : "replies"} · ${messages.some(message => message.toMemberId) ? "includes private messages" : "visible to everyone in this room"}`);
  }

  // Retain unchanged message nodes so new arrivals do not discard text selection or focus.
  // Chromium collapses a selection when its containing node is moved, so the
  // selection is captured up front and restored after the reorder below.
  const savedSelection = captureTimelineSelection(list);
  // Message IDs are caller-controlled and may themselves begin with "work:".
  const keep = new Set(messages.map(m => `message:${m.id}`));
  if (hiddenCount) keep.add(TIMELINE_PAGER_KEY);
  // Board claim lines carry no data-key, so the map above holds only the last
  // one; any left in the list made the reorder below move every message row
  // after them on every arrival. They are repainted after each render.
  list.querySelectorAll(":scope > [data-claim-update]").forEach(node => node.remove());
  for (const [id, node] of previous) if (!keep.has(id) && !node.hasAttribute("data-work-timeline")) node.remove();
  // Work cards are never windowed: only message rows are. Work is few next to
  // messages, and hiding older cards would make that work unreachable from the
  // timeline (the crowded reconnect gate pins all 81 cards). Cards older than the
  // first shown message simply render above it, after the pager.
  const workEntries = currentThreadId || !state ? [] : timelineWorkEntries().filter(e => e.channelId === activeChannelId);
  const ordered = [];
  // One members array per pass keeps the body HTML cache keyed (see createBodyHtmlCache).
  const mentionable = state ? Object.values(state.members) : [];
  messages.forEach((message, index) => {
    const key = `message:${message.id}`;
    const node = previous.get(key) || document.createElement("li");
    const cluster = messageCluster(messages, index);
    const domId = recordDomId("message", message.id);
    if (node.id !== domId) node.id = domId;
    if (node.dataset.key !== key) node.dataset.key = key;
    if (node.dataset.messageRecordId !== message.id) node.dataset.messageRecordId = message.id;
    const muted = isMutedBy(state, session?.member?.id, message.authorId);
    const className = `message${cluster.grouped ? " grouped" : ""}${muted ? " muted" : ""}${session && !muted && messageMentionsMember(message.body, session.member) ? " mentioned" : ""}`;
    if (node.className !== className) node.className = className;
    if (node.getAttribute("tabindex") !== "-1") node.tabIndex = -1;
    const html = messageContent(message, cluster, message.id === unreadAnchorId || message.id === horizonAnchorId, mentionable);
    if (node._content !== html) {
      if (!node._content || !node.querySelector(".message-body")) node.innerHTML = html;
      else {
        const next = document.createElement("div"); next.innerHTML = html;
        // Reply counts/reactions change independently; the selected message text stays put.
        for (const selector of [".chat-divider", ".grouped-time", ".message-avatar", ".message-meta", ".message-body", ".message-files", ".message-context", ".reactions", ".message-links", ".draft-feedback"]) {
          const before = node.querySelector(selector), after = next.querySelector(selector);
          if (selector === ".message-files") {
            if (!after) before?.remove();
            else if (!before) node.querySelector(".message-body")?.insertAdjacentElement("afterend", after);
            else if (before.innerHTML !== after.innerHTML) before.innerHTML = after.innerHTML;
            continue;
          }
          if (!before && !after) continue;
          if (!before) { node.insertBefore(after, node.firstChild); continue; }
          if (!after) { before.remove(); continue; }
          if (before.className !== after.className) before.className = after.className;
          if (selector === ".message-body") {
            // Expansion is local reading state, independent of reactions and
            // edits. Copy it before comparing so unchanged text stays selected.
            const expanded = before.querySelector("details.message-expansion");
            const nextExpanded = after.querySelector("details.message-expansion");
            if (expanded?.open && nextExpanded) nextExpanded.open = true;
          }
          if (before.innerHTML !== after.innerHTML) {
            if (selector === ".draft-feedback") {
              // Feedback changes without replacing the selected text or its controls.
              const label = before.querySelector(".draft-state"), nextLabel = after.querySelector(".draft-state");
              if (label && nextLabel) {
                if (label.textContent !== nextLabel.textContent) label.textContent = nextLabel.textContent;
                const detail = before.querySelector("details"), nextDetail = after.querySelector("details");
                if (detail && nextDetail) {
                  if (detail.querySelector("p").textContent !== nextDetail.querySelector("p").textContent)
                    detail.querySelector("p").textContent = nextDetail.querySelector("p").textContent;
                } else if (detail) detail.remove();
                else if (nextDetail) before.append(nextDetail);
                continue;
              }
            }
            before.innerHTML = after.innerHTML;
          }
        }
      }
      node._content = html;
    }
    // Position is settled once, below, after work cards are interleaved.
    // Placing message nodes at their message index here put them in front of
    // the work cards, which the interleave then had to undo - two moves per
    // render for nodes that were already in the right place, and a focused
    // control inside a moved node loses focus.
    ordered.push(node);
  });
  // Interleave work cards chronologically into the single timeline.
  const msgTs = m => Date.parse(m.createdAt) || 0;
  const workById = new Map();
  for (const entry of workEntries) {
    let wnode = previous.get(`work:${entry.item.id}`);
    if (!wnode || !wnode.hasAttribute("data-work-timeline")) wnode = makeTimelineWorkNode(entry);
    setTimelineWorkNode(wnode, entry.html);
    workById.set(entry.item.id, wnode);
  }
  for (const [key, node] of previous) if (key?.startsWith("work:") && !workById.has(key.slice(5))) node.remove();
  let wi = 0;
  const merged = [];
  if (hiddenCount) {
    let pager = previous.get(TIMELINE_PAGER_KEY);
    if (!pager) {
      pager = document.createElement("li");
      pager.className = "timeline-pager"; pager.dataset.key = TIMELINE_PAGER_KEY;
      const more = document.createElement("button");
      more.type = "button"; more.className = "text-button"; more.dataset.timelineEarlier = "";
      more.textContent = uiText("timeline.earlier");
      pager.append(more);
    }
    merged.push(pager);
  }
  messages.forEach((message, index) => {
    while (wi < workEntries.length && workEntries[wi].ts <= msgTs(message)) merged.push(workById.get(workEntries[wi++].item.id));
    merged.push(ordered[index]);
  });
  while (wi < workEntries.length) merged.push(workById.get(workEntries[wi++].item.id));
  const showInvite = Boolean(session?.member?.id && state?.members?.[session.member.id]?.active !== false);
  if (!messages.length && !workEntries.length) list.innerHTML = `<li class="empty-note">No messages yet. <button type="button" class="text-button" data-empty-write>Write the first one</button>${showInvite ? ' · <button type="button" class="text-button" data-empty-invite>Invite someone</button>' : ""}</li>`;
  else {
    list.querySelectorAll(":scope > .empty-note").forEach(n => n.remove());
    merged.forEach((node, i) => { if (list.children[i] !== node) list.insertBefore(node, list.children[i] || null); });
    while (list.children.length > merged.length) list.lastChild.remove();
  }
  restoreTimelineSelection(list, savedSelection);
  list.dataset.view = view;
  if (!sameView) {
    list.scrollTop = viewPositions.get(view) ?? list.scrollHeight; newVisibleMessages = 0;
    if (viewPositions.has(view)) timelinePin.clear(); else timelinePin.set(view, list);
  } else if ((nearBottom || ownArrival) && !focused) {
    if (pinOnly && !ownArrival) { stickPinnedTimeline(list); if (newCount > 0) scheduleHorizonAdvance(); }
    else { list.scrollTop = list.scrollHeight; timelinePin.set(view, list); }
    newVisibleMessages = 0;
  }
  else {
    if (!pageScroll && anchor?.isConnected) list.scrollTop += anchor.getBoundingClientRect().top - anchorOffset;
    newVisibleMessages += newCount;
  }
  if (focused && !focused.isConnected) {
    const row = [...list.children].find(e => e.dataset.key === focusKey);
    const replacement = focusedMessage ? row : focusedFeedback ? row?.querySelector(".draft-state")
      : [...(row?.querySelectorAll("[data-message-action]") || [])].find(e => e.dataset.messageAction === focusAction && e.dataset.reaction === focusReaction);
    const target = replacement;
    target?.focus({ preventScroll: true });
  }
  // Only when the update dropped focus to the body: a member who moved focus
  // themselves while the render was in flight keeps it.
  if (focusedKey && document.activeElement === document.body) {
    [...list.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusedKey)?.focus({ preventScroll: true });
  }
  // A re-render that trims or reflows the timeline can move the node the member
  // was working on out of view (the page scroll is clamped or the card moves),
  // and restoring focus above uses preventScroll. If it was on screen before and
  // the focused control is not now, bring it back the least amount.
  if (focusedOnScreen && list.contains(document.activeElement) && document.activeElement !== document.body) {
    const now = document.activeElement.getBoundingClientRect();
    if (now.bottom <= 0 || now.top >= innerHeight) document.activeElement.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  $("#new-messages-button").hidden = newVisibleMessages === 0;
  $("#new-messages-button").textContent = `${newVisibleMessages} new ${newVisibleMessages === 1 ? "message" : "messages"} · jump to latest`;
  renderPinned();
  // On narrow screens the page scrolls instead of the timeline. Keep the
  // visible row steady after both message and new-message controls change.
  if (sameView && pageScroll && (!nearBottom || focused) && anchor?.isConnected)
    window.scrollBy({ top: anchor.getBoundingClientRect().top - anchorOffset, behavior: "instant" });
  if (announceCount) $("#conversation-announcement").textContent = `${announceCount} new ${announceCount === 1 ? "message" : "messages"} in ${currentThreadId ? "this thread" : "the room"}. Room event ${client.sequence}.`;
}
function draftFeedbackHTML(message) {
  if (!message.proposal) return "";
  const feedback = draftFeedback(state.workItems[message.workItemId], message);
  const label = feedback?.label ?? "Draft";
return `<p class="form-hint"><a class="source-link draft-state" href="${esc(workHref(message.workItemId))}" data-open-work="${esc(message.workItemId)}">${esc(label)}</a> · based on revision ${esc(message.proposal.basisRevision)}${message.proposal.basisRevision < message.proposal.submittedAtRevision ? " · older work" : ""} · authorship unverified · <button type="button" class="message-to-work" data-portable-work="${esc(message.workItemId)}" data-portable-mode="draft" data-portable-original="${esc(message.id)}" data-focus-key="refine:${esc(message.id)}">Refine draft</button></p>${feedback?.reason ? `<details><summary>Feedback</summary><p>${esc(feedback.reason)}</p></details>` : ""}`;
}
// UI calming #2: per-message actions collapse to Reply + replies-count inline;
// Add reaction, Save as result, Pin, Make this work, Record decision and
// moderation move into one keyboard- and hover-reachable "⋯" overflow menu.
// Reactions otherwise surface only through a long-press / right-click sheet
// (Slack/Discord style) — no always-visible picker. Every action keeps its
// data-message-action wiring, so the work loop is untouched.
function messageLinksHTML(m, { linked, moderation, count, muted, canReact = false }) {
  if (muted) return `<div class="message-links">${moderation}</div>`;
  const saveHtml = !m.deletedAt && m.workItemId && workActions(state.workItems[m.workItemId], state.members[session.member.id]).some(([action]) => action === "complete")
    ? `<button class="message-to-work" type="button" data-message-action="result" data-message-id="${esc(m.id)}">Save as result</button>` : "";
  const reactHtml = canReact
    ? `<button class="message-to-work" type="button" data-message-action="add-reaction" data-message-id="${esc(m.id)}">Add reaction</button>` : "";
  const request = state.replyRequests?.[m.id];
  const clarify = request?.status === "open" && request.recipientId === session.member.id;
  const replyHtml = `<button class="message-to-work" data-message-action="reply" data-message-id="${esc(m.id)}" type="button"${clarify ? ' title="Reply without closing this request"' : ""}>${clarify ? "Clarify" : "Reply"}</button>`;
  const pinHtml = !m.deletedAt ? `<button class="message-to-work" data-message-action="pin" data-message-id="${esc(m.id)}" type="button" aria-pressed="${isPinned(state, m.id)}">${isPinned(state, m.id) ? "Unpin" : "Pin"}</button>` : "";
  // Attention: mark-unread rewinds the read horizon; save/unsave toggles the
  // per-member "later" list. Both ride the ⋯ overflow menu.
  const markUnreadHtml = !m.deletedAt ? `<button class="message-to-work" data-message-action="mark-unread" data-message-id="${esc(m.id)}" type="button" title="Mark unread (u)">Mark unread</button>` : "";
  const laterHtml = !m.deletedAt ? `<button class="message-to-work" data-message-action="save" data-message-id="${esc(m.id)}" type="button" aria-pressed="${savedMessageIds.has(m.id)}">${savedMessageIds.has(m.id) ? "Unsave" : "Save"}</button>` : "";
  const threadHtml = !currentThreadId && count ? `<button class="thread-link" data-message-action="thread" data-message-id="${esc(m.id)}" type="button">${count} ${count === 1 ? "reply" : "replies"} ↗</button>` : "";
  const workHtml = !m.deletedAt && can("steer") && !(m.proposal && m.workItemId)
    ? `<button class="message-to-work" data-message-action="work" data-message-id="${esc(m.id)}" type="button">Make this work</button>` : "";
  const decideHtml = !m.deletedAt && can("decide") && state.members[session.member.id]?.kind === "human"
    ? `<button class="message-to-work" data-message-action="decide" data-message-id="${esc(m.id)}" type="button">Record decision</button>` : "";
  // Own messages only: the author can edit or delete (the server also lets the owner delete; that stays out of this menu).
  const own = !m.deletedAt && m.authorId === session.member.id && !m.proposal;
  const editHtml = own ? `<button class="message-to-work" data-message-action="edit" data-message-id="${esc(m.id)}" type="button">Edit message</button>` : "";
  const deleteHtml = own ? `<button class="message-to-work" data-message-action="delete" data-message-id="${esc(m.id)}" type="button">Delete message</button>` : "";
  const overflow = [reactHtml, saveHtml, pinHtml, markUnreadHtml, laterHtml, workHtml, decideHtml, editHtml, deleteHtml, moderation].filter(Boolean).join("");
  const menu = overflow ? `<details class="message-more"><summary aria-label="More actions for this message" title="More actions">⋯</summary><div class="message-more-menu">${overflow}</div></details>` : "";
  return `<div class="message-links">${requestControls(m)}${linked.map(i => `<a class="work-link" href="${esc(workHref(i.id))}" data-open-work="${esc(i.id)}">↳ ${esc(i.title)}</a>${doneChip(i)}`).join("")}${replyHtml}${threadHtml}${menu}</div>`;
}
// Used reaction chips under one message. The picker lives in the reaction sheet.
function reactionButtonsFor(m) {
  const pills = reactionPills(m.reactions);
  const seen = new Set(pills.map(pill => pill.key));
  const prefix = `${m.id}:`;
  for (const pendingKey of pendingReactions.keys()) {
    if (!pendingKey.startsWith(prefix)) continue;
    const key = pendingKey.slice(prefix.length);
    if (!key || seen.has(key)) continue;
    pills.push({ key, symbol: key, memberIds: [], count: 0 });
    seen.add(key);
  }
  return pills.map(pill => {
    const pending = pendingReactions.get(`${m.id}:${pill.key}`);
    if (!pill.count && !pending) return "";
    const selected = pill.memberIds.includes(session.member.id);
    const labelName = emojiName(pill.key);
    const label = `${pending && !pending.busy ? "Retry " : ""}${labelName}`;
    const who = pill.memberIds.map(name).join(", ");
    return `<button type="button" class="reaction${pill.count ? " used" : ""}" aria-pressed="${selected}" aria-label="${esc(label)} reaction, ${pill.count}" title="${esc(who || `React with ${labelName}`)}" data-message-action="react" data-message-id="${esc(m.id)}" data-reaction="${esc(pill.key)}"${pending?.busy ? " disabled" : ""}><span aria-hidden="true">${pill.symbol}</span><span>${pill.count || ""}</span>${pending && !pending.busy ? " Retry" : ""}</button>`;
  }).join("");
}
function messageFileChips(messageId) {
  const files = roomFilesByMessage.get(messageId) ?? [];
  if (!files.length) return "";
  return `<div class="message-files">${files.map(file => {
    const download = messageFileDownloads.get(file.id);
    return `<span class="file-chip"><button type="button" data-download-file="${esc(file.id)}" data-file-message="${esc(messageId)}" data-focus-key="file-download:${esc(file.id)}" aria-label="${esc(uiText("file.download.action", { filename: fileChipLabel(file.filename) }))}"${download?.busy ? ' aria-disabled="true" aria-busy="true"' : ""}>${esc(fileChipLabel(file.filename))}</button>${download?.status ? `<span role="status">${esc(download.status)}</span>` : ""}</span>`;
  }).join("")}</div>`;
}
async function downloadMessageFile(id, messageId) {
  const file = roomFilesByMessage.get(messageId)?.find(entry => entry.id === id);
  const authSession = client.session, generation = client.generation, roomId = state?.room?.id;
  const owns = () => Boolean(state && session === authSession && client.session === authSession
    && client.generation === generation && state.room?.id === roomId && client.ownsAccountSession()
    && conversation.byId.get(messageId) && !conversation.byId.get(messageId).deletedAt);
  if (!file || file.state !== "committed" || !owns() || messageFileDownloads.get(id)?.busy) return;
  const pending = { busy: true, status: uiText("file.download.pending") };
  messageFileDownloads.set(id, pending); renderMessages();
  try {
    const result = await client.request(client.path(`/files/${encodeURIComponent(id)}`));
    if (!owns() || messageFileDownloads.get(id) !== pending) return;
    const attachment = result?.attachment;
    if (result.roomId !== roomId || attachment?.id !== id || attachment.messageId !== messageId
      || attachment.state !== "committed" || attachment.encoding !== "base64" || typeof attachment.data !== "string"
      || attachment.sha256 !== file.sha256 || attachment.byteLength !== file.byteLength) throw new Error("attachment_unconfirmed");
    const bytes = Uint8Array.from(atob(attachment.data), char => char.charCodeAt(0));
    if (bytes.length !== file.byteLength || bytes.length > COMPOSER_FILE_BYTES) throw new Error("attachment_unconfirmed");
    const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    if (digest !== file.sha256) throw new Error("attachment_unconfirmed");
    if (!owns() || messageFileDownloads.get(id) !== pending) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
    const link = document.createElement("a");
    link.href = url; link.download = file.filename; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    pending.status = uiText("file.download.started");
  } catch (error) {
    if (!owns() || messageFileDownloads.get(id) !== pending) return;
    if ([401, 403].includes(error.status) || error.code === "session_binding_changed") { client.handleFailure(error); return; }
    pending.status = [404, 410].includes(error.status) ? uiText("file.download.unavailable") : uiText("file.download.retry");
  } finally {
    if (owns() && messageFileDownloads.get(id) === pending) { pending.busy = false; renderMessages(); }
  }
}
function renderComposerFiles() {
  const host = $("#composer-attachments");
  if (!host) return;
  host.replaceChildren();
  if (!composerFiles.length) { host.hidden = true; return; }
  host.hidden = false;
  for (const file of composerFiles) {
    const chip = document.createElement("span");
    chip.className = "file-chip";
    const name = fileChipLabel(file.filename);
    const label = document.createElement("span");
    label.textContent = file.status === "uploading" ? `Uploading ${name}…` : file.status === "error" ? `${name} failed` : name;
    const remove = document.createElement("button");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${name}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => {
      composerFiles = composerFiles.filter(entry => entry.id !== file.id);
      renderComposerFiles();
    });
    chip.append(label, remove);
    host.append(chip);
  }
}
async function refreshRoomFiles() {
  if (!state || !session || !client.session) return;
  const generation = client.generation;
  const roomId = state.room?.id;
  try {
    const body = await client.request(client.path("/files"));
    if (generation !== client.generation || state?.room?.id !== roomId) return;
    const next = new Map();
    for (const file of body.files ?? []) {
      if (file.state !== "committed" || !file.messageId) continue;
      const list = next.get(file.messageId) ?? [];
      list.push(file);
      next.set(file.messageId, list);
    }
    roomFilesByMessage = next;
    if (state) renderMessages();
  } catch { /* The last chips stay until the next successful read. */ }
}
async function attachComposerFiles(fileList) {
  if (!state || !client.session || isRoomArchived(state)) return;
  for (const file of [...(fileList ?? [])]) {
    if (file.size > COMPOSER_FILE_BYTES) {
      setComposerError("That file is larger than 1 MB.");
      continue;
    }
    const id = crypto.randomUUID();
    const entry = { id, filename: file.name || "file", mediaType: file.type || "application/octet-stream", status: "uploading" };
    composerFiles = [...composerFiles, entry];
    renderComposerFiles();
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      const payload = attachmentFromBytes({ id, filename: entry.filename, mediaType: entry.mediaType, bytes });
      await client.request(client.path("/files"), { method: "POST", data: payload });
      const current = composerFiles.find(item => item.id === id);
      if (current) current.status = "staged";
    } catch (error) {
      const current = composerFiles.find(item => item.id === id);
      if (current) current.status = "error";
      setComposerError(error?.code === "file_too_large" ? "That file is larger than 1 MB." : (error?.message || "Couldn’t attach that file."));
    }
    renderComposerFiles();
  }
}
async function commitComposerFiles(messageId) {
  const pending = composerFiles.filter(file => file.status === "staged");
  if (!pending.length || !messageId) return;
  for (const file of pending) {
    try {
      await client.request(client.path(`/files/${encodeURIComponent(file.id)}/commit`), { method: "POST", data: { messageId } });
      composerFiles = composerFiles.filter(entry => entry.id !== file.id);
    } catch (error) {
      file.status = "error";
      setComposerError(error?.message || "Couldn’t attach that file to the message.");
    }
  }
  renderComposerFiles();
  await refreshRoomFiles();
}
function messageContent(m, cluster = {}, unreadStart = false, members = Object.values(state.members)) {
  const author = state.members[m.authorId];
  const authorLabel = displayName(m.authorId);
  // E4 moderation: a muted author's message collapses for the muter alone; Report goes to the owner only.
  const muted = isMutedBy(state, session.member.id, m.authorId), other = m.authorId !== session.member.id;
  const moderation = muted ? `<button class="message-to-work" data-message-action="unmute" data-message-id="${esc(m.id)}" type="button">Unmute ${esc(author.displayName)}</button>`
    : other ? `${!m.deletedAt ? `<button class="message-to-work" data-message-action="report" data-message-id="${esc(m.id)}" type="button">Report</button>` : ""}${m.authorId !== state.room.ownerId ? `<button class="message-to-work" data-message-action="mute" data-message-id="${esc(m.id)}" type="button">Mute ${esc(author.displayName)}</button>` : ""}` : "";
  const divider = unreadStart || cluster.dayStart
    ? `<div class="chat-divider${unreadStart ? " unread" : ""}" role="separator">${esc([unreadStart ? "New messages" : "", cluster.dayStart ? cluster.dayLabel : ""].filter(Boolean).join(" · "))}</div>`
    : "";
  const linked = Object.values(state.workItems).filter(i => i.sourceMessageId === m.id || i.id === m.workItemId);
  const parent = conversation.byId.get(m.replyToId);
  const count = (conversation.threads.get(m.id)?.length || 1) - 1;
  const reactionButtons = reactionButtonsFor(m);
  const groupedTime = cluster.grouped
    ? `<time class="grouped-time" datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time>`
    : "";
  return `${divider}${groupedTime}<div class="message-avatar ${author.kind}" aria-hidden="true">${initials(author.displayName)}</div><div class="message-content"><div class="message-meta"><strong>${esc(authorLabel)}</strong>${isPinned(state, m.id) ? `<span class="pinned-chip">Pinned</span>` : ""}<a class="message-time" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" aria-label="Link to message by ${esc(authorLabel)} at ${esc(time(m.createdAt))}"><time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a></div><div class="message-context">${m.toMemberId ? `<span class="audience-chip">To ${esc(name(m.toMemberId))} · private</span>` : ""}${parent && parent.id !== currentThreadId ? `<a class="source-link reply-preview" href="${esc(recordHref("message", parent.id))}" data-open-message="${esc(parent.id)}">↳ ${esc(name(parent.authorId))}: ${parent.deletedAt ? "Message deleted" : esc(clipGraphemes(renderEmojiShortcodes(parent.body ?? ""), 90))}</a>` : ""}</div>${muted ? `<p class="message-body message-muted">Hidden: you muted ${esc(authorLabel)}.</p>` : m.deletedAt ? `<p class="message-body message-tombstone">Message deleted</p>` : `<div class="message-body">${bodyHtmlCache.html(m.body, members, esc, m.id)}</div>${messageFileChips(m.id)}`}<div class="draft-feedback">${muted ? "" : draftFeedbackHTML(m)}</div><div class="reactions" role="group" aria-label="Reactions to message by ${esc(authorLabel)}">${muted || m.deletedAt ? "" : reactionButtons}</div>${messageLinksHTML(m, { linked, moderation, count, muted, canReact: !muted && !m.deletedAt })}</div>`;
}
function mentionsFilterOn() {
  return $("#search-mentions")?.getAttribute("aria-pressed") === "true";
}
// Backlog follow-up 8: "Pinned only" narrows search to state.pins (issue #6 B2).
// Pins are messages, so work results step aside while it is on.
function pinnedFilterOn() {
  return $("#search-pinned")?.getAttribute("aria-pressed") === "true";
}
function renderSearch(now = Date.now()) {
  const query = $("#message-search").value;
  const parsed = parseSearchQuery(query);
  const only = mentionsFilterOn() || parsed.mentionsOnly, pinnedOnly = pinnedFilterOn();
  const active = Boolean(query.trim()) || only || pinnedOnly;
  $("#clear-search").hidden = !query && !mentionsFilterOn() && !pinnedOnly;
  $("#search-results").hidden = !active;
  if (!active) { $("#search-list").replaceChildren(); $("#search-list")._content = null; $("#search-count").textContent = ""; return; }
  const result = searchMessages(state, query, 50, { viewer: session?.member, mentionsOnly: mentionsFilterOn(), pinnedOnly });
  const work = only || pinnedOnly ? { work: [], total: 0 } : searchWork(state, parsed.term || query);
  const total = result.total + work.total, shown = result.messages.length + work.work.length;
  const noun = only && !parsed.term ? (total === 1 ? "mention" : "mentions") : pinnedOnly && !parsed.term ? (total === 1 ? "pinned message" : "pinned messages") : (total === 1 ? "match" : "matches");
  setText("#search-count", `${total} ${noun}${total > shown ? ` · ${shown} shown` : ""} in this room`);
  const list = $("#search-list"), focused = list.contains(document.activeElement) ? document.activeElement.dataset.searchKey : null;
  const empty = only && !parsed.term ? "No one has @-mentioned you yet." : pinnedOnly && !parsed.term ? "Nothing is pinned yet." : pinnedOnly ? "No pinned messages match." : "No matches. Try a name or another phrase.";
  const html = work.work.map(({ item, excerpt }) => `<li><a href="${esc(workHref(item.id))}" data-open-work="${esc(item.id)}" data-search-key="work:${esc(item.id)}"><strong>${esc(item.title)}</strong><span>${esc(excerpt)}</span><small>Work · ${esc(workStatus(item, now).label)}</small></a></li>`).join("")
    + result.messages.filter(m => !isMutedBy(state, session?.member?.id, m.authorId)).map(m => `<li><a href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}" data-search-key="message:${esc(m.id)}"><strong>${esc(name(m.authorId))}</strong><span>${esc(m.deletedAt ? "Message deleted" : clipGraphemes(renderEmojiShortcodes(m.body ?? ""), 240))}</span><small>${m.replyToId ? "Open thread at this reply" : "Open in room"}</small></a></li>`).join("") || `<li class="empty-note">${empty}</li>`;
  if (list._content !== html) { list.innerHTML = html; list._content = html; }
  if (focused) ([...list.querySelectorAll("[data-search-key]")].find(e => e.dataset.searchKey === focused) || $("#message-search")).focus({ preventScroll: true });
}
function saveComposer() {
  drafts.save(composerKey(), { body: $("#message-input").value, toMemberId: $("#message-to-select").value, replyToId, channelId: pendingMessage ? pendingMessage.command.data.channelId : activeChannelId, pending: pendingMessage, files: composerFiles,
    assistantDraft, ...(requestMode ? { mode: requestMode, threadId: currentThreadId } : {}) });
  persistDrafts();
}
function restoreComposer(draft) {
  assistantDraft = draft.assistantDraft ?? null;
  queueMicrotask(() => humanExperience.syncContribution());
  composerFiles = draft.files ?? []; renderComposerFiles();
  $("#message-input").value = draft.body;
  const select = $("#message-to-select");
  if (draft.toMemberId && ![...select.options].some(option => option.value === draft.toMemberId)) {
    select.add(new Option("Previous recipient unavailable", draft.toMemberId));
    select.options[select.options.length - 1].disabled = true;
  }
  select.value = draft.toMemberId; replyToId = draft.replyToId; pendingMessage = draft.pending;
  syncComposerChrome();
}
function requestRunLabel(id) {
  const run = requestRuns[id];
  if (!run || state?.replyRequests?.[id]?.status !== "open") return "";
  const status = run.state === "working" && Date.now() - run.updatedAt > 120000 ? "unknown" : run.state;
  return ({ working: "Agent working", result_ready: "Result saved · delivery pending",
    needs_attention: "Host needs attention · original attempt retained", unknown: "Host connection lost · original attempt retained" })[status] ?? "";
}
async function refreshRequestRuns({ force = false } = {}) {
  if (!state || !session || requestRunsReading || document.hidden) return;
  const openIds = Object.values(state.replyRequests ?? {}).filter(request => request.status === "open").map(request => request.id).sort();
  if (!openIds.length) { requestRuns = {}; requestRunsReadKey = ""; return; }
  const key = JSON.stringify([client.generation, state.room.id, session.member.id, openIds]);
  if (!force && key === requestRunsReadKey) return;
  requestRunsReadKey = key;
  requestRunsReading = true;
  const generation = client.generation, roomId = state.room.id, viewerId = session.member.id;
  try {
    const view = await client.request(client.path("/request-runs"));
    if (generation !== client.generation || view.roomId !== roomId || view.viewerId !== viewerId) return;
    requestRuns = view.runs;
  } catch { /* Last heartbeat still ages into unknown; never claim a new run. */ }
  finally { requestRunsReading = false; }
  if (generation !== client.generation) return;
  for (const node of document.querySelectorAll("[data-request-run]")) node.textContent = requestRunLabel(node.dataset.requestRun);
  // A request arriving during the read still gets its initial status promptly.
  void refreshRequestRuns();
}
setInterval(() => { void refreshRequestRuns({ force: true }); }, 10000);
function requestControls(message) {
  const request = state.replyRequests?.[message.id];
  if (!request) {
    const previous = Object.values(state.replyRequests ?? {}).find(entry => entry.responseMessageId === message.id);
    return previous && replyFollowUp(state, previous.id, session.member.id)
      ? `<button type="button" class="message-to-work" data-message-id="${esc(previous.id)}" data-message-action="request-follow-up">Follow up</button>` : "";
  }
  const own = session.member.id, open = request.status === "open";
  const status = open ? state.members[request.recipientId]?.active === false ? "Recipient unavailable" : "Reply requested"
    : ({ answered: "Answered", declined: "Declined", cancelled: "Cancelled" })[request.status];
  const actions = [];
  if (replyFollowUp(state, request.id, own)) actions.push(["follow-up", "Follow up"]);
  if (open && own === request.recipientId) actions.push(["answered", "Answer request"], ["declined", "Decline"]);
  if (open && (own === request.requesterId || own === state.room.ownerId && session.member.kind === "human")) actions.push(["cancelled", "Cancel request"]);
  return `<span class="request-state">${esc(status)}</span><span class="request-state" data-request-run="${esc(message.id)}" role="status">${esc(requestRunLabel(message.id))}</span>${actions.map(([kind, label]) =>
    `<button type="button" class="message-to-work" data-message-id="${esc(message.id)}" data-message-action="request-${kind}">${label}</button>`).join("")}`;
}
function syncRequestComposer() {
  const mode = requestMode, active = Boolean(mode) || requestReading;
  $("#request-mode-bar").hidden = !active;
  const requestButton = $("#request-reply"), recipientId = $("#message-to-select").value;
  const members = state?.members;
  const recipient = members && Object.hasOwn(members, recipientId) ? members[recipientId] : null;
  const agentTarget = !active && recipientId !== session?.member.id && recipient?.active !== false && recipient?.kind === "agent";
  const requestHost = agentTarget ? $("#composer-toolbar") : $("#composer-options .composer-options-panel");
  if (requestButton.parentElement !== requestHost) requestHost.append(requestButton);
  requestButton.hidden = !state || active;
  const request = mode?.requestMessageId && state?.replyRequests?.[mode.requestMessageId];
  const changed = request && (request.revision !== mode.expectedRequestRevision || request.contextEventId !== mode.contextEventId);
  const label = mode?.followUpRequestId ? "Follow up · Earlier exchange included" : mode?.resultEventId ? "Ask about credit" : mode ? ({ request: "Request a reply", answered: "Answer request", declined: "Decline", cancelled: "Cancel request" })[mode.kind] : "";
  const work = mode?.resultEventId && state?.workItems[mode.workItemId];
  const subject = work ? work.title + (work.receipt?.eventId !== mode.resultEventId ? " · Earlier result" : "")
    : request ? (conversation?.byId.get(request.id)?.deletedAt ? "Message deleted" : (conversation?.byId.get(request.id)?.body ?? "").slice(0, 80)) : "";
  setText("#request-mode-label", requestReading ? "Reading request…" : [label, subject, pendingMessage ? "Retry original" : changed ? "Context changed" : ""].filter(Boolean).join(" · "));
  $("#request-refresh").hidden = !request || Boolean(pendingMessage) || requestReading || request.status !== "open";
  $("#request-exit").disabled = busy;
  const input = $("#message-input"), select = $("#message-to-select"), send = $("#message-form button[type=submit]");
  const archived = Boolean(state) && isRoomArchived(state); // Issue #6 A2: an archived room is read only.
  input.readOnly = Boolean(mode && pendingMessage);
  input.disabled = busy || requestReading || archived;
  select.disabled = busy || requestReading || Boolean(assistantDraft) || Boolean(mode && (mode.kind !== "request" || mode.followUpRequestId || pendingMessage));
  select.required = mode?.kind === "request";
  select.setCustomValidity(mode?.kind === "request" && (!select.value || select.value === session?.member.id) ? "Choose another participant." : "");
  renderComposerLength();
  send.disabled = busy || requestReading || archived || composerOverLimit() || Boolean(request && request.status !== "open" && !pendingMessage);
  const action = pendingMessage && mode ? "Retry original" : mode ? mode.kind === "request" ? "Send request" : mode.kind === "answered" ? "Send answer" : label : "Send";
  send.setAttribute("aria-label", action); send.title = action;
  input.placeholder = archived ? "This room is archived." : composerPlaceholder({ workKind: mode?.kind ?? null, inThread: Boolean(currentThreadId), channelName: activeChannel()?.name ?? DEFAULT_CHANNEL_ID });
  if (active) $("#reply-bar").hidden = true;
  syncComposerChrome();
}
function setRequestMode(mode, initial = {}) {
  saveComposer(); assistantDraft = null; requestMode = mode;
  const key = composerKey();
  if (!drafts.entries.has(key)) drafts.save(key, { body: "", toMemberId: mode.requesterId ?? "", replyToId: mode.requestMessageId ?? currentThreadId, ...initial, pending: null, mode, threadId: currentThreadId });
  else drafts.save(key, { mode });
  restoreComposer(drafts.get(key));
  syncRequestComposer(); renderComposerError(); persistDrafts();
  $("#message-input").focus();
}
async function openRequestMode(kind, id) {
  if (!state || busy || requestReading || requestMode?.requestMessageId === id && pendingMessage) return;
  if (kind === "follow-up") {
    const followUp = replyFollowUp(state, id, session.member.id);
    if (!followUp) { notice("This answer is no longer available for follow-up."); return; }
    const root = conversation.rootById.get(followUp.replyToId);
    if (currentThreadId !== root) switchThread(root);
    setRequestMode(followUp.mode, followUp);
    $("#message-input").scrollIntoView({ block: "nearest", behavior: "instant" });
    return;
  }
  const generation = client.generation, identity = session, epoch = ++requestEpoch;
  const current = () => generation === client.generation && session === identity && epoch === requestEpoch && state;
  requestReading = true; syncRequestComposer();
  try {
    const selected = await client.replyContext(id);
    if (!current()) return;
    await client.refresh();
    if (!current()) return;
    const request = state.replyRequests?.[id], basis = selected.current;
    if (!request || request.status !== "open" || selected.request.revision !== request.revision
      || selected.request.contextEventId !== request.contextEventId) throw new Error("Request changed. Open it again");
    if (kind === "cancelled" ? !basis?.actions?.cancel : !basis?.answerBasis || !basis.actions[kind === "answered" ? "answer" : "decline"])
      throw new Error("This action is unavailable");
    if (basis.contextEventId !== request.contextEventId || kind !== "cancelled" &&
      (basis.answerBasis.expectedRequestRevision !== request.revision || basis.answerBasis.contextEventId !== basis.contextEventId
        || basis.answerBasis.contextSequence !== basis.contextSequence)) throw new Error("Request context could not be confirmed");
    const mode = { kind, requestMessageId: id, expectedRequestRevision: request.revision,
      requesterId: request.requesterId, workItemId: request.workItemId,
      contextEventId: basis.contextEventId, contextSequence: basis.contextSequence };
    if (!validReplyDraft(mode, state)) throw new Error("Request context could not be confirmed");
    requestReading = false;
    if (currentThreadId !== conversation.rootById.get(id)) switchThread(conversation.rootById.get(id));
    setRequestMode(mode);
  } catch (error) {
    if (current()) { client.handleFailure(error); if (state) setComposerError(`${error.message}. Draft kept.`); }
  } finally {
    if (epoch === requestEpoch) { requestReading = false; syncRequestComposer(); }
  }
}
const composerOptions = $("#composer-options");
composerOptions.addEventListener("click", event => {
  if (!event.target.closest("button")) return;
  composerOptions.open = false;
  $("#composer-options-toggle").focus({ preventScroll: true });
}, true);
composerOptions.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !composerOptions.open) return;
  event.preventDefault(); event.stopPropagation(); composerOptions.open = false;
  $("#composer-options-toggle").focus({ preventScroll: true });
});
document.addEventListener("click", event => {
  if (!composerOptions.contains(event.target)) composerOptions.open = false;
});
$("#request-reply").addEventListener("click", () => { if (!state || busy || requestReading) return; setRequestMode({ kind: "request" }); });
$("#recipe-preview-toggle").addEventListener("click", () => {
  const panel = $("#recipe-preview");
  if (!panel) return;
  panel.hidden = !panel.hidden;
  syncRecipePreview();
});
$("#recipe-strip").addEventListener("click", event => {
  const dismissKey = event.target.closest("[data-recipe-dismiss]")?.dataset.recipeDismiss;
  if (dismissKey) { dismissedRecipeChips.add(dismissKey); syncRecipeStrip(); return; }
  const control = event.target.closest("[data-recipe-action]");
  if (!control) return;
  const action = control.dataset.recipeAction;
  $("#settings-dialog").close();
  if (action === "open-catch-up") openCatchUp();
  if (action === "open-chat") { $("#message-input").focus(); }
  if (action === "focus-work") {
    const card = document.getElementById(workDomId(control.dataset.workId));
    card?.scrollIntoView({ block: "nearest", behavior: "instant" }); card?.focus({ preventScroll: true });
  }
  if (action === "draft-review") {
    const item = state?.workItems?.[control.dataset.workId];
    if (!item) return;
    setRequestMode({ kind: "request" }, { body: `Could you review "${item.title ?? control.dataset.workId}"? The result has been waiting for verification.`, toMemberId: control.dataset.to });
  }
});
document.addEventListener("click", event => {
  const resume = event.target.closest("[data-resume-credit]");
  if (resume && state && !busy && !requestReading) {
    const saved = drafts.entries.get(resume.dataset.resumeCredit);
    if (!saved?.mode?.resultEventId || !validReplyDraft(saved.mode, state)) return;
    inboxUI?.showRooms(); switchThread(saved.threadId); setRequestMode(saved.mode);
    $("#message-input").scrollIntoView({ block: "nearest", behavior: "instant" }); return;
  }
  const button = event.target.closest("[data-ask-credit]");
  if (!button || !state || busy || requestReading) return;
  const question = creditQuestion(state, button.dataset.askCredit, session.member.id, button.dataset.resultEvent);
  if (!question) { notice("Result changed. Open it again."); return; }
  inboxUI?.showRooms();
  switchThread(question.replyToId ? conversation.rootById.get(question.replyToId) : null);
  setRequestMode(question.mode, question);
  $("#message-input").scrollIntoView({ block: "nearest", behavior: "instant" });
});
$("#request-exit").addEventListener("click", () => switchThread(currentThreadId, true));
$("#request-refresh").addEventListener("click", () => { if (requestMode?.requestMessageId) openRequestMode(requestMode.kind, requestMode.requestMessageId); });
function persistDrafts() {
  // The composer no longer asks. This tab keeps nonempty drafts until the
  // 12-hour expiry or sign-out. In-memory drafts still work if storage fails.
  if (!session) return;
  recovery.write(draftScope(session), drafts, currentThreadId, composerKey());
}
function switchThread(threadId, focusComposer = false) {
  if (!state || busy || composerFiles.some(file => file.status === "uploading") || (threadId && !conversation.threads.has(threadId))) return;
  const leavingResultQuestion = Boolean(requestMode?.resultEventId);
  requestEpoch++; requestReading = false;
  if (threadId !== currentThreadId || requestMode || assistantDraft) {
    saveComposer(); viewPositions.set(conversationViewKey(), $("#message-list").scrollTop);
    currentThreadId = threadId; requestMode = null; assistantDraft = null;
    restoreComposer(drafts.get(composerKey()));
    // "Also send to channel" is per-send, off by default in every thread.
    $("#also-send-to-channel").checked = false;
  }
  updateReply(); renderMessages(); renderComposerError(); syncRequestComposer();
  if (leavingResultQuestion) renderReturnBrief();
  if (focusComposer) $("#message-input").focus();
  else (currentThreadId ? $("#thread-title") : $("#conversation-title")).focus({ preventScroll: true });
}
function revealMessage(id) {
  if (!state || busy || !conversation.byId.has(id)) return;
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
  if ($("#activity-dialog")?.open) $("#activity-dialog").close();
  if ($("#later-dialog")?.open) $("#later-dialog").close();
  inboxUI?.showRooms();
  const message = conversation.byId.get(id);
  if (messageChannelId(message) !== activeChannelId) setActiveChannel(messageChannelId(message));
  switchThread(message.replyToId ? conversation.rootById.get(id) : null);
  expandTimelineTo(id);
  const row = [...$("#message-list").querySelectorAll("[data-message-record-id]")]
    .find(node => node.dataset.messageRecordId === id);
  // Scroll first: content-visibility: auto skips off-screen rows, and focusing
  // a skipped row is a no-op. Scrolling makes it relevant (rendered), so the
  // subsequent focus lands.
  row?.scrollIntoView({ block: "nearest", behavior: "instant" });
  row?.focus({ preventScroll: true });
  // Nearest can leave a tall message clipped at its bottom. Align its beginning
  // inside the conversation without moving the surrounding page unnecessarily.
  const list = $("#message-list");
  if (row && row.offsetHeight > list.clientHeight) list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  // JDOT-COH-NAV begin
  syncWorkReturnControl();
  // JDOT-COH-NAV end
}
function focusRecord(node) {
  if (!node) return;
  inboxUI?.showRooms();
  node.focus({ preventScroll: true });
  node.scrollIntoView({ block: "nearest", behavior: "instant" });
}
function workRecord(id) {
  return $(`#message-list [data-work-record-id="${CSS.escape(id)}"]`);
}
// A work destination is on the room timeline, never inside the current
// message thread. Leave the thread through the normal draft-saving path before
// looking up its card; close attention/settings overlays before focusing it.
function revealWorkTimeline(id) {
  if (!state?.workItems[id] || busy) return null;
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
  inboxUI?.showRooms();
  switchThread(null);
  const channelId = timelineWorkEntries().find(entry => entry.item.id === id)?.channelId;
  if (channelId && channelId !== activeChannelId) setActiveChannel(channelId);
  return workRecord(id);
}
// JDOT-COH-NAV begin
function revealWork(id) {
  if (activeWorkNavigationId && activeWorkNavigationId !== id) {
    const previous = workRecord(activeWorkNavigationId)?.querySelector(".work-details");
    if (previous) previous.open = false;
  }
  const card = revealWorkTimeline(id);
  if (!card) {
    activeWorkNavigationId = null; activeWorkNavigation = null;
    if (state && !busy) notice("That work is not available in this room.", true);
    syncWorkReturnControl(); return null;
  }
  activeWorkNavigationId = id;
  card.querySelector(".work-details").open = true;
  focusRecord(card);
  syncWorkReturnControl();
  return card;
}
function workNavigationContext() {
  const member = session?.member?.id;
  return state && member && state.members?.[member]?.id === member && state.members[member].active !== false && !$("#main").hidden
    ? `${client.generation}|${session.roomId}|${member}` : null;
}
function workHistoryState() {
  const value = history.state && typeof history.state === "object" ? { ...history.state } : {};
  delete value.roomWorkOrigin; delete value.roomWorkTarget;
  return value;
}
function currentWorkOrigin(id = activeWorkNavigation) {
  const origin = workNavigationOrigins.get(id);
  return origin?.context === workNavigationContext() ? origin : null;
}
function syncWorkReturnControl() {
  const button = $("#work-navigation-return");
  const origin = currentWorkOrigin();
  button.disabled = false;
  button.hidden = !workNavigationContext() || !/^#pr-record\/(work|message)\//.test(location.hash);
  button.textContent = origin ? `Back to ${origin.type === "updates" ? "Updates" : origin.type === "board" ? "Board" : "conversation"}` : "Back to room";
}
function clearWorkNavigation() {
  navigationBoardEpoch++; resetNavigationBoard?.();
  workNavigationEpoch++; workNavigationOrigins.clear(); activeWorkNavigation = null; activeWorkNavigationId = null; workHistoryReplayKey = null;
  const button = $("#work-navigation-return");
  if (button) { button.hidden = true; button.disabled = false; }
}
function captureWorkOrigin(extra = {}) {
  saveComposer();
  const input = $("#message-input"), focus = document.activeElement;
  const board = $("#board-dialog");
  return { context: workNavigationContext(), url: location.href, previous: activeWorkNavigation,
    type: extra.type ?? (board.open ? "board" : "conversation"), ...extra,
    channelId: activeChannelId, threadId: currentThreadId, mode: requestMode,
    selection: [input.selectionStart, input.selectionEnd, input.selectionDirection],
    composerScroll: input.scrollTop, listScroll: $("#message-list").scrollTop,
    windowScroll: [window.scrollX, window.scrollY], focus,
    focusKey: focus?.dataset?.focusKey ?? null,
    searchWorkId: focus?.closest?.("#search-results") ? focus.dataset.openWork : null,
    messageId: focus?.closest?.("[data-message-record-id]")?.dataset.messageRecordId ?? null,
    messageWorkId: focus?.closest?.("[data-open-work]")?.dataset.openWork ?? null,
    claimId: focus?.closest?.("[data-claim-id]")?.dataset.claimId ?? null,
    boardScroll: board.scrollTop, boardBodyScroll: $("#work-board").scrollTop,
    boardColumnsScroll: $("#work-board .board-columns")?.scrollLeft ?? 0 };
}
function sameWorkOrigin(a, b) {
  if (a.type !== b.type || a.channelId !== b.channelId || a.threadId !== b.threadId
    || JSON.stringify(a.mode ?? null) !== JSON.stringify(b.mode ?? null)) return false;
  // JDOT-COH-UPDATES-PAGE begin
  if (a.type === "updates") return ["itemId", "filter", "pageBudget", "scrollTop", "listScrollTop"]
    .every(key => a.updates?.[key] === b.updates?.[key]);
  // JDOT-COH-UPDATES-PAGE end
  if (a.type === "board") return a.claimId === b.claimId && a.focusKey === b.focusKey;
  const key = value => value.focusKey || value.searchWorkId || (value.messageId && `${value.messageId}|${value.messageWorkId}`);
  return key(a) ? key(a) === key(b) : a.focus === b.focus;
}
function showWorkDestination(kind, id, presentation = "details") {
  workNavigationEpoch++; updatesUi?.close();
  if ($("#board-dialog").open) $("#board-dialog").close();
  if (kind === "work" && presentation === "drafts") { revealDrafts(id); activeWorkNavigationId = id; }
  else if (kind === "work") revealWork(id); else revealMessage(id);
  syncWorkReturnControl();
}
function navigateWorkRecord(kind, id, extra = {}) {
  if (!workNavigationContext() || busy) return false;
  if (kind === "work" ? !Object.hasOwn(state.workItems, id) || state.workItems[id]?.id !== id : !conversation?.byId.has(id)) {
    notice("That source is no longer available in this room.", true); return false;
  }
  const presentation = extra.presentation ?? "details";
  const target = recordHref(kind, id), origin = { ...captureWorkOrigin(extra), presentation };
  const current = currentWorkOrigin();
  if (current?.target === target && location.hash === target && history.state?.roomWorkTarget === activeWorkNavigation) {
    // A new surface can inspect the same task without a second URL entry.
    // Its return context changes, while the existing origin entry/ticket survives.
    if (!sameWorkOrigin(current, origin)) workNavigationOrigins.set(activeWorkNavigation,
      { ...origin, url: current.url, previous: current.previous, target, targetUrl: current.targetUrl });
    else if (current.presentation !== presentation) workNavigationOrigins.set(activeWorkNavigation, { ...current, presentation });
    workHistoryReplayKey = null; showWorkDestination(kind, id, presentation);
    return true;
  }
  const ticket = crypto.randomUUID();
  origin.target = target; origin.targetUrl = new URL(target, location.href).href;
  workNavigationOrigins.set(ticket, origin);
  // Preserve this entry's own target when it also becomes the next entry's origin.
  // Only opaque tickets travel in history; private context stays in memory.
  const entry = history.state && typeof history.state === "object" ? history.state : {};
  history.replaceState({ ...entry, roomWorkOrigin: ticket }, "", location.href);
  history.pushState({ ...workHistoryState(), roomWorkTarget: ticket }, "", target);
  activeWorkNavigation = ticket; workHistoryReplayKey = null;
  showWorkDestination(kind, id, presentation);
  return true;
}
async function restoreWorkOrigin(ticket) {
  const origin = currentWorkOrigin(ticket);
  if (!origin || busy) { returnToCurrentRoom(); return; }
  const epoch = ++workNavigationEpoch;
  updatesUi?.cancelPending();
  activeWorkNavigation = currentWorkOrigin(origin.previous) ? origin.previous : null;
  inboxUI?.showRooms();
  if (activeChannelId !== origin.channelId) setActiveChannel(origin.channelId);
  switchThread(origin.threadId && conversation.threads.has(origin.threadId) ? origin.threadId : null);
  if (origin.mode) setRequestMode(origin.mode);
  activeWorkNavigationId = null;
  const priorOrigin = currentWorkOrigin(origin.previous);
  const priorTarget = priorOrigin?.target;
  const priorWork = /^#pr-record\/work\/(.+)$/.exec(priorTarget ?? "");
  if (priorWork) {
    const id = decodeFragment(priorWork[1]), card = id && workRecord(id);
    if (card) {
      const section = priorOrigin.presentation === "drafts" ? card.querySelector(".work-drafts") : card.querySelector(".work-details");
      if (section) section.open = true;
      activeWorkNavigationId = id;
    }
  }
  const input = $("#message-input");
  input.setSelectionRange(...origin.selection); input.scrollTop = origin.composerScroll;
  $("#message-list").scrollTop = origin.listScroll;
  if (origin.type === "updates") {
    if (!await updatesUi.restore(origin.updates)) return;
  } else if (origin.type === "board") {
    $("#tasks-board-open").click();
    const opening = navigationBoardEpoch;
    if (!await navigationBoardReady?.() || opening !== navigationBoardEpoch || epoch !== workNavigationEpoch
      || !currentWorkOrigin(ticket) || !$("#board-dialog").open) return;
    $("#board-dialog").scrollTop = origin.boardScroll;
    $("#work-board").scrollTop = origin.boardBodyScroll;
    const columns = $("#work-board .board-columns"); if (columns) columns.scrollLeft = origin.boardColumnsScroll;
  }
  if (epoch !== workNavigationEpoch || !currentWorkOrigin(ticket)) return;
  window.scrollTo(...origin.windowScroll);
  if (origin.type !== "updates") {
    const usable = node => node?.isConnected && !node.closest("[hidden]") && node.getClientRects().length > 0;
    const keyed = origin.focusKey ? [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === origin.focusKey) : null;
    const claim = origin.claimId ? $(`#work-board [data-claim-id="${CSS.escape(origin.claimId)}"] h4`) : null;
    const search = origin.searchWorkId ? $(`#search-results [data-open-work="${CSS.escape(origin.searchWorkId)}"]`) : null;
    const messageWork = origin.messageId && origin.messageWorkId
      ? $(`#message-list [data-message-record-id="${CSS.escape(origin.messageId)}"] [data-open-work="${CSS.escape(origin.messageWorkId)}"]`) : null;
    const fallback = origin.type === "board" ? $("#board-close") : $("#conversation-title");
    const target = [origin.focus, keyed, search, messageWork, claim].find(usable) ?? fallback;
    target?.focus({ preventScroll: true });
    if (target === fallback) target?.scrollIntoView({ block: "nearest", behavior: "instant" });
  }
  syncWorkReturnControl();
}
function returnToCurrentRoom() {
  updatesUi?.cancelPending(); activeWorkNavigation = null; workNavigationEpoch++;
  const detail = activeWorkNavigationId && workRecord(activeWorkNavigationId)?.querySelector(".work-details");
  if (detail) detail.open = false;
  activeWorkNavigationId = null;
  const destination = new URL(location.href);
  if (session?.roomId) { destination.searchParams.set("room", session.roomId); destination.searchParams.delete("account"); }
  destination.hash = "#pr-view/rooms";
  history.replaceState(workHistoryState(), "", destination.pathname + destination.search + destination.hash);
  updatesUi?.close();
  if ($("#board-dialog").open) $("#board-dialog").close();
  if (workNavigationContext()) { inboxUI?.showRooms(); switchThread(null); focusRecord($("#conversation-title")); }
  syncWorkReturnControl();
}
function replayWorkNavigation() {
  const target = history.state?.roomWorkTarget, back = history.state?.roomWorkOrigin;
  if (!target && !back) return false;
  const key = `${location.href}|${target ?? ""}|${back ?? ""}|${workNavigationContext()}`;
  if (key === workHistoryReplayKey) return true;
  workHistoryReplayKey = key;
  const targetOrigin = currentWorkOrigin(target), backOrigin = currentWorkOrigin(back);
  const returning = backOrigin && backOrigin.url === location.href && (!targetOrigin || activeWorkNavigation === back);
  if (returning) { void restoreWorkOrigin(back); return true; }
  if (targetOrigin && targetOrigin.targetUrl === location.href) {
    activeWorkNavigation = target; workNavigationEpoch++; updatesUi?.close();
    if ($("#board-dialog").open) $("#board-dialog").close();
    const work = /^#pr-record\/work\/(.+)$/.exec(location.hash);
    if (work && targetOrigin.presentation === "drafts" && state?.workItems[decodeFragment(work[1])]) revealDrafts(decodeFragment(work[1]));
    else revealLocationHash();
    syncWorkReturnControl();
    return true;
  }
  activeWorkNavigation = null; updatesUi?.cancelPending();
  // Reloaded/new-tab entries have no private origin: resolve the current URL only.
  if (state) revealLocationHash();
  syncWorkReturnControl(); return true;
}
$("#work-navigation-return").addEventListener("click", () => {
  if (busy) return;
  if (currentWorkOrigin() && history.state?.roomWorkTarget === activeWorkNavigation) {
    $("#work-navigation-return").disabled = true; history.back();
  } else returnToCurrentRoom();
});
// JDOT-COH-NAV end
function revealDrafts(id) {
  const card = revealWorkTimeline(id);
  if (!card) return;
  const choices = card.querySelector('.work-drafts');
  if (!choices) { revealWork(id); return; }
  choices.open = true;
  const summary = choices.querySelector('summary');
  summary.focus({ preventScroll: true });
  summary.scrollIntoView({ block: 'start', behavior: 'instant' });
}
function revealMember(id) {
  if (!state?.members[id] || busy) return;
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
  $("#people-panel").open = true;
  focusRecord([...$("#presence-list").querySelectorAll("[data-member-record-id]")]
    .find(node => node.dataset.memberRecordId === id));
}
function revealRoom() {
  if (!state || busy) return;
  if ($("#settings-dialog")?.open) $("#settings-dialog").close();
  if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
  focusRecord($("#room-title"));
}
function revealEvent(id) {
  if (!state || busy) return;
  openSettings("record-panel");
  focusRecord([...$("#event-list").querySelectorAll("[data-event-record-id]")]
    .find(node => node.dataset.eventRecordId === id));
}
function decodeFragment(value) {
  try { return decodeURIComponent(value); } catch { return null; }
}
function revealLocationHash() {
  if (!location.hash) return;
  const hash = location.hash;
  // Account destinations also work before any room has been opened.
  if (accountClient.session?.authenticated) {
    const requestedRoom = selectedRoomFromLocation();
    // Destination history must not show the current room under another room's
    // URL or silently clear drafts to switch sessions. Re-enter via the picker,
    // whose existing room-switch flow confirms pending writing and access.
    if (state && requestedRoom && requestedRoom !== session.roomId && hash === "#pr-view/rooms") {
      history.replaceState(null, "", "?account=1#pr-view/rooms");
      inboxUI?.showRoomList();
      return;
    }
    if (hash === "#pr-view/room-list") { inboxUI?.showRoomList(); return; }
    if (hash === "#pr-view/inbox") { inboxUI?.open(); return; }
    if (hash === "#pr-view/rooms") {
      if (accountHomeFromLocation()) inboxUI?.showRoomList();
      else inboxUI?.showRooms();
      return;
    }
  }
  if (!state) return;
  // JDOT-COH-NAV begin
  const linkedRoom = selectedRoomFromLocation();
  if (linkedRoom && linkedRoom !== session?.roomId) {
    returnToCurrentRoom();
    notice("That link belongs to another room. Open that room first.", true);
    return;
  }
  // JDOT-COH-NAV end
  const deepRoom = roomIdFromHash(hash);
  if (deepRoom) {
    if (state.room?.id === deepRoom) {
      $("#people-panel").open = true;
      focusRecord($("#people-panel > summary"));
    }
    return;
  }
  const current = /^#pr-record\/(message|work|member|event|room)\/(.+)$/.exec(hash);
  if (current) {
    const id = decodeFragment(current[2]);
    if (id !== null) ({ message: revealMessage, work: revealWork, member: revealMember, event: revealEvent, room: revealRoom }[current[1]])(id);
    return;
  }
  const rawWorkId = decodeFragment(hash.slice(1));
  if (rawWorkId !== null && state.workItems[rawWorkId]) { revealWork(rawWorkId); return; }
  if (hash === "#room-title") { revealRoom(); return; }
  // The first release also emitted namespaced fragments. Preserve those only
  // when they resolve to a real record. Raw legacy work ids take precedence,
  // including valid ids beginning with message-, member-, event-, or work-.
  for (const [prefix, reveal] of [["#message-", revealMessage], ["#work-", revealWork], ["#member-", revealMember], ["#event-", revealEvent]]) {
    if (!hash.startsWith(prefix)) continue;
    const id = decodeFragment(hash.slice(prefix.length));
    const exists = prefix === "#message-" ? conversation.byId.has(id)
      : prefix === "#work-" ? Boolean(state.workItems[id])
      : prefix === "#member-" ? Boolean(state.members[id])
      : state.eventLog.some(event => event.id === id);
    if (id !== null && exists) { reveal(id); return; }
    break;
  }
}
function hasIndependentProducer(i) { return hasReportedProducer(i) && i.receipt.producerId !== i.verifierMemberId; }
function actions(i, scopeOnly = false, now = Date.now()) {
  if (!scopeOnly) return renderWorkActions(i, state.members[session.member.id], { now, busy, esc, workId: i.id });
  return workActions(i, state.members[session.member.id], now).filter(([action]) => ["release", "renew"].includes(action)).map(([action, label]) => `<button type="button" class="button secondary" data-action="${action}" data-work-id="${esc(i.id)}" data-focus-key="work-action:${esc(i.id)}:${action}"${busy ? " disabled" : ""}>${label}</button>`).join("");
}
function helpView(item, now = Date.now()) {
  try { return workHelpContext(state, item.id, session.member.id, new Date(now).toISOString()); }
  catch { return null; } // Invalid or unavailable context never advertises consent.
}
const isHelpAction = action => ["help", "end-help"].includes(action);
const offerStatuses = { "select-offer": "selected", "decline-offer": "declined", "withdraw-offer": "withdrawn", "release-offer": "released" };
const offerLabels = { "offer-help": "Offer help", "select-offer": "Select helper", "decline-offer": "Decline", "withdraw-offer": "Withdraw", "release-offer": "Release" };
const isOfferAction = action => Object.hasOwn(offerLabels, action);
function offersView(item, now = Date.now()) {
  if (offerContextVersion !== 1) return null;
  try { return workOffersContext(state, item.id, session.member.id, new Date(now).toISOString()); }
  catch { return null; }
}
function offerChoice(entry) {
  return offersView(state?.workItems[entry.workId] ?? {})?.offers.find(row => row.offer.id === entry.offerId) ?? null;
}
function pinOffer(entry, item, offerId = entry.offerId) {
  entry.offerId = offerId ?? crypto.randomUUID();
  entry.helpRevision = item.helpWanted?.revision ?? 0;
  entry.helpEventId = item.helpWanted?.eventId ?? null;
  entry.offerRevision = state.helpOffers?.[entry.offerId]?.revision ?? null;
  entry.viewerRevision = state.members[session.member.id]?.revision;
  entry.offererRevision = state.members[state.helpOffers?.[entry.offerId]?.offererId]?.revision ?? null;
}
const currentHelp = () => $("#action-fields").querySelector("#help-current");
const offerField = name => $("#action-fields").querySelector('[id="offer-' + name + '"]');
function helpButton(item, action, label, offerId = null) {
  return `<button type="button" class="button ghost" data-action="${action}" data-work-id="${esc(item.id)}"${offerId ? ` data-offer-id="${esc(offerId)}"` : ""} data-focus-key="work-action:${esc(item.id)}:${action}${offerId ? ":" + esc(offerId) : ""}"${busy ? " disabled" : ""}>${label}</button>`;
}
function helpCard(item, help) {
  const context = offersView(item), rows = context?.offers ?? [];
  const invitation = help?.help?.status === "open" && (help.status === "open" || help.canWithdraw);
  const retained = state.helpOffers && !Array.isArray(state.helpOffers) && Object.values(state.helpOffers).some(offer => offer?.workItemId === item.id);
  if (!invitation && !rows.length && !retained) return "";
  const live = rows.filter(row => ["offered", "selected"].includes(row.offer.status));
  const past = rows.filter(row => !["offered", "selected"].includes(row.offer.status));
  const selected = live.find(row => row.offer.status === "selected");
  const label = selected ? selected.status === "selection_needs_review" ? "Helper · review needed" : "Helper selected"
    : help?.status === "open" ? "Help wanted" : "Help ended";
  const rowHTML = row => {
    const offer = row.offer, label = { offered: "Offered", selected: "Selected", unavailable: "Request changed", selection_needs_review: "Review needed",
      withdrawn: "Withdrawn", declined: "Declined", released: "Released" }[row.status];
    const buttons = [["canSelect", "select-offer"], ["canDecline", "decline-offer"], ["canWithdraw", "withdraw-offer"], ["canRelease", "release-offer"]]
      .filter(([key]) => row[key]).map(([, action]) => helpButton(item, action, offerLabels[action], offer.id)).join("");
    const contribute = row.status === "selected" && offer.offererId === session.member.id ? shareDraftButton(item, offer.id) : "";
    return `<li class="help-offer" data-offer-record-id="${esc(offer.id)}"><div class="help-offer-heading"><strong>${esc(memberLabel(offer.offererId))}</strong><span class="form-hint">${label}</span></div><p>${esc(offer.plan)}</p>${offer.reason ? `<p class="form-hint">${esc(offer.reason)}</p>` : ""}${buttons || contribute ? `<div class="portable-actions">${contribute}${buttons}</div>` : ""}</li>`;
  };
  const capacity = context?.availability.reason;
  const capacityText = { work_offer_limit: "This request has enough offers for now.", member_offer_limit: "Finish an existing offer before adding another.", history_full: "Offer history is full." }[capacity];
  return `<details class="work-help"><summary data-focus-key="work-help:${esc(item.id)}">${label}${live.length && !selected ? ` <span class="form-hint">· ${live.length}</span>` : ""}</summary>
    ${invitation ? `<p class="definition">${esc(help.help.scope)}</p><p class="form-hint">Ends ${esc(new Date(help.help.expiresAt).toLocaleString())}</p>` : ""}
    ${selected ? '<p class="form-hint">Coordination only. Work and permissions stay unchanged.</p>' : ""}
    <div class="portable-actions">${context?.availability.canOffer ? helpButton(item, "offer-help", "Offer help") : ""}${help?.canPublish && invitation ? helpButton(item, "help", "Edit") : ""}${help?.canWithdraw ? helpButton(item, "end-help", "End request") : ""}</div>
    ${capacityText ? `<p class="form-hint">${capacityText}</p>` : ""}
    ${!context ? '<p class="form-hint">Offers unavailable.</p>' : ""}
    ${live.length ? `<ul class="help-offers">${[...live].sort((a, b) => Number(b.offer.status === "selected") - Number(a.offer.status === "selected")).map(rowHTML).join("")}</ul>` : ""}
    ${past.length ? `<details class="offer-history"><summary data-focus-key="offer-history:${esc(item.id)}">Past offers (${past.length})</summary><ul class="help-offers">${past.map(rowHTML).join("")}</ul></details>` : ""}</details>`;
}
function claimStateLabel(i, now = Date.now()) {
  if (activeClaim(i, now)) return "not expired";
  if (i.claim?.status === "superseded") return "superseded";
  if (i.claim?.status === "released") return "released";
  return "expired";
}
function receiptCard(i) {
  if (!i.receipt) return "";
  const receipt = i.receipt;
  const earlier = [...drafts.entries].filter(([, draft]) => draft.mode?.resultEventId && draft.mode.workItemId === i.id
    && draft.mode.resultEventId !== receipt.eventId && (draft.body.trim() || draft.pending) && validReplyDraft(draft.mode, state));
  const resume = earlier.map(([key], index) => `<button type="button" class="button ghost" data-resume-credit="${esc(key)}"
    data-focus-key="resume-credit:${esc(key)}"${busy ? " disabled" : ""}>Continue earlier question${earlier.length > 1 ? " " + (index + 1) : ""}</button>`).join("");
  const reporter = receipt.reportedById ? memberLabel(receipt.reportedById) : "Unknown reporter";
  const producer = receipt.producerAttribution === "reported" && receipt.producerId
    ? memberLabel(receipt.producerId)
    : receipt.producerAttribution === "external-reported" ? `${receipt.externalProducer} · outside room, reported`
      : "Unknown — no producer was reported";
  let verification = "<p>No verification recorded.</p>";
  if (i.verification) {
    const confirmed = i.verification.independenceConfirmed === true;
    const result = i.verification.result.toUpperCase();
    const resultLabel = result === "PASS" && confirmed ? "INDEPENDENT PASS" : result;
    const independence = result === "PASS" && i.independentVerificationRequired
      ? ` · ${confirmed ? "independence confirmed" : "independence not confirmed"}`
      : "";
    verification = `<p><strong>${esc(resultLabel)}</strong> reported by ${esc(memberLabel(i.verification.verifierId))}${independence}: ${esc(i.verification.summary)}</p>`;
  }
  return `<div class="receipt"><p class="receipt-label">REPORTED COMPLETION · NOT AUTOMATIC VERIFICATION</p><dl class="receipt-attribution"><div><dt>Completion reporter</dt><dd>${esc(reporter)}</dd></div><div><dt>Producer</dt><dd>${esc(producer)}</dd></div></dl><p>${esc(receipt.summary)}</p>${receipt.nativeText ? "" : `<a href="${safeUrl(receipt.evidenceUrl)}" target="_blank" rel="noreferrer noopener" data-focus-key="work-evidence:${esc(i.id)}">Open submitted evidence ↗</a>`}<code>${esc(receipt.evidenceVersion)}</code><p>${esc(receipt.nextAction)}</p>${verification}${receipt.producerAttribution !== "reported" ? `<button type="button" class="button ghost" data-ask-credit="${esc(i.id)}" data-result-event="${esc(receipt.eventId)}" data-focus-key="ask-credit:${esc(i.id)}"${busy ? " disabled" : ""}>Ask about credit</button>` : ""}${resume}</div>`;
}
function shareDraftButton(item, key = "task") {
  return `<button type="button" class="button secondary" data-portable-work="${esc(item.id)}" data-portable-mode="draft" data-focus-key="share-draft:${esc(item.id)}:${esc(key)}">Share draft</button>`;
}
// C2: read-only "what this agent can access" preview. Loaded on demand from the
// same one-task read an agent gets (client.workContext), rendered with the room
// roster for names, and kept across snapshot re-renders until closed. It shows
// exactly the omissions the server reports; opening it starts and grants nothing.
const accessPreviews = new Map();
// Typed handoff envelopes (RC-2026-09-19-072): the room's envelope journal
// lists delegations that name a work item (input ref, acceptance check, or
// authority scope). Fetched once per room visit and cached; work cards
// render the linked envelopes through src/handoff-envelope-ui.js so the
// seven sections and the lifecycle badge show in the work view.
const handoffEnvelopes = { receipts: null, loading: false };
function envelopesForWorkItem(workId) { return envelopesForWork(handoffEnvelopes.receipts ?? [], workId); }
function handoffEnvelopeSection(item) {
  const linked = envelopesForWorkItem(item.id);
  if (!linked.length) return "";
  return `<section class="handoff-envelopes" aria-label="Handoffs for this work"><h4>Handoffs (${linked.length})</h4>${handoffEnvelopeListHtml(linked)}</section>`;
}
function ensureHandoffEnvelopes() {
  if (!client || !state || handoffEnvelopes.receipts || handoffEnvelopes.loading) return;
  handoffEnvelopes.loading = true;
  const generation = client.generation;
  client.request(client.path("/collab/envelopes"))
    .then(body => {
      if (client.generation !== generation) return;
      handoffEnvelopes.receipts = Array.isArray(body.envelopes) ? body.envelopes : [];
      syncTimelineWork();
    })
    .catch(() => { if (client.generation === generation) handoffEnvelopes.receipts = []; syncTimelineWork(); })
    .finally(() => { handoffEnvelopes.loading = false; });
}
const BUDGET_LABELS = Object.freeze({ maxRuntimeMs: "Runtime", maxAttempts: "Attempts", maxConcurrent: "Concurrent sessions", maxSpendCents: "Spend cap", spendCents: "Reported spend" });
const budgetValue = (key, value) => value === "unknown" ? "unknown" : key === "maxRuntimeMs" ? (value < 60000 ? `${Math.round(value / 1000)} s` : `${Math.round(value / 60000)} min`) : /Cents$/.test(key) ? `$${(value / 100).toFixed(2)}` : String(value);
function accessPreviewHtml(i) {
  const entry = accessPreviews.get(i.id);
  if (!entry) return "";
  const id = `${workDomId(i.id)}-access`;
  if (entry.error) return `<section class="access-preview" id="${esc(id)}" data-access-panel="${esc(i.id)}" role="region" aria-label="What this agent can access"><p class="form-hint">${esc(entry.error)}</p></section>`;
  const summary = entry.summary, conversation = summary.conversation, sourceId = conversation.sourceMessageIds[0] ?? null;
  const source = state.messages.find(message => message.id === sourceId);
  const conversationLine = conversation.scope === "none" ? "No linked message. The agent sees this task record only, never the conversation."
    : conversation.sourceAvailability === "unavailable" ? `The linked source message (${esc(i.sourceMessageId)}) is not available in this room, so nothing from the conversation is delivered.`
    : `Only the one linked source message${source ? ` <a class="source-link" href="${esc(recordHref("message", source.id))}" data-open-message="${esc(source.id)}">${esc(source.id)}</a> by ${esc(memberLabel(source.authorId))}` : ""}${conversation.sourceAvailability === "deleted" ? " (deleted; only the tombstone remains)" : ""}, and only when the agent asks for it. Not its thread, replies, @mentions or imported channel excerpts.`;
  const evidence = summary.evidence.records.length
    ? summary.evidence.records.map(record => `${esc(humanize(record.record))} · version ${esc(record.evidenceVersion ?? "unknown")}${record.evidenceUrl ? ` · ${esc(record.evidenceUrl)}` : ""}`).join("<br>") + '<br><span class="form-hint">References only; nothing is retrieved or verified by the read.</span>'
    : "No linked evidence yet.";
  const budget = Object.keys(BUDGET_LABELS).map(key => `${BUDGET_LABELS[key]} ${esc(budgetValue(key, summary.budget[key]))}`).join(" · ") + ` · attempts so far ${esc(String(summary.budget.attemptCount))}. Unknown is not unlimited.`;
  const roster = Object.values(state.members).filter(member => member.active !== false);
  const referenced = new Set(summary.participantIds);
  const readers = roster.map(member => `${esc(member.displayName)}${member.kind === "agent" ? " (agent)" : ""}${referenced.has(member.id) ? " · on this task" : ""}`).join(", ");
  return `<section class="access-preview" id="${esc(id)}" data-access-panel="${esc(i.id)}" role="region" aria-labelledby="${esc(id)}-title"><h4 id="${esc(id)}-title">What this agent can access</h4><p class="form-hint">The one-task view an agent reads before it starts, evaluated ${esc(new Date(entry.evaluatedAt).toLocaleString())}. Read-only: opening it starts nothing and grants nothing. Organization allowlists are not available yet.</p><dl class="work-facts"><div><dt>Conversation</dt><dd>${conversationLine}</dd></div><div><dt>Evidence</dt><dd>${evidence}</dd></div><div><dt>Budget</dt><dd>${budget}</dd></div><div><dt>Who can read</dt><dd>Room-wide membership: ${roster.length} active ${roster.length === 1 ? "member" : "members"} share this view — ${readers}. This is not a task-level grant.</dd></div><div><dt>Not included</dt><dd data-access-omitted>${summary.omitted.map(entry => esc(humanize(entry))).join(", ")}</dd></div></dl></section>`;
}
// Claims record which other active claims already held the same paths when
// they were taken (src/events.js claimOverlaps). Show them so both holders talk.
const claimOverlapCount = i => i.claim?.status === "active" ? (i.claim.overlaps ?? []).length : 0;
function claimOverlapHtml(i) {
  if (!claimOverlapCount(i)) return "";
  const rows = i.claim.overlaps.map(o => `<li>${esc(state?.workItems?.[o.workItemId]?.title ?? o.workItemId)} · ${esc(memberLabel(o.holderId))} · ${esc(o.paths.join(", "))}</li>`).join("");
  return `<p class="claim-overlap">Already claimed by others. Talk before you both edit:</p><ul class="claim-overlap-list">${rows}</ul>`;
}
function workCard(i, now, drafts, messages = []) {
  const next = nextWorkStep(i, now), status = workStatus(i, now), help = helpView(i, now);
  // Derived read-time signal only: a pause hint, never a block or a dispatch.
  const loops = coordinationLoops(i, messages);
  const loopNotice = loops.length ? `<p class="loop-warning" data-loop-kind="${esc(loops[0].kind)}"><strong>Possible coordination loop.</strong> ${esc(loops[0].label)}</p>` : "";
  const nextFor = next.memberId ? ` for ${esc(name(next.memberId))}` : "";
  const nextLine = `<p class="work-next-step" data-next-step="${esc(next.action)}"><strong>Next${nextFor}:</strong> ${esc(status.next)}</p>`;
  const source = i.sourceMessageId ? `<a class="source-link" href="${esc(recordHref("message", i.sourceMessageId))}" data-open-message="${esc(i.sourceMessageId)}" data-focus-key="work-source:${esc(i.id)}">From this conversation</a>` : "";
  const continuity = terminalWork(i) ? null : workContinuity(i, now);
  const recovery = continuity?.needsAttention ? `<section class="work-recovery" aria-label="Worker progress"><strong>${esc(continuity.label)}</strong><p>${esc(continuity.next)}</p><button type="button" class="text-button" data-portable-work="${esc(i.id)}" data-portable-progress="true" data-focus-key="work-resume:${esc(i.id)}">Continue with saved context</button></section>` : "";
  const handoff = i.handoff?.open ? `<section class="blocker" data-work-handoff="${esc(i.id)}" aria-label="Work handoff"><strong>Handoff</strong><p>${esc(i.handoff.doneSummary)}</p><p><strong>Next:</strong> ${esc(i.handoff.nextAction)}</p>${source ? `<p><a class="source-link" href="${esc(recordHref("message", i.sourceMessageId))}" data-open-message="${esc(i.sourceMessageId)}" data-focus-key="work-handoff-source:${esc(i.id)}">Open discussion</a></p>` : ""}<details><summary>Why work paused</summary><p>${esc(i.handoff.limitReason)}</p>${i.handoff.haltAll ? "<p>A stop was requested. External process state is unknown.</p>" : ""}</details></section>` : "";
  const blocker = i.blocker ? `<div class="blocker"><strong>Blocked</strong><p>${esc(i.blocker.reason)}</p><p>${esc(i.blocker.nextAction)}</p></div>` : "";
  const decision = i.decision ? `<div class="decision"><strong>${esc(humanize(i.decision.decision))}</strong><p>${esc(i.decision.reason)}</p></div>` : "";
  const claim = i.claim ? `<details class="claim"><summary data-focus-key="work-claim:${esc(i.id)}">Recorded scope · ${esc(claimStateLabel(i, now))}${claimOverlapCount(i) ? ` · <span class="claim-overlap">Overlaps ${claimOverlapCount(i)}</span>` : ""}</summary><p>${esc(memberLabel(i.claim.holderId))}</p><p>${esc(i.claim.repository)}:${esc(i.claim.ref)}</p><p>${esc(i.claim.paths.join(", "))}</p>${claimOverlapHtml(i)}<p>Expires ${esc(new Date(i.claim.expiresAt).toLocaleString())}. External activity is not measured.</p>${actions(i, true, now)}</details>` : "";
  const checks = `<div><dt>Verifier</dt><dd>${i.independentVerificationRequired ? esc(memberLabel(i.verifierMemberId)) : "Not required"}</dd></div><div><dt>Decision</dt><dd>${i.ownerDecisionRequired ? esc(memberLabel(i.humanDecisionMakerId)) : "Not required"}</dd></div>`;
  const updated = `<p class="form-hint">Last recorded update: ${esc(new Date(i.updatedAt).toLocaleString())}. Live execution is not measured.</p>`;
  const attempts = attemptLedger(i);
  const receipts = attemptReceipts(i);
  // G7: silence is never termination - a stale-heartbeat run is labeled
  // unresponsive with process state unknown, never "stopped".
  const unresponsiveRun = cancellationState(i, { nowMs: Date.now() }).unresponsive;
  const attemptsLine = attempts.length ? `<p class="form-hint" data-attempt-ledger="${esc(i.id)}">Attempts: ${attempts.map((a, ix) => `#${a.attempt} ${esc(memberLabel(a.performer))} · ${a.outcome ?? (unresponsiveRun ? "unresponsive - process state unknown" : "running")}${a.environment ? ` · ${esc(a.environment)}` : ""}${receipts[ix]?.successClaim === "unverified" ? " · unverified (missing outputs or measured usage)" : ""}`).join(" · ")}</p>` : "";
  const reuse = can("steer") ? `<button type="button" class="button ghost" data-reuse-work="${esc(i.id)}" data-focus-key="work-reuse:${esc(i.id)}">Use again</button>` : "";
  const latestDraft = drafts[0];
  const alternatives = drafts.length > 1 ? `<details class="work-drafts"><summary data-focus-key="work-drafts:${esc(i.id)}">Drafts (${drafts.length})</summary>${drafts.map(draft =>
`<p><a class="source-link" href="${esc(recordHref("message", draft.id))}" data-open-message="${esc(draft.id)}" data-focus-key="work-draft-message:${esc(draft.id)}">${esc(memberLabel(draft.authorId))} · ${esc(draftFeedback(i, draft)?.label ?? "Draft")}<br><span class="form-hint">${esc([...draft.body].slice(0, 100).join(""))}${[...draft.body].length > 100 ? "…" : ""}</span></a></p>`).join("")}</details>` : "";
  const staleBasis = latestDraft?.proposal && latestDraft.proposal.basisRevision < i.revision ? latestDraft.proposal.basisRevision : null;
  // F3: a stale-basis draft gets a derived read-time explanation of what changed; never a block.
  const changesToggle = staleBasis === null ? "" : `<button type="button" class="button ghost" data-work-changes="${esc(i.id)}" data-basis="${staleBasis}" data-focus-key="work-changes:${esc(i.id)}">What changed since revision ${staleBasis}</button><div class="work-changes-list" data-changes-list="${esc(i.id)}" hidden></div>`;
  const draftLink = i.receipt?.nativeText ? `<button class="source-link" type="button" data-read-result="${esc(i.id)}" data-focus-key="work-native-result:${esc(i.id)}">View result</button>` + alternatives : alternatives || (latestDraft ? `<a class="source-link" href="${esc(recordHref("message", latestDraft.id))}" data-open-message="${esc(latestDraft.id)}" data-focus-key="work-draft:${esc(i.id)}">View latest draft</a>` : "");
  return `<article id="${workDomId(i.id)}" class="work-card" tabindex="-1" data-work-record-id="${esc(i.id)}" data-disclosure-host="${esc(i.id)}" data-focus-key="work:${esc(i.id)}"><div class="work-card-header"><span class="state state-${status.tone}">${esc(status.label)}</span>${doneChip(i)}</div><h3>${esc(i.title)}</h3>${nextLine}${recovery}${handoff}${loopNotice}${draftLink || i.receipt ? `<div class="portable-actions">${draftLink}${i.receipt ? `<button type="button" class="button secondary" data-copy-result="${esc(i.id)}" data-focus-key="work-copy-result:${esc(i.id)}">Copy summary</button>` : ""}</div>` : ""}${changesToggle}${helpCard(i, help)}<details class="work-details"><summary data-focus-key="work-details:${esc(i.id)}">${i.receipt ? "Evidence & details" : "Details"}</summary><span class="mode">${esc(i.mode)} · revision ${i.revision}</span>${source}<p class="definition">${esc(i.definitionOfDone)}</p><dl class="work-facts"><div><dt>Accountable</dt><dd>${esc(memberLabel(i.accountableMemberId))}</dd></div>${checks}</dl>${updated}${attemptsLine}${receiptCard(i)}${blocker}${decision}${claim}<div class="portable-actions">${shareDraftButton(i)}${reuse}${help?.canPublish && help.help?.status !== "open" ? helpButton(i, "help", "Ask for help") : ""}${terminalWork(i) ? "" : `<button type="button" class="button ghost" data-reminder-work="${esc(i.id)}" data-focus-key="work-reminder:${esc(i.id)}">Remind me</button>`}<button type="button" class="button secondary" data-portable-work="${esc(i.id)}" data-focus-key="work-ai:${esc(i.id)}">Use my AI</button><button type="button" class="button ghost" data-portable-work="${esc(i.id)}" data-portable-mode="result" data-focus-key="work-result:${esc(i.id)}">Paste AI draft</button><button type="button" class="button ghost" data-access-preview="${esc(i.id)}" data-focus-key="work-access:${esc(i.id)}" aria-expanded="${accessPreviews.has(i.id) ? "true" : "false"}"${accessPreviews.has(i.id) ? ` aria-controls="${workDomId(i.id)}-access"` : ""}>What this agent can access</button></div>${accessPreviewHtml(i)}${handoffEnvelopeSection(i)}</details><div class="work-actions">${actions(i, false, now)}</div></article>`;
}
// Quiet Focus A4: a failed send reports beside the composer that holds the draft,
// not only in the page-level status area; the Send button is the retry and the
// draft clears only after the service acknowledges the retry.
function releaseSubmission(ticket, { restoreFocus = false } = {}) {
  if (!ticket) return;
  ticket.controls.forEach((control, index) => control.disabled = ticket.disabled[index]);
  ticket.form.removeAttribute("aria-busy");
  if (submitControls === ticket) submitControls = null;
  const target = ticket.focus;
  if (!restoreFocus || ticket.form.id !== "message-form" || !state || !target?.isConnected || target.disabled
    || target.closest("[hidden]") || !target.getClientRects().length || getComputedStyle(target).visibility === "hidden") return;
  if (document.activeElement !== document.body && document.activeElement !== target) return;
  if (document.activeElement !== target) target.focus({ preventScroll: true });
  if (document.activeElement === target && ticket.selection && target.value === ticket.selection.value
    && typeof target.setSelectionRange === "function") {
    const end = target.value.length;
    target.setSelectionRange(Math.min(ticket.selection.start, end), Math.min(ticket.selection.end, end), ticket.selection.direction);
  }
}
// Unified timeline: work items render inline in #message-list, interleaved
// chronologically with messages (Discord/Slack-style). Work cards follow the
// active channel: a card shows when its proposal message is in the channel.
function timelineWorkEntries() {
  const now = Date.now();
  const draftsByWork = new Map();
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (!message.workItemId || !message.proposal) continue;
    if (!draftsByWork.has(message.workItemId)) draftsByWork.set(message.workItemId, []);
    draftsByWork.get(message.workItemId).push(message);
  }
  return Object.values(state.workItems)
    .map(item => {
      const proposals = draftsByWork.get(item.id) ?? [];
      // proposals is built newest-first via reverse iteration; the most recent
      // proposal determines the work card's channel.
      const mostRecent = proposals[0];
      return { item, channelId: mostRecent ? messageChannelId(mostRecent) : DEFAULT_CHANNEL_ID,
        ts: Date.parse(item.updatedAt) || 0, html: workCard(item, now, proposals, state.messages) };
    })
    .sort((a, b) => a.ts - b.ts);
}
function makeTimelineWorkNode(entry) {
  const wnode = document.createElement("li");
  wnode.dataset.key = `work:${entry.item.id}`;
  wnode.setAttribute("data-work-timeline", entry.item.id);
  wnode.className = "tl-work"; wnode.tabIndex = -1;
  return wnode;
}
function setTimelineWorkNode(wnode, html) {
  if (wnode._content === html) return;
  const saved = captureDisclosures(wnode);
  wnode.innerHTML = html; wnode._content = html;
  restoreDisclosures(wnode, saved);
}
// Use the same interleave for background card refreshes and message arrivals.
// Different tie rules moved unchanged cards twice and discarded text selection.
function syncTimelineWork() {
  if (!state) return;
  ensureHandoffEnvelopes();
  renderMessages();
}
async function submit(form, fn, { failureHint } = {}) {
  if (busy) return;
  const operationId = ++submitOperationId;
  const focus = form.contains(document.activeElement) ? document.activeElement : null;
  const selection = focus && typeof focus.selectionStart === "number" ? {
    value: focus.value, start: focus.selectionStart, end: focus.selectionEnd, direction: focus.selectionDirection
  } : null;
  busy = true; const controls = [...form.querySelectorAll("button, input, select, textarea")];
  const disabled = controls.map(e => e.disabled);
  const generation = client.generation;
  const ticket = submitControls = { form, controls, disabled, focus, selection };
  const current = () => operationId === submitOperationId
    && generation === client.generation;
  form.setAttribute("aria-busy", "true"); controls.forEach(e => e.disabled = true);
  const local = form.querySelector(".form-status");
  if (form.id === "message-form") setComposerError("");
  else if (local) setFormStatus(local, "");
  try { await fn(current); }
  catch (error) {
    if (!current()) return;
    const text = `${requestFailureMessage(error)}. ${failureHint ?? (state ? "Your entries were kept; try again." : "Sign in again.")}`;
    // One live-announcement owner per send result: when the form has its own status region
    // it owns the announcement (the visible composer error); the page-level region stays
    // silent so a screen reader announces the failure exactly once.
    if (form.id === "message-form") { clearNotice(); setComposerError(text); }
    else if (local && (!state && local.id !== "auth-error")) clearNotice();
    else if (local) { clearNotice(); setFormStatus(local, text, true); }
    else notice(text, true);
  }
  finally {
    // No `return` in `finally`: it would swallow anything the catch handler threw.
    if (operationId === submitOperationId) {
      busy = false; releaseSubmission(ticket, { restoreFocus: true }); if (state) render();
    }
  }
}
function restoreInvitationSignin() {
  const host = $("#invitation-methods"), auth = $("#auth-signin-ui");
  if (host.contains(auth)) $("#signin-controller").prepend(auth);
  host.hidden = true;
  $("#invitation-signin-choices").hidden = false;
  $("#invitation-signin-back").hidden = true;
}
function confirmInvitationSignin() {
  if (invitationIsCommitting() || !invitation.secret) return false;
  const hasDraft = drafts.hasText() || inboxUI?.hasPending() || portableWorkUI?.hasDraft()
    || resultCopyUI?.hasDraft() || remindersUI?.hasPending() || agentConnectionsUI?.hasPending()
    || instructionsUI?.hasPending() || ownerOffersUI?.hasPending() || !$("#new-work-form").hidden || pendingAction;
  return !hasDraft || window.confirm("Signing in clears unsent drafts and private setup. Continue?");
}
$("#invitation-email").addEventListener("click", () => {
  if (invitationIsCommitting() || !invitation.secret || !signinUI.canLeave()) return;
  $("#invitation-methods").prepend($("#auth-signin-ui"));
  $("#invitation-methods").hidden = false;
  $("#invitation-signin-choices").hidden = true;
  $("#invitation-signin-back").hidden = false;
  signinUI.showPassword();
});
$("#invitation-google").addEventListener("click", event => {
  if (!confirmInvitationSignin() || !signinUI.canLeave()) { event.preventDefault(); return; }
  stashInviteForOAuth();
});
$("#invitation-signin-back").addEventListener("click", () => {
  if (!signinUI.canLeave()) return;
  signinUI.closeEmail();
  restoreInvitationSignin();
  $("#invitation-email").focus();
});
$("#invitation-dismiss").addEventListener("click", () => closeInvitation());
$("#invitation-retry").addEventListener("click", () => { if (invitation.phase === "preview-failed") previewCurrentInvitation(); });
for (const id of ["invitation-dialog", "work-dialog", "action-dialog", "result-dialog", "room-actions-dialog", "decision-dialog", "board-dialog", "catchup-dialog", "settings-dialog"]) $(`#${id}`).addEventListener("keydown", e => {
  if (e.key !== "Tab") return;
  const controls = [...e.currentTarget.querySelectorAll("button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, a[href], [tabindex]:not([tabindex='-1'])")]
    .filter(element => element.getClientRects().length > 0);
  const first = controls[0], last = controls.at(-1), active = document.activeElement;
  if (!first || !controls.includes(active) || (e.shiftKey ? active === first : active === last)) {
    e.preventDefault();
    (e.shiftKey ? last : first)?.focus();
    if (!first) (id === "invitation-dialog" ? $("#invitation-title") : e.currentTarget).focus();
  }
});
$("#invitation-dialog").addEventListener("cancel", e => {
  e.preventDefault();
  closeInvitation();
});
$("#invitation-accept").addEventListener("click", async () => {
  const preview = invitation.preview;
  const accountSession = accountClient.session;
  if (!invitation.secret || !preview || !accountSession?.authenticated || !accountSession.account || invitationIsCommitting() || invitation.phase === "terminal") return;
  const version = invitation.version, secret = invitation.secret;
  if (preview.status === "accepted") {
    invitation.phase = "opening";
    setInvitationFeedback("Confirming this browser account before opening the Room…");
    renderInvitation();
    if (state) client.disconnect();
    try {
      const fresh = await accountClient.restore();
      if (!currentInvitation(version, secret)) return;
      if (!sameAccountTuple(accountSession, fresh)) {
        if (state) { accessEndContext = "account-switch"; client.endAccess(); }
        invitation.phase = "changed-account";
        setInvitationFeedback("The browser account changed. Sign in with the account that accepted this invitation.", true);
        renderInvitation();
        return;
      }
      await openAcceptedRoom(preview.roomId, "Room opened with your current membership.", { acceptanceConfirmed: false });
    } catch (error) {
      if (!currentInvitation(version, secret)) return;
      if (state) { accessEndContext = "account-switch"; client.endAccess(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("The browser account could not be confirmed. Sign in again before opening the Room.", true);
      renderInvitation();
    }
    return;
  }
  if (preview.status !== "pending") return;
  invitation.redemptionId ||= crypto.randomUUID();
  const redemptionId = invitation.redemptionId;
  invitation.phase = "accepting";
  setInvitationFeedback("Accepting the exact membership scope…");
  renderInvitation();
  let receipt = null;
  try {
    receipt = await accountClient.acceptInvitation({ invitationToken: secret, redemptionId, expectedRevision: preview.revision });
    if (!currentInvitation(version, secret)) return;
    if (!receipt) {
      if (state) { accessEndContext = "account-switch"; client.endAccess(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("We could not safely attribute the response because the browser account changed. Sign in again to reconcile this invitation.", true);
      renderInvitation();
      return;
    }
    if (state) client.disconnect();
    const fresh = await accountClient.restore();
    if (!currentInvitation(version, secret)) return;
    if (!sameAccountTuple(accountSession, fresh) || !sameAccountTuple(receipt.session, fresh)) {
      if (state) { accessEndContext = "account-switch"; client.endAccess(); }
      invitation.phase = "changed-account";
      setInvitationFeedback("We could not safely attribute the acceptance because the browser account changed. Sign in again to reconcile it.", true);
      renderInvitation();
      return;
    }
    await openAcceptedRoom(receipt.invitation.roomId, receipt.duplicate
      ? "Invitation already accepted; the Room is now open."
      : "Membership accepted. Welcome to the Room.");
  } catch (error) {
    if (!currentInvitation(version, secret)) return;
    if (error.code === "invitation_account_mismatch") {
      invitation.phase = "wrong-account";
      setInvitationFeedback("This invitation is for another account. Sign in with that account to continue.", true);
    } else if (error.code === "invitation_already_used") {
      if (state) client.disconnect();
      try {
        const fresh = await accountClient.restore();
        if (!currentInvitation(version, secret)) return;
        if (!sameAccountTuple(accountSession, fresh)) throw new Error("Browser account changed");
        await openAcceptedRoom(preview.roomId, "Invitation already accepted; the Room is now open.");
        return;
      } catch {
        if (!currentInvitation(version, secret)) return;
        if (state) { accessEndContext = "account-switch"; client.endAccess(); }
        invitation.phase = "changed-account";
        setInvitationFeedback("The invitation may already be accepted, but this browser account could not be confirmed. Sign in again to reconcile it.", true);
      }
    } else if (["invitation_expired", "invitation_revoked", "invitation_authority_changed", "stale_invitation_revision"].includes(error.code)) {
      invitation.phase = "terminal";
      setInvitationFeedback(`${error.message}. No membership was created by this request.`, true);
    } else if (!Number.isSafeInteger(error.status)) {
      invitation.phase = "unknown";
      setInvitationFeedback("We could not confirm whether acceptance completed. Retry uses the same redemption ID and will not create a second membership.", true);
    } else {
      invitation.phase = "ready";
      setInvitationFeedback(`${error.message}. No success is claimed; review and try again.`, true);
    }
    renderInvitation();
  }
});
function mainSigninHost() {
  return $("#auth-panel").contains($("#auth-signin-ui"));
}
function focusSignin() {
  signinUI.focus();
}
function syncSigninView(view) {
  const previous = signinView;
  signinView = view;
  if (!mainSigninHost()) return;
  const auxiliary = view !== "welcome" && !view.startsWith("password-");
  if (!signinHistoryReplay && (auxiliary || previous === "welcome" && view.startsWith("password-")) && previous !== view) {
    if (previous.startsWith("password-")) {
      const base = { ...history.state };
      base.roomSigninView = previous; delete base.roomSigninStep;
      history.replaceState(base, "", location.href);
    }
    const sameFlow = previous.startsWith("magic-") && view.startsWith("magic-")
      || previous.startsWith("reset-") && view.startsWith("reset-");
    history[sameFlow ? "replaceState" : "pushState"]({ ...history.state, roomSigninView: view }, "", location.href);
  }
  $(auxiliary ? "#email-auth-panel" : "#signin-controller").prepend($("#auth-signin-ui"));
  $("#email-auth-panel").hidden = !auxiliary;
  $("#email-auth-step").hidden = !auxiliary;
  $("#signin-methods").hidden = auxiliary;
  $("#signin-entry-routes").hidden = auxiliary;
  $("#google-signin").hidden = view === "welcome";
  $("#terms-notice").hidden = view === "welcome";
}
function showSigninMethods() {
  $("#agent-auth-step").hidden = true;
  $("#agent-signin-button").setAttribute("aria-expanded", "false");
  $("#signin-controller").prepend($("#auth-signin-ui"));
  signinUI.showPassword();
  syncSigninView("password-login");
}
function openEmailAuth(mode, { recordHistory = true } = {}) {
  if (!agentSigninUI.canLeave() || !signinUI.canLeave()) return;
  signinHistoryReplay = !recordHistory;
  try { mode === "password" ? signinUI.showPassword() : signinUI.showMagic(); }
  finally { signinHistoryReplay = false; }
  focusSignin();
}
function openAgentSignin() {
  if (!signinUI.canLeave()) return;
  showSigninMethods();
  $("#signin-methods").hidden = true;
  $("#signin-entry-routes").hidden = true;
  $("#agent-auth-step").hidden = false;
  $("#agent-signin-button").setAttribute("aria-expanded", "true");
  ($("#agent-signin-ui input:not([type=hidden])") || $("#agent-auth-back"))?.focus();
}
$("#agent-signin-button").addEventListener("click", openAgentSignin);
$("#agent-auth-back").addEventListener("click", () => {
  if (!agentSigninUI.leave()) return;
  showSigninMethods();
  $("#agent-signin-button").focus();
});
function handleSigninBack() {
  if (mainSigninHost() && history.state?.roomSigninView) {
    history.back(); return false;
  }
  return true;
}
window.addEventListener("popstate", event => {
  if ($("#auth-panel").hidden || !mainSigninHost()) return;
  if (!signinUI.canLeave()) { history.forward(); return; }
  signinHistoryReplay = true;
  try { signinUI.showView(event.state?.roomSigninView || "password-login"); }
  finally { signinHistoryReplay = false; }
  focusSignin();
});
// Preserve guide deep links through sign-in, then open the Advanced guide.
$("#connect-guide-copy").innerHTML = uiText("guide.instructions");
let pendingAgentGuide = location.hash === "#join-agent";
function revealAgentSigninLink() {
  if (!pendingAgentGuide || !state || session?.member?.kind !== "human") return;
  pendingAgentGuide = false;
  $("#connect-guide-dialog").showModal();
}
$("#connect-guide-open").addEventListener("click", () => $("#connect-guide-dialog").showModal());
$("#connect-guide-close").addEventListener("click", () => $("#connect-guide-dialog").close());
$("#signout-button").addEventListener("click", () => $("#connect-guide-dialog").close(), true);
revealAgentSigninLink();
// Agent instructions always name the host currently serving this page.
const joinAgentPrompt = () => `Read ${location.origin}/llms.txt and join using the original shared invitation I gave you.`;
function fillJoinAgent() {
  const field = $("#join-agent-prompt");
  if (!field) return;
  field.value = joinAgentPrompt();
  for (const [id, path] of [["#join-agent-card", "/.well-known/agent.json"], ["#join-agent-kits", "/kits.txt"]]) {
    const link = $(id);
    if (link) link.href = `${location.origin}${path}`;
  }
}
fillJoinAgent();
$("#join-agent-copy")?.addEventListener("click", async () => {
  const field = $("#join-agent-prompt"), status = $("#join-agent-status");
  // .form-status is display:none until it carries .visible, so setting the
  // text alone writes a message nobody sees.
  const say = text => { if (status) { status.textContent = text; status.classList.add("visible"); } };
  try {
    const write = navigator.clipboard?.writeText?.(field.value);
    if (!write) throw new Error("clipboard");
    // The same bound the rest of the app uses: a clipboard promise that never
    // settles must not leave the control looking stuck.
    await Promise.race([write, new Promise((_, reject) => setTimeout(() => reject(new Error("clipboard")), 800))]);
    say("Copied. Paste it into your agent.");
  } catch {
    // This fallback works precisely because the prompt is visible: select it
    // for them and say so, rather than failing with nothing to copy.
    field.select?.();
    say("Copy the selected text.");
  }
});
// C1: mobile session menu (short header) - toggle, Escape, outside click.
installRoomLayout();
const humanExperience = installHumanExperience({ getState: () => state, getSession: () => session, client, notice,
  openWork: id => revealWork(id), openMessage: id => revealMessage(id),
  getContribution: () => assistantDraft, endContribution: () => switchThread(currentThreadId),
  startContribution: (sourceMessageId, intent) => {
    const source = conversation?.byId.get(sourceMessageId);
    if (!source || source.deletedAt || source.toMemberId || busy || requestReading || composerFiles.some(file => file.status === "uploading")) return false;
    if (state.channels?.[messageChannelId(source)]?.archivedAt) return false;
    // Both navigation helpers save the departing draft before restoring the destination.
    setActiveChannel(messageChannelId(source));
    switchThread(conversation.rootById.get(sourceMessageId), true);
    // The ask owns a draft within the existing store. The destination thread's
    // text, recipient and reply target stay intact, including a private draft.
    saveComposer(); assistantDraft = { ...intent, sourceMessageId };
    const key = composerKey();
    if (!drafts.entries.has(key)) drafts.save(key, { body: "", toMemberId: "", replyToId: sourceMessageId, pending: null });
    if (!drafts.get(key).pending) drafts.save(key, { assistantDraft });
    restoreComposer(drafts.get(key));
    updateReply(); syncRequestComposer(); saveComposer();
    return true;
  }, selectResult: (id, messageId) => openWorkAction(state.workItems[id], "complete", messageId), refreshTranscript: () => { if (state) renderMessages(); } });
const sessionMenu = $("#session-menu");
const sessionMenuButton = $("#session-menu-button");
const setSessionMenuOpen = open => {
  sessionMenu.classList.toggle("open", open);
  sessionMenuButton.setAttribute("aria-expanded", String(open));
};
sessionMenuButton.addEventListener("click", () => setSessionMenuOpen(!sessionMenu.classList.contains("open")));
$("#clear-session-menu")?.addEventListener("click", () => { setSessionMenuOpen(false); void clearSavedBrowserSession(); });
$("#create-account-button")?.addEventListener("click", () => {
  setSessionMenuOpen(false);
  // Guest upgrade: stash the room so signup returns here. The room session
  // cookie is left intact — onSignedIn restores it after account creation.
  if (state?.room?.id) {
    try { localStorage.setItem("pr-last-room", state.room.id); } catch {}
    try { localStorage.setItem("pr-last-room-title", state.room.title ?? ""); } catch {}
  }
  $("#main").hidden = true;
  $("#auth-panel").hidden = false;
  configureAuthPanel(state?.room?.id);
  signinUI.showPassword("signup");
  focusSignin();
});
document.addEventListener("keydown", event => {
  if (event.key === "Escape" && sessionMenu.classList.contains("open")) {
    setSessionMenuOpen(false);
    sessionMenuButton.focus();
  }
});
document.addEventListener("click", event => {
  if (sessionMenu.classList.contains("open") && !sessionMenu.contains(event.target)) setSessionMenuOpen(false);
});

$("#account-settings-button").addEventListener("click", openAccountSettings);
$("#account-profile-button").addEventListener("click", () => {
  if (!accountClient.session?.authenticated) return;
  setSessionMenuOpen(false);
  $("#account-profile-dialog").showModal();
  void profileSettingsUI.mount($("#account-profile-body"));
});
$("#account-profile-close").addEventListener("click", () => $("#account-profile-dialog").close());
$("#account-profile-dialog").addEventListener("close", () => {
  if ($("#account-profile-dialog").open) return;
  profileSettingsUI.reset();
  if (accountClient.session?.authenticated) $("#session-menu-button").focus();
});
$("#signout-button").addEventListener("click", async () => {
  if (!state && accountClient.session?.authenticated) {
    if (signoutLoading || busy || invitationIsCommitting()) return;
    if (inboxUI.hasPending() && !window.confirm("Log out and clear unsent drafts? Saved replies stay.")) return;
    recovery.clear();
    const operation = ++signoutOperationId;
    signoutLoading = true; $("#signout-button").disabled = true;
    try {
      const ended = await accountClient.logout();
      if (operation !== signoutOperationId) return;
      if (ended || !accountClient.session) endAccountAccess();
    } catch {
      if (operation !== signoutOperationId) return;
      if (!accountClient.session) {
        endAccountAccess(); setFormStatus($("#auth-error"), "Sign-out unconfirmed. Sign in to check your account.", true);
      } else { $("#account-status").textContent = "Couldn’t sign out. Try again."; $("#account-status").hidden = false; }
    } finally {
      if (operation === signoutOperationId) { signoutLoading = false; $("#signout-button").disabled = false;
        $("#auth-panel").setAttribute("aria-busy", "false"); }
    }
    return;
  }
  if (busy || signoutLoading || !state || !session || invitationIsCommitting()) return;
  saveComposer();
  if (drafts.hasText() || inboxUI?.hasPending() || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending() || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || ownerOffersUI?.hasPending() || !$("#new-work-form").hidden || pendingAction) {
    if (!window.confirm((pendingAction?.uncertain || instructionsUI?.hasUnknown() || ownerOffersUI?.hasUnknown()) ? "Log out and clear drafts and the pending retry? The action may already be saved." : "Log out and clear unsent drafts and private setup on this device?")) return;
  }
  recovery.clear();
  const operationId = ++signoutOperationId;
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const isCurrentOperation = () => operationId === signoutOperationId && sameSession(generation, roomId, memberId);
  signoutLoading = true; $("#signout-button").disabled = true;
  try { await client.logout(); }
  catch (error) {
    if (!isCurrentOperation()) return;
    if ([401, 403].includes(error.status)) client.endAccess();
    else notice("Sign-out could not be confirmed. Session may still be active; retry when connected.", true);
  } finally {
    if (operationId === signoutOperationId) {
      signoutLoading = false;
      $("#auth-panel").setAttribute("aria-busy", "false");
      if (state) $("#signout-button").disabled = false;
      else {
        configureAuthPanel();
        const ended = "Session ended; private drafts were cleared.";
        if ($("#auth-error").textContent !== ended) setFormStatus($("#auth-error"), ended, true);
        if (!$("#invitation-dialog").open) queueMicrotask(() => focusSignin());
      }
    }
  }
});
$("#refresh-button").addEventListener("click", async () => {
  if (!state && accountClient.session?.authenticated) {
    if (await confirmAccount()) { showAccountWorkspace(); if (!$("#account-rooms-panel").hidden) loadAccountRooms(); }
    return;
  }
  const operationId = ++refreshOperationId;
  const generation = client.generation, roomId = session?.roomId, memberId = session?.member.id;
  try {
    if (!client.session) {
      const requestedRoom = selectedRoomFromLocation();
      if (requestedRoom) {
        const account = await ensureAccountSession();
        if (!account?.authenticated) throw Object.assign(new Error("Account sign-in required"), { status: 401 });
        await client.restore(requestedRoom);
      } else await client.restore();
    }
    else {
      await client.refresh();
      if (operationId !== refreshOperationId || !sameSession(generation, roomId, memberId)) return;
      client.connect();
    }
  }
  catch (error) {
    if (operationId !== refreshOperationId) return;
    if (roomId && !sameSession(generation, roomId, memberId)) return;
    if (!roomId && client.session) return;
    if (!roomId) {
      const signedOut = [401, 403].includes(error.status);
      setFormStatus($("#auth-error"), signedOut ? "" : unreachableRoomMessage(error), true);
      setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
      return;
    }
    handleFailureNotice(error);
  }
});
// A DM refused by the explicit-denial gate (blocked/rejected/revoked) names
// the recipient and the next step, instead of surfacing the raw gate
// message. Returns null when the error is not a DM denial.
function mapDmConsentRefusal(command, error) {
  if (command?.data?.toMemberId && DM_CONSENT_REFUSAL_CODES.includes(error.code)) {
    const peer = state?.members?.[command.data.toMemberId];
    return Object.assign(new Error(dmConsentFailureMessage(error, peer?.displayName)), { code: error.code, status: error.status });
  }
  return null;
}
$("#message-form").addEventListener("submit", e => {
  e.preventDefault(); hideMentions(); if (!state || busy || requestReading) return;
  if (isRoomArchived(state)) { setComposerError("This room is archived and read only."); return; }
  if (activeChannel()?.archivedAt) { setComposerError("This channel is archived."); return; }
  if (composerOverLimit()) { renderComposerLength(); return; }
  if (requestMode) { submitRequest(e.currentTarget); return; }
  const content = { body: $("#message-input").value.trim(), toMemberId: $("#message-to-select").value || null, replyToId, channelId: activeChannelId };
  const askRoom = humanExperience.intent(content);
  if (!content.body) return;
  if (composerFiles.some(file => file.status === "uploading")) { setComposerError("Wait for the file to finish attaching."); return; }
  // "Also send to channel": a public thread reply also lands as a top-level
  // message in the channel (server-side, same event). Only offered for
  // public thread replies — never for DMs or top-level messages.
  if (currentThreadId && !content.toMemberId && content.replyToId && $("#also-send-to-channel").checked) {
    content.alsoSendToChannel = true;
  }
  const previous = pendingMessage?.command?.data;
  const unchanged = previous && previous.body === content.body && previous.toMemberId === content.toMemberId && previous.replyToId === content.replyToId && (previous.channelId ?? DEFAULT_CHANNEL_ID) === content.channelId && Boolean(previous.alsoSendToChannel) === Boolean(content.alsoSendToChannel);
  // Preserve the exact legacy payload, including an omitted default channel.
  const data = unchanged ? previous : { messageId: crypto.randomUUID(), ...content };
  pendingMessage = draftCommand(pendingMessage, T.MESSAGE_POSTED, data);
  saveComposer();
  const generation = client.generation, draftKey = composerKey();
  submit(e.currentTarget, async () => {
    // Ownership must outlive pendingMessage: the command can commit while its immediate
    // snapshot fails, then first appear on a later refresh after the draft was cleared.
    locallyOwnedMessageIds.add(data.messageId || pendingMessage.command.id);
    try {
      await client.send(pendingMessage.command);
    } catch (error) {
      if (generation !== client.generation || !state) return;
      throw mapDmConsentRefusal(pendingMessage.command, error) ?? error;
    }
    if (generation !== client.generation || !state) return;
    await commitComposerFiles(data.messageId);
    if (generation !== client.generation || !state) return;
    drafts.clear(draftKey);
    $("#message-input").value = ""; pendingMessage = null; clearReply();
    $("#also-send-to-channel").checked = false;
    persistDrafts();
    if (assistantDraft) {
      assistantDraft = null; restoreComposer(drafts.get(composerKey()));
      updateReply(); syncRequestComposer(); persistDrafts();
    }
    await humanExperience.posted(data.messageId, askRoom);
    maybeShowGuestUpgradeHint();
  }, { failureHint: "Draft kept. Send again to retry." });
});
$("#composer-attach")?.addEventListener("click", () => $("#composer-file")?.click());
$("#composer-file")?.addEventListener("change", event => {
  const input = event.currentTarget;
  void attachComposerFiles(input.files);
  input.value = "";
});
$("#message-form")?.addEventListener("dragover", event => {
  if (![...(event.dataTransfer?.items ?? [])].some(item => item.kind === "file")) return;
  event.preventDefault();
  $("#message-form").classList.add("composer-drop");
});
$("#message-form")?.addEventListener("dragleave", () => $("#message-form").classList.remove("composer-drop"));
$("#message-form")?.addEventListener("drop", event => {
  const files = event.dataTransfer?.files;
  if (!files?.length) return;
  event.preventDefault();
  $("#message-form").classList.remove("composer-drop");
  void attachComposerFiles(files);
});
$("#message-input")?.addEventListener("paste", event => {
  const files = [...(event.clipboardData?.files ?? [])];
  if (!files.length) return;
  event.preventDefault();
  void attachComposerFiles(files);
});
// Channel creation and management: any member can create a channel; only the
// room owner renames or archives. Archive is a two-click arm, never a native dialog.
let channelDialogMode = null, channelArchiveArmed = false;
function openChannelDialog(mode, channelId = null) {
  if (!state) return;
  channelDialogMode = { mode, channelId };
  channelArchiveArmed = false;
  const channel = channelId ? state.channels[channelId] : null;
  $("#channel-dialog-title").textContent = mode === "create" ? "New channel" : "Channel settings";
  $("#channel-save-button").textContent = mode === "create" ? "Create channel" : "Rename channel";
  $("#channel-name-input").value = channel?.name ?? "";
  const archiveButton = $("#channel-archive-button");
  archiveButton.hidden = !(mode === "manage" && channelId !== DEFAULT_CHANNEL_ID);
  archiveButton.textContent = "Archive channel";
  setFormStatus($("#channel-form-status"), "");
  if (!$("#channel-dialog").open) $("#channel-dialog").showModal();
  $("#channel-name-input").focus();
  $("#channel-name-input").select();
}
async function waitForChannel(id, timeoutMs = 8000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (state?.channels?.[id] && !state.channels[id].archivedAt) return true;
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  return Boolean(state?.channels?.[id]);
}
$("#create-channel-button").addEventListener("click", () => openChannelDialog("create"));
$("#channel-dialog-close").addEventListener("click", () => $("#channel-dialog").close());
$("#channel-list").addEventListener("click", e => {
  const manage = e.target.closest("[data-channel-manage]");
  if (manage) { e.stopPropagation(); openChannelDialog("manage", manage.dataset.channelManage); return; }
  const button = e.target.closest("[data-channel]");
  if (button) setActiveChannel(button.dataset.channel);
});
$("#channel-form").addEventListener("submit", async e => {
  e.preventDefault();
  const mode = channelDialogMode;
  const name = $("#channel-name-input").value.trim();
  if (!mode || !name || !state) return;
  const status = $("#channel-form-status");
  setFormStatus(status, mode.mode === "create" ? "Creating…" : "Saving…");
  try {
    const pending = mode.mode === "create"
      ? draftCommand(null, T.CHANNEL_CREATED, { channelId: crypto.randomUUID(), name })
      : draftCommand(null, T.CHANNEL_RENAMED, { channelId: mode.channelId, name });
    const newChannelId = pending.command.data.channelId;
    await client.send(pending.command);
    $("#channel-dialog").close();
    if (mode.mode === "create") {
      if (newChannelId && await waitForChannel(newChannelId)) setActiveChannel(newChannelId);
      notice(`Channel #${name} created.`);
    } else notice("Channel renamed.");
  } catch (error) { setFormStatus(status, `${error.message}`, true); }
});
$("#channel-archive-button").addEventListener("click", async e => {
  const mode = channelDialogMode;
  if (!mode || mode.mode !== "manage" || !mode.channelId || !state) return;
  const button = e.currentTarget;
  if (!channelArchiveArmed) {
    channelArchiveArmed = true;
    button.textContent = "Confirm archive";
    setFormStatus($("#channel-form-status"), "Archived channels stay searchable but accept no new messages.");
    return;
  }
  setFormStatus($("#channel-form-status"), "Archiving…");
  try {
    await client.send(draftCommand(null, T.CHANNEL_ARCHIVED, { channelId: mode.channelId }).command);
    $("#channel-dialog").close();
    if (activeChannelId === mode.channelId) setActiveChannel(DEFAULT_CHANNEL_ID);
    notice("Channel archived.");
  } catch (error) {
    setFormStatus($("#channel-form-status"), `${error.message}`, true);
    channelArchiveArmed = false; button.textContent = "Archive channel";
  }
});
function submitRequest(form) {
  if (!state || busy || requestReading) return;
  const mode = requestMode, key = composerKey(), identity = session, generation = client.generation;
  if (!$("#message-input").value.trim()) return;
  const hadPending = Boolean(pendingMessage);
  try {
    if (!pendingMessage) {
      const data = replyDraftData(mode, { body: $("#message-input").value.trim(),
        toMemberId: $("#message-to-select").value || null, replyToId, messageId: crypto.randomUUID(),
        channelId: activeChannelId });
      pendingMessage = draftCommand(null, mode.kind === "cancelled" ? REPLY_CANCELLED : T.MESSAGE_POSTED, data);
    }
  } catch (error) { setComposerError(error.message); return; }
  saveComposer();
  const command = pendingMessage.command;
  submit(form, async () => {
    try {
      if (command.data.messageId) locallyOwnedMessageIds.add(command.data.messageId);
      const receipt = await client.send(command);
      if (generation !== client.generation || session !== identity || !state) return;
      if (!await confirmsReplyCommand(receipt, command, identity.roomId, identity.member.id)) throw new Error("Save not confirmed");
      if (generation !== client.generation || session !== identity || !state) return;
      drafts.clear(key); requestMode = null; requestEpoch++;
      restoreComposer(drafts.get(composerKey())); updateReply(); persistDrafts();
      if (mode.resultEventId) renderReturnBrief();
      notice(mode.kind === "request" ? "Request saved." : mode.kind === "cancelled" ? "Request cancelled." : "Reply saved.");
    } catch (error) {
      if (generation !== client.generation || session !== identity || !state) return;
      // command_rejected is issued after exact-operation lookup. Transport and
      // pre-ledger size/rate errors cannot unlock an earlier uncertain operation.
      if ((!hadPending && [400, 404, 409, 413, 422].includes(error.status))
        || error.code === "command_rejected" && [409, 422].includes(error.status)) pendingMessage = null;
      saveComposer();
      // A DM refused by the consent gate names the recipient and the next
      // step, instead of surfacing the raw gate message.
      const consentRefusal = mapDmConsentRefusal(command, error);
      if (consentRefusal) throw consentRefusal;
      throw error;
    }
  }, { failureHint: "Draft kept. Retry the original, or refresh context after a refusal." });
}
// The menu lifting click listener is no longer needed (content-visibility
// removed from .message). The menu positions correctly without it.
// Widen the root-timeline window so the message with this id is rendered.
function expandTimelineTo(id) {
  if (currentThreadId) return;
  const view = `room:${activeChannelId}`;
  const roots = conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
  const current = timelineWindow.get(view) ?? TIMELINE_WINDOW, next = windowToInclude(roots, id, current);
  if (next > current) {
    timelineWindow.set(view, next);
    timelineRevealing = true;
    renderMessages();
  }
}
$("#message-list").addEventListener("click", e => {
  if (e.target.closest("[data-timeline-earlier]")) {
    const view = `room:${activeChannelId}`;
    timelineWindow.set(view, (timelineWindow.get(view) ?? TIMELINE_WINDOW) + TIMELINE_WINDOW);
    timelineRevealing = true;
    renderMessages();
    return;
  }
  const file = e.target.closest("[data-download-file]");
  if (file) { void downloadMessageFile(file.dataset.downloadFile, file.dataset.fileMessage); return; }
  if (e.target.closest("[data-empty-write]")) { $("#message-input").focus(); return; }
  if (e.target.closest("[data-empty-invite]")) { $("#invite-people-button")?.click(); return; }
  const chip = e.target.closest("[data-mention-id]");
  if (chip && state) { applyMentionMember(state.members[chip.dataset.mentionId]); return; }
  const button = e.target.closest("[data-message-id]"); if (!button || !state || busy) return;
  const id = button.dataset.messageId;
  // An action picked from the "⋯" overflow menu closes the menu behind it.
  button.closest("details.message-more")?.removeAttribute("open");
  if (button.dataset.messageAction?.startsWith("request-")) openRequestMode(button.dataset.messageAction.slice(8), id);
  else if (button.dataset.messageAction === "work") openWork(id);
  else if (button.dataset.messageAction === "decide") openDecision(id);
  else if (button.dataset.messageAction === "result") {
    const message = conversation.byId.get(id), item = state.workItems[message?.workItemId];
    if (item && workActions(item, state.members[session.member.id]).some(([action]) => action === "complete")) openWorkAction(item, "complete", id);
  }
  else if (button.dataset.messageAction === "react") setReaction(id, button.dataset.reaction);
  else if (button.dataset.messageAction === "add-reaction") openReactionSheet(id, button.closest("li.message"));
  else if (button.dataset.messageAction === "pin") setPinned(id);
  else if (button.dataset.messageAction === "mark-unread") void markMessageUnread(id);
  else if (button.dataset.messageAction === "save") void toggleSaved(id);
  else if (button.dataset.messageAction === "report") openReport(id);
  else if (button.dataset.messageAction === "edit") openEditMessage(id);
  else if (button.dataset.messageAction === "delete") openDeleteMessage(id);
  else if (["mute", "unmute"].includes(button.dataset.messageAction)) setMute(conversation.byId.get(id)?.authorId, button.dataset.messageAction === "mute");
  else if (["reply", "thread"].includes(button.dataset.messageAction)) {
    switchThread(conversation.rootById.get(id), button.dataset.messageAction === "reply");
    if (button.dataset.messageAction === "reply") {
      replyToId = id;
      const author = replyAuthorToAddress(session.member.id, state.members[conversation.byId.get(id)?.authorId]);
      // Replying stays public: the thread is room-visible and the @mention is
      // text only. Never touch the DM recipient select here — a reply is not
      // a DM and must never silently become one.
      if (author && !messageMentionsMember($("#message-input").value, author)) applyMentionMember(author);
      updateReply(); saveComposer();
    }
  }
});
function updateReply() {
  const target = conversation?.byId.get(replyToId);
  $("#reply-bar").hidden = Boolean(requestMode) || !target || replyToId === currentThreadId;
  const author = target ? replyAuthorToAddress(session?.member?.id, state.members[target.authorId]) : null;
  const addressing = Boolean(author && messageMentionsMember($("#message-input").value, author));
  // Runs on every keystroke: write text only when it changes. Replacing an
  // unchanged text node still forces a layout of the whole timeline.
  setText("#reply-context", target
    ? `Replying to ${name(target.authorId)}${addressing ? ` · addressing ${author.displayName}` : ""}: ${target.deletedAt ? "Message deleted" : target.body.slice(0, 100)}`
    : "");
  const mention = $("#reply-mention");
  mention.hidden = !author;
  mention.disabled = busy;
  mention.setAttribute("aria-pressed", addressing ? "true" : "false");
  setText("#reply-mention", author ? `Also @ ${author.displayName}` : "Also @");
}
function clearReply() { replyToId = assistantDraft?.sourceMessageId ?? currentThreadId; updateReply(); }
function cancelReply() { if (assistantDraft) switchThread(currentThreadId); else clearReply(); }
$("#cancel-reply").addEventListener("click", () => { cancelReply(); $("#message-input").focus({ preventScroll: true }); });
$("#reply-mention").addEventListener("click", () => {
  const target = conversation?.byId.get(replyToId);
  const author = target ? replyAuthorToAddress(session?.member?.id, state.members[target.authorId]) : null;
  if (!author) return;
  const input = $("#message-input");
  if (messageMentionsMember(input.value, author)) {
    input.value = removeMention(input.value, author);
    saveComposer(); syncRequestComposer();
    input.focus({ preventScroll: true });
  } else applyMentionMember(author);
  updateReply();
});
$("#thread-back").addEventListener("click", () => switchThread(null));
// Per-thread mutes: a private per-member row on the server (thread_mutes).
// Muting suppresses the thread's activity from the notification/unread feed;
// unmuting restores it on the next read. The server resolves any message id
// to the thread root, so the local set holds root ids.
async function refreshMutedThreads() {
  mutedThreads = new Set();
  if (!session || !client.session) return;
  const generation = client.generation;
  try {
    const result = await client.threadMutes();
    if (generation !== client.generation || !state) return;
    if (result && Array.isArray(result.threadIds)) mutedThreads = new Set(result.threadIds);
  } catch {
    // The button still works; the list just starts empty until the next load.
    if (generation !== client.generation || !state) return;
  }
  renderMessages();
}
function syncThreadMuteButton() {
  const button = $("#thread-mute");
  const muted = Boolean(currentThreadId && mutedThreads.has(currentThreadId));
  button.setAttribute("aria-pressed", String(muted));
  button.textContent = muted ? "Unmute thread" : "Mute thread";
}
$("#thread-mute").addEventListener("click", async () => {
  if (!state || !currentThreadId || threadMuteBusy) return;
  threadMuteBusy = true;
  const button = $("#thread-mute");
  button.disabled = true;
  try {
    const result = await client.setThreadMute(currentThreadId, !mutedThreads.has(currentThreadId));
    if (result) {
      if (result.muted) mutedThreads.add(result.threadId);
      else mutedThreads.delete(result.threadId);
      notice(result.muted
        ? "Thread muted. Its activity won't count toward your unread feed."
        : "Thread unmuted. Its activity is back in your unread feed.");
    }
  } catch (error) {
    notice(`Couldn't update the thread mute: ${error.message}`, true);
  } finally {
    threadMuteBusy = false;
    button.disabled = false;
  }
  renderMessages();
});
// "Also send to channel" is a thread-composer affordance only: it shows for
// public thread replies and stays off by default. A DM recipient hides it —
// a channel copy of a private message would leak the body.
function syncAlsoSend() {
  const label = $("#also-send-label"), box = $("#also-send-to-channel");
  const visible = Boolean(currentThreadId && !requestMode && state && !$("#message-to-select")?.value);
  label.hidden = !visible;
  if (!visible) box.checked = false;
}
function rememberComposerSelection({ clearCollapsed = false } = {}) {
  const input = $("#message-input");
  if (input.selectionStart !== input.selectionEnd) {
    lastComposerSelection = { value: input.value, start: input.selectionStart, end: input.selectionEnd, direction: input.selectionDirection };
  } else if (clearCollapsed) lastComposerSelection = null;
}
$("#message-input").addEventListener("select", () => rememberComposerSelection());
document.addEventListener("selectionchange", () => { if (document.activeElement === $("#message-input")) rememberComposerSelection(); });
for (const type of ["keyup", "mouseup", "touchend"]) $("#message-input").addEventListener(type, () => rememberComposerSelection({ clearCollapsed: true }));
function hideMentions() {
  const list = $("#mention-list"), input = $("#message-input");
  if (!list) return;
  list.hidden = true; list.replaceChildren(); mentionIndex = 0;
  if ($("#emoji-list")?.hidden !== false) {
    // Closed listbox: the textarea stops pointing at an option that no longer exists.
    input?.removeAttribute("aria-expanded"); input?.removeAttribute("aria-activedescendant");
    input?.setAttribute("aria-controls", "mention-list");
  }
}
function hideEmoji() {
  const list = $("#emoji-list"), input = $("#message-input");
  if (!list || list.hidden) return;
  list.hidden = true; list.replaceChildren(); emojiIndex = 0;
  if ($("#mention-list")?.hidden !== false) {
    input?.removeAttribute("aria-expanded"); input?.removeAttribute("aria-activedescendant");
    input?.setAttribute("aria-controls", "mention-list");
  }
}
function emojiChoices() {
  const input = $("#message-input");
  if (!input || ($("#mention-list") && !$("#mention-list").hidden)) return null;
  const found = emojiQuery(input.value, input.selectionStart);
  if (!found) return null;
  const matches = emojiMatches(found.query, 8);
  return matches.length ? { found, matches } : null;
}
function renderEmoji() {
  const list = $("#emoji-list");
  if (!list) return;
  const choice = emojiChoices();
  if (!choice) { hideEmoji(); return; }
  emojiIndex = Math.min(Math.max(emojiIndex, 0), choice.matches.length - 1);
  list.hidden = false;
  list.innerHTML = choice.matches.map((item, i) => `<li role="option" id="emoji-option-${i}" class="mention-option${i === emojiIndex ? " active" : ""}" data-emoji="${esc(item.emoji)}" aria-selected="${i === emojiIndex}"><span class="emoji-glyph" aria-hidden="true">${item.emoji}</span> ${esc(item.name)}</li>`).join("");
  const input = $("#message-input");
  input.removeAttribute("aria-expanded");
  input.setAttribute("aria-controls", "emoji-list");
  input.setAttribute("aria-activedescendant", `emoji-option-${emojiIndex}`);
}
function applyEmoji(emoji) {
  const input = $("#message-input");
  const found = input && emojiQuery(input.value, input.selectionStart);
  if (!input || !found || !emoji) return;
  const next = insertEmoji(input.value, input.selectionStart, found.start, emoji);
  input.value = next.body;
  hideEmoji(); saveComposer(); syncRequestComposer();
  input.focus(); input.setSelectionRange(next.caret, next.caret);
}
function mentionChoices() {
  const input = $("#message-input"), found = mentionQuery(input.value, input.selectionStart);
  if (!found || !state) return [];
  // In the human view the room assistant's seat reads as "Room" (as everywhere else), so @Room finds it.
  const members = Object.values(state.members).map(m => { const name = humanExperience.assistantName(m.id); return name ? { ...m, displayName: name } : m; });
  return mentionMatches(members, found.query);
}
function renderMentions() {
  const list = $("#mention-list");
  if (!list) return;
  const matches = mentionChoices();
  if (!matches.length) { hideMentions(); return; }
  mentionIndex = Math.min(Math.max(mentionIndex, 0), matches.length - 1);
  list.hidden = false;
  // Each row is the option itself (role="option" + aria-selected are invalid on a
  // nested button). Focus stays in the textarea; aria-activedescendant names the row.
  list.innerHTML = matches.map((m, i) => `<li role="option" id="mention-option-${i}" class="mention-option${i === mentionIndex ? " active" : ""}" data-mention-id="${esc(m.id)}" aria-selected="${i === mentionIndex}">${esc(m.displayName)} <span>${esc(kindLabel(m.kind))}</span></li>`).join("");
  const input = $("#message-input");
  input.removeAttribute("aria-expanded");
  input.setAttribute("aria-activedescendant", `mention-option-${mentionIndex}`);
}
// Choosing the assistant from the @ list is an Ask Room, not a plain mention.
function chooseMention(member) {
  const input = $("#message-input"), found = input && member ? mentionQuery(input.value, input.selectionStart) : null;
  if (found && humanExperience.assistantName(member.id) && humanExperience.selectAsk()) {
    const value = input.value, caret = input.selectionStart, before = value.slice(0, found.start).replace(/[ \t]+$/, ""), after = value.slice(caret).replace(/^[ \t]+/, "");
    input.value = [before, after].filter(Boolean).join(" ");
    const at = before ? before.length + (after ? 1 : 0) : 0;
    hideMentions(); saveComposer(); syncRequestComposer(); input.focus(); input.setSelectionRange(at, at);
    return;
  }
  applyMentionMember(member);
}
function applyMentionMember(member) {
  const input = $("#message-input");
  if (!input || !member) return;
  const next = addressMember(input.value, input.selectionStart, member);
  input.value = next.body;
  // Mentions are text only: never change the DM recipient select here.
  // A message becomes a DM only when the sender explicitly picks a recipient.
  hideMentions(); saveComposer(); syncRequestComposer();
  input.focus(); input.setSelectionRange(next.caret, next.caret);
}
$("#message-input").addEventListener("input", () => { lastComposerSelection = null; saveComposer(); renderMentions(); renderEmoji(); updateReply(); syncRequestComposer(); void client.sendTyping({ toMemberId: $("#message-to-select").value }); });
$("#message-to-select").addEventListener("change", () => { saveComposer(); syncRequestComposer(); syncComposerChrome(); });
const touchKeyboard = matchMedia("(hover: none) and (pointer: coarse)");
function syncComposerHint() {
  const hint = touchKeyboard.matches ? "Return for a new line · ↑ to send" : "Enter to send · Shift + Enter for a new line";
  const input = $("#message-input");
  input.title = hint;
  input.setAttribute("aria-description", hint);
  const caption = $("#composer-hint");
  if (caption) caption.textContent = hint;
  input.enterKeyHint = touchKeyboard.matches ? "enter" : "send";
}
touchKeyboard.addEventListener("change", syncComposerHint);
syncComposerHint();
$("#message-input").addEventListener("keydown", e => {
  const list = $("#mention-list"), open = list && !list.hidden;
  const matches = open ? mentionChoices() : [];
  if (open && matches.length) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      mentionIndex = (mentionIndex + (e.key === "ArrowDown" ? 1 : matches.length - 1)) % matches.length;
      renderMentions();
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); chooseMention(matches[mentionIndex]); return; }
  }
  const emojiChoice = emojiChoices();
  if (emojiChoice) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      emojiIndex = (emojiIndex + (e.key === "ArrowDown" ? 1 : emojiChoice.matches.length - 1)) % emojiChoice.matches.length;
      renderEmoji();
      return;
    }
    if (e.key === "Tab" || e.key === "Enter") { e.preventDefault(); applyEmoji(emojiChoice.matches[emojiIndex].emoji); return; }
  }
  // Some IME confirmation keys arrive after compositionend; keyCode 229 is the
  // legacy UI Events signal. Neither confirmation nor key repeat sends a message.
  if (sendsOnEnter(e, touchKeyboard.matches)) {
    e.preventDefault();
    if (!busy && $("#message-input").value.trim()) $("#message-form").requestSubmit();
  }
});
$("#mention-list")?.addEventListener("mousedown", e => {
  const option = e.target.closest("[data-mention-id]");
  if (!option) return;
  e.preventDefault();
  chooseMention(state.members[option.dataset.mentionId]);
});
$("#emoji-list")?.addEventListener("mousedown", e => {
  const option = e.target.closest("[data-emoji]");
  if (!option) return;
  e.preventDefault();
  applyEmoji(option.dataset.emoji);
});
// C6: the owner's pause roster is one read when People opens and after each
// action; the row buttons never appear for non-owners or inactive agents.
async function refreshAgentPauses() {
  if (!state || !session || state.room.ownerId !== session.member.id || !can("manage_members")) return;
  const generation = client.generation;
  try {
    const view = await client.request(client.path("/agent-pause"));
    if (generation !== client.generation || !state) return;
    agentPauses = new Map((view.paused ?? []).map(p => [p.memberId, p]));
    render();
  } catch { /* the roster stays as last read; the next action re-reads it */ }
}
$("#people-panel").addEventListener("toggle", () => { if ($("#people-panel").open) { refreshAgentPauses(); void refreshDmConsents(); void refreshFriendBonds(); void refreshPresenceStates(); } });
// plan-dir-card: lazy-load a member's directory card the first time its
// chip section expands. The endpoint 404s when the member has no visible
// card; the section only renders when the roster advertised a cardAgentId,
// so a 404 here is just a quiet "not available".
document.addEventListener("toggle", event => {
  const details = event.target?.closest?.("[data-directory-card]");
  if (!details || details.dataset.loaded || !details.open) return;
  details.dataset.loaded = "1";
  const memberId = details.dataset.directoryCard;
  const body = details.querySelector("[data-member-card-body]");
  if (!body) return;
  void (async () => {
    try {
      const card = await client.request(client.path(`/members/${encodeURIComponent(memberId)}/card`));
      if (body.isConnected) body.innerHTML = renderDirectoryCard(card);
    } catch {
      if (body.isConnected) body.innerHTML = `<p class="form-hint">No directory card available.</p>`;
    }
  })();
}, true);
$("#presence-list").addEventListener("click", async e => {
  const button = e.target.closest("[data-member-work]");
  if (!button || !ownsRoomActions(null) || memberActionBusy || state.room.ownerId !== session.member.id) return;
  e.preventDefault();
  const member = state.members[button.dataset.memberWork];
  if (!member || member.kind !== "agent" || member.active === false) return;
  const permissions = [...new Set([...member.permissions, ...WORK_PERMISSIONS])], generation = client.generation;
  memberActionBusy = true; button.disabled = true;
  try {
    const { connections = [] } = await client.request(client.path("/agent-connections"));
    if (generation !== client.generation || !state) return;
    if (connections.some(row => row.memberId === member.id && row.status === "key_issued")) {
      notice(`${member.displayName} connected with its own key. In Add agent, open Manage connections and choose Contribute work.`, true);
      return;
    }
    const entry = draftCommand(null, T.MEMBER_ACCESS_CHANGED, { memberId: member.id, expectedMemberRevision: member.revision, permissions, active: true });
    await client.send(entry.command);
    if (generation !== client.generation || !state) return;
    notice(`${member.displayName} can take work now.`);
  } catch (error) {
    if (generation === client.generation && state) notice(error.message || "Not saved. Try again.", true);
  } finally {
    memberActionBusy = false;
    if (generation === client.generation && state) render();
  }
});
$("#presence-list").addEventListener("click", async e => {
  const button = e.target.closest("[data-member-admin]");
  if (!button || !ownsRoomActions(null) || memberActionBusy || state.room.ownerId !== session.member.id) return;
  e.preventDefault();
  const member = state.members[button.dataset.memberAdmin];
  if (!member || member.active === false || member.id === state.room.ownerId) return;
  const wasAdmin = member.permissions.includes("manage_members"), generation = client.generation;
  const permissions = wasAdmin ? member.permissions.filter(p => p !== "manage_members") : [...member.permissions, "manage_members"];
  memberActionBusy = true; button.disabled = true;
  try {
    const entry = draftCommand(null, T.MEMBER_ACCESS_CHANGED, { memberId: member.id, expectedMemberRevision: member.revision, permissions, active: true });
    await client.send(entry.command);
    if (generation !== client.generation || !state) return;
    notice(wasAdmin ? `${member.displayName} is no longer a room admin. Other access is unchanged.` : `${member.displayName} is now a room admin and can invite and manage members.`);
  } catch (error) {
    if (generation === client.generation && state) notice(error.message || "Admin role not saved. Try again.", true);
  } finally {
    memberActionBusy = false;
    if (generation === client.generation && state) {
      render(); $(`#presence-list [data-member-admin="${CSS.escape(member.id)}"]`)?.focus();
    }
  }
});
$("#presence-list").addEventListener("click", async e => {
  const pauseButton = e.target.closest("[data-member-pause]"), removeButton = e.target.closest("[data-member-remove]"), keepButton = e.target.closest("[data-member-remove-cancel]");
  if (!pauseButton && !removeButton && !keepButton) return;
  e.preventDefault();
  if (!ownsRoomActions(null) || memberActionBusy) return;
  const memberId = pauseButton?.dataset.memberPause ?? removeButton?.dataset.memberRemove ?? keepButton.dataset.memberRemoveCancel;
  const focusAction = selector => $(`#presence-list [${selector}="${CSS.escape(memberId)}"]`)?.focus();
  if (keepButton) { armedRemoval = null; render(); focusAction("data-member-remove"); return; }
  const member = state.members[memberId];
  if (!member || member.kind !== "agent" || member.active === false || state.room.ownerId !== session.member.id || !can("manage_members")) return;
  if (removeButton && armedRemoval !== memberId) { armedRemoval = memberId; render(); focusAction("data-member-remove"); return; }
  memberActionBusy = true;
  const generation = client.generation;
  try {
    if (removeButton) {
      const entry = draftCommand(null, T.MEMBER_ACCESS_CHANGED, { memberId, expectedMemberRevision: member.revision, permissions: [...member.permissions], active: false });
      armedRemoval = null;
      await client.send(entry.command);
      if (generation !== client.generation || !state) return;
      agentPauses.delete(memberId);
      notice(`${displayName(memberId)} removed. Room access and connections ended; context already delivered to its provider is not recalled.`);
    } else {
      const action = pauseButton.dataset.pauseAction;
      const view = await client.request(client.path("/agent-pause"), { method: "POST", data: { action, memberId, requestId: crypto.randomUUID(), ...(action === "pause" ? { reason: null } : {}) } });
      if (generation !== client.generation || !state) return;
      agentPauses = new Map((view.paused ?? []).map(p => [p.memberId, p]));
      notice(action === "pause" ? `${displayName(memberId)} paused: queued wakes will not start; a running attempt finishes.` : `${displayName(memberId)} resumed.`);
    }
    render();
    focusAction(removeButton ? "data-member-record-id" : "data-member-pause");
  } catch (error) {
    if (generation === client.generation && state) notice(error.message || "Action not saved. Try again.", true);
  } finally { memberActionBusy = false; }
});
$("#presence-list").addEventListener("click", e => {
  if (!shouldAddressPresenceClick(e.target)) return;
  const row = e.target.closest(".presence-member");
  const member = state?.members[row?.dataset.memberRecordId];
  if (!member || member.active === false) return;
  $("#main").classList.remove("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  applyMentionMember(member);
});
function chatEscapeState() {
  return {
    dialogOpen: Boolean(document.querySelector("dialog[open]")),
    mentionOpen: Boolean($("#mention-list") && !$("#mention-list").hidden),
    emojiOpen: Boolean($("#emoji-list") && !$("#emoji-list").hidden),
    replyOpen: Boolean(state && conversation?.byId.get(replyToId) && replyToId !== currentThreadId),
    inThread: Boolean(currentThreadId)
  };
}
document.addEventListener("click", event => {
  for (const picker of document.querySelectorAll(".message-more[open]")) {
    if (!picker.contains(event.target)) picker.open = false;
  }
});
// The newest message sits against the composer: open its menu upward when it
// would not fit below (the .message-more-up style flips it).
document.addEventListener("toggle", event => {
  const more = event.target;
  if (!more.matches?.("details.message-more") || !more.open) return;
  more.classList.remove("message-more-up");
  const trigger = more.querySelector("summary").getBoundingClientRect(), menu = more.querySelector(".message-more-menu");
  const composer = document.querySelector("#message-form")?.getBoundingClientRect();
  const timeline = document.querySelector(".timeline")?.getBoundingClientRect();
  if (menu && menuOpensUp({ triggerTop: trigger.top, triggerBottom: trigger.bottom, menuHeight: menu.getBoundingClientRect().height + 4,
    limitTop: Math.max(0, timeline?.top ?? 0), limitBottom: Math.min(window.innerHeight, composer?.top ?? window.innerHeight, timeline?.bottom ?? window.innerHeight) })) more.classList.add("message-more-up");
  // On a phone the right-aligned menu can start left of the screen (R41-1):
  // anchor it to the trigger's left edge instead.
  more.classList.remove("message-more-start");
  if (menu && menu.getBoundingClientRect().left < 0) more.classList.add("message-more-start");
  // Taller than the room on either side (R60-1: own messages add Edit/Delete):
  // scroll the timeline just enough to bring the whole menu into view.
  const placed = menu?.getBoundingClientRect();
  if (placed && timeline && (placed.top < timeline.top || placed.bottom > Math.min(timeline.bottom, composer?.top ?? Infinity))) menu.scrollIntoView({ block: "nearest" });
}, true);
document.addEventListener("focusin", event => {
  for (const menu of document.querySelectorAll(".message-more[open]")) {
    if (!menu.contains(event.target)) menu.open = false;
  }
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  const picker = event.target.closest(".message-more[open]");
  if (!picker) return;
  event.preventDefault(); event.stopImmediatePropagation();
  picker.open = false; picker.querySelector("summary").focus();
}, true);
function runEscapeChat(event) {
  if (event.key !== "Escape" || event.repeat || event.isComposing || event.keyCode === 229) return false;
  const action = escapeChatAction(chatEscapeState());
  if (!action) return false;
  event.preventDefault();
  if (action === "hide-emoji") hideEmoji();
  else if (action === "hide-mentions") hideMentions();
  else if (action === "clear-reply") { cancelReply(); saveComposer(); }
  else if (action === "leave-thread") switchThread(null);
  return true;
}
document.addEventListener("keydown", event => {
  if ($("#main").hidden || event.target?.closest?.("dialog")) return;
  runEscapeChat(event);
});
// Attention: keyboard shortcuts. `g a` opens Activity, `g l` opens Later,
// `u` marks the focused message unread. Skipped while typing, composing,
// in dialogs, or with modifiers held.
let attentionKeyPrefix = null;
let attentionKeyTimer = 0;
document.addEventListener("keydown", event => {
  if ($("#main").hidden || event.target?.closest?.("dialog")) return;
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.keyCode === 229) return;
  if (event.target?.closest?.("input, textarea, select, [contenteditable]")) { attentionKeyPrefix = null; return; }
  const key = event.key?.toLowerCase();
  if (attentionKeyPrefix === "g") {
    attentionKeyPrefix = null;
    clearTimeout(attentionKeyTimer);
    if (key === "a") { event.preventDefault(); openActivity(); }
    else if (key === "l") { event.preventDefault(); openLater(); }
    return;
  }
  if (key === "g") {
    attentionKeyPrefix = "g";
    clearTimeout(attentionKeyTimer);
    attentionKeyTimer = setTimeout(() => { attentionKeyPrefix = null; }, 800);
    return;
  }
  if (key === "u") {
    const host = event.target?.closest?.("[data-message-id], [data-message-record-id]");
    const messageId = host?.dataset?.messageId ?? host?.dataset?.messageRecordId;
    if (messageId && !conversation.byId.get(messageId)?.deletedAt) {
      event.preventDefault();
      void markMessageUnread(messageId);
    }
  }
});
$("#search-form").addEventListener("submit", e => { e.preventDefault(); if (state) renderSearch(); });
$("#message-search").addEventListener("input", () => { if (state) renderSearch(); });
$("#search-mentions").addEventListener("click", () => {
  const on = mentionsFilterOn();
  $("#search-mentions").setAttribute("aria-pressed", on ? "false" : "true");
  if (state) renderSearch();
});
$("#search-pinned").addEventListener("click", () => {
  const on = pinnedFilterOn();
  $("#search-pinned").setAttribute("aria-pressed", on ? "false" : "true");
  if (state) renderSearch();
});
$("#clear-search").addEventListener("click", () => {
  $("#message-search").value = "";
  $("#search-mentions").setAttribute("aria-pressed", "false");
  $("#search-pinned").setAttribute("aria-pressed", "false");
  renderSearch(); $("#message-search").focus();
});

// Navigation only: all consequential actions stay in their existing forms.
// Resolve the current target again on selection; an open menu is not authority.
function ownsRoomActions(context = roomActionsContext) {
  return Boolean(state && session && client.session === session && client.generation === roomGeneration
    && client.ownsAccountSession() && !$("#main").hidden && $("#inbox-panel").hidden
    && (!context || context.session === session && context.generation === client.generation));
}
function revealPeopleChrome() {
  $("#people-panel").open = true;
  const toggle = $("#sidebar-toggle");
  if (toggle && getComputedStyle(toggle).display !== "none") {
    $("#main").classList.add("sidebar-open");
    toggle.setAttribute("aria-expanded", "true");
  }
}
function roomActionEntries() {
  return [
    { id: "write", label: requestMode ? "Open composer" : $("#message-input").value ? "Continue writing" : "Write a message", words: "compose chat draft reply", target: "#message-input" },
    { id: "search", label: "Search room", words: "find messages work", target: "#message-search", always: true },
    { id: "mentions", label: "Mentions", words: "mentions addressed @me to:me", target: "#search-mentions", activate: true, always: true },
    { id: "pinned-search", label: "Pinned", words: "pins pinned search", target: "#search-pinned", activate: true, always: true },
    { id: "catch-up", label: "Catch up", words: "updates attention needs me reminders", always: true },
    { id: "activity", label: "Activity", words: "activity mentions replies reactions feed unread", always: true },
    { id: "later", label: "Saved for later", words: "later saved bookmarks read later", always: true },
    { id: "results", label: "View results", words: "completed approved finished artifacts", always: true },
    { id: "people", label: "People", words: "members collaborators team", target: "#people-panel > summary", reveal: "#people-panel" },
    { id: "new-work", label: "New work", words: "create task request", target: "#new-work-button", activate: true },
    { id: "invite", label: "Invite", words: "share join link people agents", target: "#invite-people-button", activate: true },
    { id: "invite-agents", label: "Invite agents", words: "invite code redeem collaborate contribute bootstrap", target: "#invite-people-button", activate: true },
    { id: "create-room", label: "Create Room", words: "bootstrap-agent-room agent-rooms pri_ own room", target: "#create-room-details > summary", always: true },
    { id: "agent", label: "Add agent", words: "ai assistant mcp tools instinct muse grok build grokbot grok bot claude code codex cursor hermes opencode pi connect wake pull desktop takeover catalog", target: "#connect-agent-button", reveal: "#people-panel", activate: true },
    { id: "how-invite", label: "How to invite someone", words: "how guest eight hours link help", always: true },
    { id: "how-agent", label: "How to add an agent", words: "how connect instinct muse grok claude codex cursor hermes opencode pi help catalog", always: true },
    { id: "how-inbox", label: "How to open Inbox", words: "how inbox mail email account", always: true },
    { id: "instructions", label: "Room instructions", words: "guidance brief charter", always: true },
    { id: "landing", label: "Landing queue", words: "land merge pull request review queue", always: true },
    { id: "referrals", label: "Referrals", words: "referral invite share link leaderboard", always: true },
    { id: "permissions", label: "Room permissions", words: "trust cross owner collaboration wake", always: true },
    { id: "settings", label: "Settings", words: "advanced configuration", always: true },
    { id: "usage", label: "Usage", words: "spend seats sessions caps limits budget headroom", always: true }
  ].filter(entry => {
    if (entry.always) return true;
    const target = $(entry.target); return target && !target.disabled && !target.closest("[hidden]");
  });
}
function closeRoomActions(restore = true) {
  const context = roomActionsContext; roomActionsContext = null;
  $("#room-actions-dialog").close(); $("#room-actions-list").replaceChildren(); $("#room-actions-query").value = "";
  $("#room-actions-empty").hidden = true; $("#room-actions-count").textContent = ""; $("#room-actions-status").textContent = "";
  if (restore && context && ownsRoomActions(context) && context.opener?.isConnected && context.opener.getClientRects().length) {
    context.opener.focus({ preventScroll: true });
    if (context.selection && context.opener.value === context.value) context.opener.setSelectionRange(...context.selection);
  }
}
const ROOM_CHANNEL_RESULT_LIMIT = 20, ROOM_TASK_RESULT_LIMIT = 20;
// Match the timeline's newest loaded proposal without rendering work cards.
function roomTaskEntries() {
  const sources = new Map();
  for (let index = state.messages.length - 1; index >= 0; index--) {
    const message = state.messages[index];
    if (message.workItemId && message.proposal && !sources.has(message.workItemId)) sources.set(message.workItemId, messageChannelId(message));
  }
  return Object.values(state.workItems).map(item => ({ item, channelId: sources.get(item.id) ?? DEFAULT_CHANNEL_ID }))
    .filter(({ item, channelId }) => state.workItems[item.id] === item && state.channels?.[channelId] && !state.channels[channelId].archivedAt);
}
function roomDestinationBlockedReason() {
  return busy ? "Wait for the current send to finish, then try again."
    : composerFiles.some(file => file.status === "uploading") ? "Wait for the file upload to finish, then try again."
    : requestReading ? "Wait for the request to finish loading, then try again." : "";
}
function refuseRoomDestination(message) {
  $("#room-actions-status").textContent = message; $("#room-actions-status").scrollIntoView({ block: "nearest" });
}
function renderRoomActions() {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  const raw = $("#room-actions-query").value.toLowerCase().trim();
  const channelsOnly = raw.startsWith("#"), tasksOnly = raw.startsWith(">");
  const query = (channelsOnly || tasksOnly ? raw.slice(1) : raw).trim();
  const terms = query.split(/\s+/).filter(Boolean);
  const channels = tasksOnly ? [] : channelList(state).filter(channel => !channel.archivedAt && terms.every(term => channel.name.toLowerCase().includes(term)));
  const rank = channel => !query ? channel.id === activeChannelId ? -1 : 0
    : channel.name.toLowerCase() === query ? 0 : channel.name.toLowerCase().startsWith(query) ? 1 : 2;
  channels.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "en") || a.id.localeCompare(b.id, "en"));
  const shown = channels.slice(0, ROOM_CHANNEL_RESULT_LIMIT);
  const tasks = channelsOnly ? [] : roomTaskEntries().filter(({ item }) => terms.every(term => item.title.toLowerCase().includes(term)));
  const taskRank = ({ item }) => item.title.toLowerCase() === query ? 0 : item.title.toLowerCase().startsWith(query) ? 1 : 2;
  tasks.sort((a, b) => taskRank(a) - taskRank(b) || a.item.title.localeCompare(b.item.title, "en") || a.item.id.localeCompare(b.item.id, "en"));
  const shownTasks = tasks.slice(0, ROOM_TASK_RESULT_LIMIT);
  const entries = channelsOnly || tasksOnly ? [] : roomActionEntries().filter(entry => terms.every(term => `${entry.label} ${entry.words}`.toLowerCase().includes(term)));
  const group = (name, buttons) => {
    const section = document.createElement("section"), heading = document.createElement("h3");
    heading.id = `room-finder-${name.toLowerCase()}`; heading.textContent = name;
    section.setAttribute("aria-labelledby", heading.id); section.append(heading, ...buttons); return section;
  };
  const groups = [];
  if (shown.length) groups.push(group("Channels", shown.map(channel => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.roomChannel = channel.id;
    button.textContent = `# ${channel.name}${channel.id === activeChannelId ? " · Current" : ""}`; return button;
  })));
  if (shownTasks.length) groups.push(group("Tasks", shownTasks.map(({ item, channelId }) => {
    const button = document.createElement("button"), title = document.createElement("span"), context = document.createElement("small");
    button.type = "button"; button.dataset.roomTask = item.id;
    title.textContent = item.title;
    context.textContent = `${workStatus(item, Date.now()).label} · #${state.channels[channelId].name} · ${item.id}`;
    button.append(title, context); return button;
  })));
  if (entries.length) groups.push(group("Actions", entries.map(entry => {
    const button = document.createElement("button"); button.type = "button"; button.dataset.roomAction = entry.id;
    button.textContent = entry.label; return button;
  })));
  $("#room-actions-list").replaceChildren(...groups);
  const counts = [!tasksOnly ? `${shown.length} of ${channels.length} channels` : "", !channelsOnly ? `${shownTasks.length} of ${tasks.length} tasks` : ""].filter(Boolean);
  $("#room-actions-count").textContent = `Showing ${counts.join("; ")}. Loaded in this room.${channels.length > shown.length || tasks.length > shownTasks.length ? " Type more to refine the list." : ""}`;
  $("#room-actions-empty").hidden = shown.length + shownTasks.length + entries.length > 0;
  $("#room-actions-status").textContent = "";
}
function chooseRoomChannel(id) {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  const channel = state.channels?.[id];
  if (!channel || channel.archivedAt) {
    renderRoomActions(); $("#room-actions-status").textContent = "That channel is unavailable. Choose another channel.";
    $("#room-actions-query").focus(); return;
  }
  const blocked = roomDestinationBlockedReason();
  if (blocked) { refuseRoomDestination(blocked); return; }
  setActiveChannel(id); closeRoomActions(false);
  $("#main").classList.remove("sidebar-open"); $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  $("#conversation-title").focus({ preventScroll: true });
}
function chooseRoomTask(id) {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  const destination = roomTaskEntries().find(({ item }) => item.id === id);
  if (!destination) {
    renderRoomActions(); refuseRoomDestination("That task is unavailable in the loaded conversation. Choose another destination.");
    $("#room-actions-query").focus(); return;
  }
  const blocked = roomDestinationBlockedReason();
  if (blocked) { refuseRoomDestination(blocked); return; }
  const origin = currentWorkOrigin(), target = recordHref("work", id);
  const repeatInspection = roomActionsContext.opener?.closest?.("[data-work-record-id]")?.dataset.workRecordId === id
    && activeWorkNavigationId === id && origin?.target === target && location.hash === target
    && history.state?.roomWorkTarget === activeWorkNavigation;
  const focusKey = roomActionsContext.opener?.dataset?.focusKey;
  closeRoomActions(true);
  const usable = node => node?.isConnected && node !== document.body && !node.closest("[hidden], #room-actions-dialog") && node.getClientRects().length > 0;
  if (!usable(document.activeElement)) {
    const keyed = focusKey ? [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === focusKey && usable(node)) : null;
    (keyed ?? $("#conversation-title")).focus({ preventScroll: true });
  }
  if (repeatInspection) {
    // The inspected card is the same destination, not a new return surface.
    workNavigationOrigins.set(activeWorkNavigation, { ...origin, presentation: "details" });
    workHistoryReplayKey = null; showWorkDestination("work", id);
  } else if (!navigateWorkRecord("work", id)) { notice("That task could not open. Try again from the finder.", true); return; }
  $("#main").classList.remove("sidebar-open"); $("#sidebar-toggle").setAttribute("aria-expanded", "false");
}
function chooseRoomChoice(button) {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  if (button?.dataset.roomChannel) chooseRoomChannel(button.dataset.roomChannel);
  else if (button?.dataset.roomTask) chooseRoomTask(button.dataset.roomTask);
  else if (button?.dataset.roomAction) chooseRoomAction(button.dataset.roomAction);
}
function openRoomActions() {
  if (!ownsRoomActions(null) || document.querySelector("dialog[open]")) return;
  const opener = document.activeElement;
  roomActionsContext = { session, generation: client.generation, opener, value: opener?.value,
    selection: typeof opener?.selectionStart === "number" ? [opener.selectionStart, opener.selectionEnd, opener.selectionDirection] : null };
  $("#room-actions-query").value = ""; renderRoomActions();
  $("#room-actions-dialog").showModal(); $("#room-actions-query").focus();
}
function chooseRoomAction(id) {
  if (!roomActionsContext || !ownsRoomActions()) { closeRoomActions(false); return; }
  const entry = roomActionEntries().find(value => value.id === id);
  if (!entry) { renderRoomActions(); $("#room-actions-query").focus(); return; }
  closeRoomActions(false);
  if (updatesUi.openAction(id)) return;
  if (id === "how-invite") {
    const button = $("#invite-people-button");
    if (button && !button.hidden) { button.click(); return; }
    notice("Ask the owner to send an Invite link. Guests can chat for about eight hours in that browser.");
    return;
  }
  if (id === "how-agent") {
    revealPeopleChrome();
    $("#invite-navigation").open = true;
    const button = $("#connect-agent-button");
    const target = button && !button.hidden ? button : $("#people-panel > summary");
    target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true });
    if (button && !button.hidden) return;
    notice("The owner connects assistants from People. Instinct and Muse can Use my AI without a key.");
    return;
  }
  if (id === "how-inbox") {
    if (!$("#workspace-nav").hidden) { $("#nav-inbox").click(); return; }
    notice("Sign in with Google or email to open your Inbox.");
    return;
  }
  if (id === "catch-up") { openCatchUp(); return; }
  if (id === "activity") { closeRoomActions(false); openActivity(); return; }
  if (id === "later") { closeRoomActions(false); openLater(); return; }
  if (id === "results") { selectWorkView("results"); return; }
  if (id === "create-room") { openSettings(); $("#create-room-details").open = true; $("#create-room-details > summary").focus(); return; }
  if (id === "landing") { openSettings("land-queue-panel"); return; }
  if (id === "referrals") { openSettings("referral-panel"); return; }
  if (id === "permissions") { openSettings("room-permissions"); return; }
  if (id === "settings") { openSettings(); return; }
  if (id === "usage") { openSettings("usage-panel"); return; }
  if (id === "instructions") { openSettings("room-about"); $("#room-instructions-open").click(); return; }
  if (id === "search" || id === "mentions" || id === "pinned-search") {
    if ($("#search-form").hidden) $("#topbar-search-toggle").click();
  }
  if (entry.reveal === "#people-panel") revealPeopleChrome();
  else if (entry.reveal) $(entry.reveal).open = true;
  const target = $(entry.target); target.scrollIntoView({ block: "nearest" }); target.focus({ preventScroll: true });
  if (entry.activate) target.click();
}
$("#room-actions-open kbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘ K" : "Ctrl K";
$("#room-actions-open").addEventListener("click", openRoomActions);
$("#room-actions-close").addEventListener("click", () => closeRoomActions());
$("#room-actions-dialog").addEventListener("cancel", event => { event.preventDefault(); closeRoomActions(); });
$("#room-actions-query").addEventListener("input", renderRoomActions);
$("#room-actions-list").addEventListener("click", event => chooseRoomChoice(event.target.closest("[data-room-channel], [data-room-task], [data-room-action]")));
$("#room-actions-dialog").addEventListener("keydown", event => {
  if (event.isComposing || event.keyCode === 229) { if (event.key === "Enter") event.preventDefault(); return; }
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  if (event.key === "Escape") { event.preventDefault(); closeRoomActions(); return; }
  if (event.key === "Enter" && event.repeat) { event.preventDefault(); return; }
  const buttons = [...$("#room-actions-list").querySelectorAll("button")], index = buttons.indexOf(document.activeElement);
  if (["ArrowDown", "ArrowUp"].includes(event.key)) {
    event.preventDefault();
    const next = event.key === "ArrowDown" ? index + 1 : index < 0 ? buttons.length - 1 : index - 1;
    (buttons[next] || $("#room-actions-query")).focus();
  } else if (event.key === "Enter" && document.activeElement === $("#room-actions-query")) {
    event.preventDefault(); if (!event.repeat && buttons[0]) chooseRoomChoice(buttons[0]);
  }
});
document.addEventListener("keydown", event => {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || event.key.toLowerCase() !== "k"
    || event.isComposing || event.keyCode === 229 || event.repeat || !ownsRoomActions(null)) return;
  if (document.querySelector("dialog[open]") && !$("#room-actions-dialog").open) return;
  event.preventDefault(); if ($("#room-actions-dialog").open) closeRoomActions(); else openRoomActions();
});
new MutationObserver(() => { if (roomActionsContext && !ownsRoomActions()) closeRoomActions(false); })
  .observe($("#main"), { attributes: true, attributeFilter: ["hidden"] });
new MutationObserver(() => { if (resultView && $("#main").hidden) closeResult(false); })
  .observe($("#main"), { attributes: true, attributeFilter: ["hidden"] });
// Attention: advancing the read horizon is scroll-driven (debounced). Both the
// message list and the window can be the scroller depending on layout. Only a
// reader's scroll counts: one that follows wheel, touch, a scroll key or a
// pointer on the list's own scrollbar. The app's layout and programmatic
// scrolls (chrome settling, menus closing, the pin) never mark anything read,
// so Mark unread survives a reload. A reader scroll keeps the window open
// while it runs, which covers touch momentum.
const READER_SCROLL_MS = 1000;
let readerScrollAt = -Infinity;
const readerScrolling = () => performance.now() - readerScrollAt < READER_SCROLL_MS;
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);
const noteReaderScroll = () => { readerScrollAt = performance.now(); };
addEventListener("wheel", noteReaderScroll, { capture: true, passive: true });
addEventListener("touchmove", noteReaderScroll, { capture: true, passive: true });
addEventListener("keydown", event => { if (SCROLL_KEYS.has(event.key) && !event.target?.closest?.("input, textarea, select, [contenteditable]")) noteReaderScroll(); }, { capture: true });
$("#message-list").addEventListener("pointerdown", event => { if (event.target === event.currentTarget) noteReaderScroll(); }, { passive: true });
for (const scroller of [$("#message-list"), window]) {
  scroller.addEventListener("scroll", () => {
    if (!readerScrolling()) return;
    noteReaderScroll();
    if (scroller !== window && pinScrollTop !== null) {
      const pinned = $("#message-list").scrollTop === pinScrollTop; pinScrollTop = null;
      if (pinned) return;
    }
    if (nearBottomOfList()) scheduleHorizonAdvance();
  }, { passive: true });
}
$("#main").addEventListener("click", e => {
  const link = e.target.closest("[data-open-message], [data-open-work], [data-open-member], [data-open-event], [data-open-room]");
  if (!link || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  if (busy) return;
  // JDOT-COH-NAV begin
  if (!link.dataset.openWork) { updatesUi?.cancelPending(); activeWorkNavigation = null; workNavigationEpoch++; $("#work-navigation-return").hidden = true; }
  // JDOT-COH-NAV end
  if (link.dataset.openMessage) {
    history.replaceState(null, "", recordHref("message", link.dataset.openMessage));
    revealMessage(link.dataset.openMessage);
  } else if (link.dataset.openWork) {
    // JDOT-COH-NAV begin
    navigateWorkRecord("work", link.dataset.openWork, link.hasAttribute("data-view-drafts") ? { presentation: "drafts" } : {});
    // JDOT-COH-NAV end
  } else if (link.dataset.openMember) {
    history.replaceState(null, "", recordHref("member", link.dataset.openMember));
    revealMember(link.dataset.openMember);
  } else if (link.dataset.openEvent) {
    history.replaceState(null, "", recordHref("event", link.dataset.openEvent));
    revealEvent(link.dataset.openEvent);
  } else {
    history.replaceState(null, "", recordHref("room", state.room.id));
    revealRoom();
  }
});
// History can change the room query as well as the fragment. Those entries
// need popstate dispatch even when the browser does not emit hashchange.
window.addEventListener("popstate", () => {
  // JDOT-COH-NAV begin
  if (replayWorkNavigation()) return;
  // JDOT-COH-NAV end
  if (location.hash.startsWith("#pr-view/")) revealLocationHash();
});
window.addEventListener("hashchange", () => {
  revealAgentSigninLink();
  const fragment = consumeInvitationFragment();
  if (redirectAgentInvite(fragment)) return;
  if (fragment) openInvitation(fragment);
  // JDOT-COH-NAV begin
  else if (!replayWorkNavigation()) revealLocationHash();
  // JDOT-COH-NAV end
});
$("#new-messages-button").addEventListener("click", () => {
  const list = $("#message-list"); list.scrollTop = list.scrollHeight; newVisibleMessages = 0; unreadAnchorId = null;
  $("#new-messages-button").hidden = true; list.focus({ preventScroll: true });
});
// Pinned messages (issue #6 B2): any active member can pin or unpin a live
// message; the room keeps at most PIN_LIMIT pins in the order they were placed.
// The server re-checks membership per call and a deleted message drops out of
// the list; this is the honest view of state.pins plus the two controls.
async function setPinned(messageId) {
  if (pendingPins.has(messageId) || !state || !conversation.byId.get(messageId)) return;
  const pinned = isPinned(state, messageId);
  if (!pinned && pinnedMessages(state).length >= PIN_LIMIT) { notice(`This room already has ${PIN_LIMIT} pinned messages. Unpin one first.`, true); return; }
  // Re-entry is guarded by pendingPins rather than a disabled control, so a keyboard user's focus stays on the button.
  const pending = draftCommand(null, pinned ? T.MESSAGE_UNPINNED : T.MESSAGE_PINNED, { messageId });
  pendingPins.add(messageId);
  const generation = client.generation;
  try {
    await client.send(pending.command);
    if (generation === client.generation && state) notice(pinned ? "Message unpinned." : "Message pinned.");
  } catch (error) {
    if (generation === client.generation && state) notice(`${error.message}. Nothing was pinned or unpinned.`, true);
  } finally { pendingPins.delete(messageId); if (state && generation === client.generation) renderMessages(); }
}
function renderPinned() {
  const panel = $("#pinned-panel"), list = $("#pinned-list");
  const pins = state ? pinnedMessages(state) : [];
  panel.hidden = pins.length === 0;
  setText("#pinned-count", pins.length ? `${pins.length} of ${PIN_LIMIT}` : "");
  if (!pins.length) { list.innerHTML = ""; return; }
  const html = pins.map(({ message: m, pinnedById }) => `<li class="pinned-item" data-pinned-message="${esc(m.id)}"><a class="source-link pinned-link" href="${esc(recordHref("message", m.id))}" data-open-message="${esc(m.id)}">${esc(displayName(m.authorId))} · <time datetime="${esc(m.createdAt)}">${esc(time(m.createdAt))}</time></a><p class="pinned-body">${esc(m.body.length > 200 ? `${m.body.slice(0, 200)}…` : m.body)}</p><span class="pinned-meta">Pinned by ${esc(displayName(pinnedById))}</span><button type="button" class="text-button" data-message-action="pin" data-message-id="${esc(m.id)}" aria-label="Unpin message by ${esc(displayName(m.authorId))}">Unpin</button></li>`).join("");
  if (list.innerHTML !== html) {
    // Keyboard users keep their place: the same item's control when it is still there,
    // otherwise the neighbouring item, otherwise the section heading. Focus never falls to the page body.
    const focusedItem = list.contains(document.activeElement) ? document.activeElement.closest("[data-pinned-message]") : null;
    const focusedId = focusedItem?.dataset.pinnedMessage, focusedIndex = focusedItem ? [...list.children].indexOf(focusedItem) : -1;
    list.innerHTML = html;
    if (focusedItem) {
      const buttons = [...list.querySelectorAll("button")];
      const target = list.querySelector(`[data-pinned-message="${CSS.escape(focusedId)}"] button`) ?? buttons[Math.min(focusedIndex, buttons.length - 1)] ?? $("#pinned-panel > summary");
      target.focus({ preventScroll: true });
    }
  }
}
$("#pinned-list").addEventListener("click", e => {
  const button = e.target.closest("[data-message-action=\"pin\"]");
  if (button && state && !busy) setPinned(button.dataset.messageId);
});

async function setReaction(messageId, reaction) {
  const emoji = canonicalReaction(reaction);
  const key = emoji ? `${messageId}:${emoji}` : "";
  const previous = key ? pendingReactions.get(key) : null;
  const message = conversation?.byId.get(messageId);
  if (!emoji || !message || previous?.busy) return;
  const selected = reactionPills(message.reactions).some(pill => pill.key === emoji && pill.memberIds.includes(session.member.id));
  const active = !selected;
  const pending = previous || draftCommand(null, T.MESSAGE_REACTION_SET, { messageId, reaction: emoji, active });
  pending.busy = true; pendingReactions.set(key, pending); renderMessages();
  const generation = client.generation;
  try {
    const receipt = await client.send(pending.command);
    if (generation !== client.generation || !state) return;
    // A successful command receipt can update this member's choice while a snapshot is delayed.
    if (client.sequence < receipt.sequence) {
      const current = conversation.byId.get(messageId);
      const folded = foldedReactionMap(current.reactions);
      const ids = new Set(folded[emoji] || []);
      if (receipt.event.data.active) ids.add(session.member.id); else ids.delete(session.member.id);
      if (ids.size) folded[emoji] = [...ids].sort(); else delete folded[emoji];
      current.reactions = folded;
    }
    pendingReactions.delete(key);
  } catch (error) {
    if (generation === client.generation && state) { pending.busy = false; notice(`${error.message}. Retry keeps the same reaction choice.`, true); }
  } finally { if (state && generation === client.generation) renderMessages(); }
}

// Reaction sheet (Slack/Discord style): no always-visible picker. A long-press
// on a message (touch), a right-click (desktop), or the "Add reaction" item in
// the ⋯ menu opens a sheet with the room's reactions; tapping one toggles it.
const REACTION_SHEET_LONGPRESS_MS = 550;
let reactionSheetMessageId = null, reactionSheetInvokerKey = null;
let longpressTimer = null, longpressAt = 0, longpressStartX = 0, longpressStartY = 0;
function clearLongpress() {
  if (longpressTimer) { clearTimeout(longpressTimer); longpressTimer = null; }
}
const RECENT_EMOJI_KEY = "project-room:recent-emoji";
function recentEmoji() {
  try {
    const parsed = JSON.parse(localStorage.getItem(RECENT_EMOJI_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.map(canonicalReaction).filter(Boolean).slice(0, 16) : [];
  } catch { return []; }
}
function rememberEmoji(emoji) {
  const key = canonicalReaction(emoji);
  if (!key) return;
  const next = [key, ...recentEmoji().filter(item => item !== key)].slice(0, 16);
  try { localStorage.setItem(RECENT_EMOJI_KEY, JSON.stringify(next)); } catch { /* recent emoji are optional */ }
}
function reactionChoiceButton(emoji, pressed) {
  return `<button type="button" class="reaction-pick" data-reaction="${esc(emoji)}" aria-pressed="${pressed}" aria-label="${esc(emojiName(emoji))}">${emoji}</button>`;
}
function renderReactionChoices(message, query) {
  const pressed = new Set(reactionPills(message.reactions).filter(pill => pill.memberIds.includes(session.member.id)).map(pill => pill.key));
  const q = String(query ?? "").trim();
  if (q) {
    const matches = emojiMatches(q, 64);
    if (!matches.length) return `<p class="reaction-sheet-empty">No emoji match.</p>`;
    return `<div class="reaction-grid" role="group" aria-label="Emoji matches">${matches.map(item => reactionChoiceButton(item.emoji, pressed.has(item.emoji))).join("")}</div>`;
  }
  const quick = frequentEmoji(recentEmoji());
  const quickHtml = `<p class="reaction-sheet-heading" id="reaction-frequent-label">Frequent</p><div class="reaction-grid" role="group" aria-labelledby="reaction-frequent-label">${quick.map(emoji => reactionChoiceButton(emoji, pressed.has(emoji))).join("")}</div>`;
  const catalog = emojiCatalog().map(({ category, items }) => {
    const id = `reaction-cat-${category.toLowerCase().replace(/[^a-z]+/g, "-").replace(/^-|-$/g, "")}`;
    return `<p class="reaction-sheet-heading" id="${id}">${esc(category)}</p><div class="reaction-grid" role="group" aria-labelledby="${id}">${items.map(item => reactionChoiceButton(item.emoji, pressed.has(item.emoji))).join("")}</div>`;
  }).join("");
  return quickHtml + catalog;
}
function openReactionSheet(messageId, invoker) {
  const message = conversation?.byId.get(messageId);
  if (!message || message.deletedAt || !state || busy) return;
  if (isMutedBy(state, session.member.id, message.authorId)) return;
  reactionSheetMessageId = messageId;
  reactionSheetInvokerKey = invoker?.dataset?.key || null;
  const sheet = $("#reaction-sheet");
  const search = $("#reaction-search");
  $("#reaction-sheet-label").textContent = `React to ${displayName(message.authorId)}’s message`;
  if (search) search.value = "";
  $("#reaction-sheet-options").innerHTML = renderReactionChoices(message, "");
  if (!sheet.open) sheet.showModal();
  search?.focus({ preventScroll: true });
}
function closeReactionSheet() {
  const sheet = $("#reaction-sheet");
  if (sheet?.open) sheet.close();
}
$("#reaction-sheet-close").addEventListener("click", closeReactionSheet);
$("#reaction-sheet").addEventListener("click", e => {
  if (e.target === e.currentTarget) closeReactionSheet();
});
$("#reaction-sheet").addEventListener("close", () => {
  reactionSheetMessageId = null;
  if (reactionSheetInvokerKey) {
    const node = document.querySelector(`#message-list [data-key="${CSS.escape(reactionSheetInvokerKey)}"]`);
    node?.focus({ preventScroll: true });
    reactionSheetInvokerKey = null;
  }
});
$("#reaction-search")?.addEventListener("input", () => {
  const message = conversation?.byId.get(reactionSheetMessageId);
  if (!message) return;
  $("#reaction-sheet-options").innerHTML = renderReactionChoices(message, $("#reaction-search").value);
});
function reactionSheetButtons() {
  return [...($("#reaction-sheet-options")?.querySelectorAll("button[data-reaction]") || [])];
}
$("#reaction-sheet").addEventListener("keydown", e => {
  const buttons = reactionSheetButtons();
  const search = $("#reaction-search");
  if (e.key === "ArrowDown" || e.key === "ArrowUp" || e.key === "ArrowLeft" || e.key === "ArrowRight") {
    if (!buttons.length) return;
    const index = buttons.indexOf(document.activeElement);
    if (document.activeElement === search || index < 0) {
      if (e.key === "ArrowUp" || e.key === "ArrowLeft") return;
      e.preventDefault();
      buttons[0].focus();
      return;
    }
    const grid = buttons[index].closest(".reaction-grid");
    const columns = grid ? Math.max(1, getComputedStyle(grid).gridTemplateColumns.split(" ").length) : 8;
    const delta = e.key === "ArrowLeft" ? -1 : e.key === "ArrowRight" ? 1 : e.key === "ArrowUp" ? -columns : columns;
    const next = index + delta;
    if (next < 0 || next >= buttons.length) return;
    e.preventDefault();
    buttons[next].focus();
    return;
  }
  if (e.key === "Enter" && document.activeElement === search && search.value.trim() && buttons[0]) {
    e.preventDefault();
    buttons[0].click();
  }
});
$("#reaction-sheet-options").addEventListener("click", e => {
  const button = e.target.closest("[data-reaction]");
  if (!button || !reactionSheetMessageId || busy) return;
  const id = reactionSheetMessageId;
  const emoji = button.dataset.reaction;
  rememberEmoji(emoji);
  closeReactionSheet();
  setReaction(id, emoji);
});
// Chrome that mounts or resizes around the timeline after it opened at the
// newest message (assistant panel, pill, composer) keeps it there (R68-1).
if (globalThis.ResizeObserver) new ResizeObserver(() => {
  const list = $("#message-list");
  if (timelinePin.holds(list.dataset.view, list)) stickPinnedTimeline(list);
}).observe($("#message-list"));
// The pin moving the list is not the reader scrolling, so it never marks
// anything read: its scroll event is skipped, and where the move hid a layout
// change that took the list off the bottom, a pending read-horizon advance is
// dropped as it would have been without the pin.
function stickPinnedTimeline(list) {
  const before = list.scrollTop, offBottom = list.scrollHeight - before - list.clientHeight >= 80;
  list.scrollTop = list.scrollHeight; timelinePin.set(list.dataset.view, list);
  if (list.scrollTop === before) return;
  pinScrollTop = list.scrollTop;
  if (offBottom) { clearTimeout(horizonAdvanceTimer); horizonAdvanceTimer = null; }
}
// Long-press (touch/pen): hold a message to open the reaction sheet.
$("#message-list").addEventListener("pointerdown", e => {
  if (e.pointerType === "mouse" || e.button !== 0) return;
  const node = e.target.closest("li.message");
  if (!node?.dataset.messageRecordId) return;
  clearLongpress();
  longpressStartX = e.clientX; longpressStartY = e.clientY;
  const messageId = node.dataset.messageRecordId;
  longpressTimer = setTimeout(() => {
    longpressTimer = null;
    longpressAt = Date.now();
    try { window.getSelection()?.removeAllRanges(); } catch {}
    openReactionSheet(messageId, node);
  }, REACTION_SHEET_LONGPRESS_MS);
});
$("#message-list").addEventListener("pointermove", e => {
  if (!longpressTimer) return;
  if (Math.hypot(e.clientX - longpressStartX, e.clientY - longpressStartY) > 10) clearLongpress();
});
for (const cancel of ["pointerup", "pointercancel"]) $("#message-list").addEventListener(cancel, clearLongpress);
// Right-click (desktop): open the reaction sheet instead of the native menu.
$("#message-list").addEventListener("contextmenu", e => {
  const node = e.target.closest("li.message");
  if (!node?.dataset.messageRecordId) return;
  e.preventDefault();
  // A contextmenu fired right after our own long-press already opened the sheet.
  if (Date.now() - longpressAt < 800) return;
  clearLongpress();
  openReactionSheet(node.dataset.messageRecordId, node);
});

// Decision register (backlog F2): a human with decide promotes a message into
// a source-backed decision; the room reads the register from the event feed.
let decisionSourceId = null;
function openDecision(messageId) {
  if (!can("decide") || busy || state.members[session.member.id]?.kind !== "human") return;
  const message = conversation.byId.get(messageId);
  if (!message) return;
  decisionSourceId = messageId;
  $("#decision-form").reset();
  $("#decision-source").textContent = `Source: ${name(message.authorId)}: ${message.deletedAt ? "Message deleted" : message.body.slice(0, 200)}`;
  setFormStatus($("#decision-status"), "");
  $("#decision-dialog").showModal();
  $("#decision-statement-input").focus();
}
$("#close-decision").addEventListener("click", () => { if (!busy) $("#decision-dialog").close(); });
$("#decision-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) $("#decision-dialog").close(); });
$("#decision-form").addEventListener("submit", e => {
  e.preventDefault();
  const data = { sourceMessageId: decisionSourceId, statement: $("#decision-statement-input").value.trim() };
  const note = $("#decision-note-input").value.trim();
  if (note) data.note = note;
  let entry;
  try { entry = draftCommand(null, T.DECISION_RECORDED, data); }
  catch (error) { setFormStatus($("#decision-status"), error.message, true); return; }
  submit($("#decision-form"), async () => {
    await client.send(entry.command);
    if (!state) return;
    $("#decision-dialog").close();
    decisionSourceId = null;
    notice("Decision recorded.");
  }, { failureHint: "Decision not saved. Retry the same entry, or close and start again." });
});
// Room spend allowance (issue #6 C3): every member sees allowance, spent,
// reserved, held and headroom from the same ledger the server enforces at
// session start; only the room owner sees the controls. Unknown spend is
// named (held, unreported), never rendered as zero.
const usd = cents => `$${(cents / 100).toFixed(2)}`;
const countOf = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
let spendFormRevision = null;
function renderSpendAllowance() {
  const panel = $("#spend-panel");
  if (!panel || !state?.room) return;
  const allowance = spendAllowance(state);
  const ledger = spendLedger(state, { nowMs: Date.now(), periodDays: allowance?.periodDays ?? 30 });
  const owner = session?.member?.id === state.room.ownerId && state.members[session.member.id]?.kind === "human";
  const committed = ledger.committedCents;
  panel.dataset.spendAllowance = !allowance ? "none" : committed > allowance.allowanceCents ? "over" : committed >= allowance.allowanceCents ? "full" : "set";
  setText("#spend-summary", allowance ? `${usd(committed)} of ${usd(allowance.allowanceCents)}` : "No allowance");
  const parts = [`${usd(ledger.spentCents)} spent`, `${usd(ledger.reservedCents)} reserved by ${countOf(ledger.sessions.live, "live session")}`];
  if (ledger.heldCents) parts.push(`${usd(ledger.heldCents)} held for ${countOf(ledger.sessions.attemptsHeld, "unreported attempt")}`);
  if (ledger.sessions.attemptsUnreported) parts.push(`${countOf(ledger.sessions.attemptsUnreported, "attempt")} with unknown spend`);
  const period = `over ${countOf(ledger.periodDays, "day")}`;
  setText("#spend-figures", allowance
    ? `${parts.join(" · ")} · ${committed > allowance.allowanceCents ? `over by ${usd(committed - allowance.allowanceCents)}` : `${usd(allowance.allowanceCents - committed)} left`} ${period}.`
    : `${parts.join(" · ")} ${period}. ${owner ? "Set an allowance to cap what agent sessions may commit here." : "The room owner has not set a spend allowance."}`);
  setText("#spend-note", allowance
    ? `Sessions must declare their maximum spend to start; the room reserves it until the run stops. Only the room owner can change this.`
    : "");
  const form = $("#spend-allowance-form");
  form.hidden = !owner;
  $("#spend-allowance-remove").hidden = !owner || !allowance;
  const revision = allowance?.revision ?? 0;
  if (owner && spendFormRevision !== revision && !form.contains(document.activeElement)) {
    spendFormRevision = revision;
    $("#spend-allowance-input").value = allowance ? (allowance.allowanceCents / 100).toFixed(2) : "";
    $("#spend-period-input").value = String(allowance?.periodDays ?? 30);
  }
  renderSpendPricingKillSwitch();
}
// Emergency spend-pricing kill switch (audit item 10): owner-only toggle in
// the Billing / plan section, wired to the existing owner-gated POST
// /api/rooms/:id/spend-pricing route. The toggle reads its state from the
// SSE-carried projection (state.room.spendPricing); the server gate is the
// real authorization. The container is created in JS so index.html stays
// untouched.
const spendPricingKillSwitch = createSpendPricingKillSwitch();
function renderSpendPricingKillSwitch() {
  const panel = $("#spend-panel");
  if (!panel || !state?.room || !client) return;
  let box = $("#spend-pricing-killswitch");
  if (!box) {
    box = document.createElement("div");
    box.id = "spend-pricing-killswitch";
    box.className = "spend-pricing-killswitch";
    panel.appendChild(box);
  }
  spendPricingKillSwitch.sync(box, { session, state, client, roomId: state.room.id });
}
function submitSpendAllowance(data, done, failureHint) {
  const form = $("#spend-allowance-form");
  let entry;
  try { entry = draftCommand(null, T.ROOM_SPEND_ALLOWANCE_SET, data); }
  catch (error) { setFormStatus(form.querySelector(".form-status"), error.message, true); return; }
  submit(form, async () => { await client.send(entry.command); if (!state) return; notice(done); }, { failureHint });
}
$("#spend-allowance-form").addEventListener("submit", e => {
  e.preventDefault();
  const dollarsText = $("#spend-allowance-input").value.trim(), periodDays = Number($("#spend-period-input").value);
  const allowanceCents = Math.round(Number(dollarsText) * 100);
  if (!dollarsText || !Number.isSafeInteger(allowanceCents) || allowanceCents < 0 || !Number.isSafeInteger(periodDays) || periodDays < 1 || periodDays > 365) {
    setFormStatus($("#spend-allowance-form .form-status"), "Enter the allowance in dollars (0 or more) and a period of 1 to 365 days.", true); return;
  }
  submitSpendAllowance({ allowanceCents, periodDays }, "Spend allowance set.", "Allowance not saved. Retry the same values.");
});
$("#spend-allowance-remove").addEventListener("click", () => {
  submitSpendAllowance({ allowanceCents: null }, "Spend allowance removed.", "Allowance not removed. Retry.");
});

// Moderation (issue #6 E4): report a message to the room owner; mute an author
// for yourself. A report is a private record the owner alone can list (no room
// event, nothing leaves the room); a mute is the viewer's own preference event.
let reportSourceId = null, reportsFlight = null, reportsSequence = -1, reportsGeneration = -1;
function openReport(messageId) {
  if (busy) return;
  const message = conversation.byId.get(messageId);
  if (!message || message.deletedAt || message.authorId === session.member.id) return;
  reportSourceId = messageId;
  $("#report-form").reset();
  $("#report-source").textContent = `Message from ${name(message.authorId)}: ${message.body.slice(0, 200)}`;
  setFormStatus($("#report-status"), "");
  $("#report-dialog").showModal();
  $("#report-reason-input").focus();
}
let messageEditTarget = null, messageDeleteTarget = null;
function ownEditableMessage(messageId) {
  const message = conversation.byId.get(messageId);
  return message && !message.deletedAt && message.authorId === session?.member.id ? message : null;
}
function openEditMessage(messageId) {
  if (busy) return;
  const message = ownEditableMessage(messageId);
  if (!message) return;
  messageEditTarget = { id: messageId, revision: message.revision ?? 0, generation: client.generation };
  $("#message-edit-input").value = message.body ?? "";
  setFormStatus($("#message-edit-status"), "");
  $("#message-edit-dialog").showModal();
  $("#message-edit-input").focus();
}
$("#close-message-edit").addEventListener("click", () => { if (!busy) { $("#message-edit-dialog").close(); messageEditTarget = null; } });
$("#message-edit-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) { $("#message-edit-dialog").close(); messageEditTarget = null; } });
$("#message-edit-form").addEventListener("submit", e => {
  e.preventDefault();
  const target = messageEditTarget, body = $("#message-edit-input").value;
  if (!target || !state || target.generation !== client.generation) return;
  const current = ownEditableMessage(target.id);
  if (!current) { $("#message-edit-dialog").close(); messageEditTarget = null; return; }
  if (body.length > MAX_MESSAGE_BODY_CHARS) { setFormStatus($("#message-edit-status"), uiText("message.edit_too_long", { limit: new Intl.NumberFormat("en-US").format(MAX_MESSAGE_BODY_CHARS) }), true); return; }
  if (!body.trim()) { setFormStatus($("#message-edit-status"), uiText("message.edit_empty"), true); return; }
  if (body === current.body) { $("#message-edit-dialog").close(); messageEditTarget = null; return; }
  submit($("#message-edit-form"), async () => {
    await client.send(draftCommand(null, T.MESSAGE_EDITED, { messageId: target.id, body, expectedMessageRevision: target.revision }).command);
    if (!state) return;
    $("#message-edit-dialog").close(); messageEditTarget = null;
  }, { failureHint: uiText("message.edit_failed_hint") });
});
function openDeleteMessage(messageId) {
  if (busy) return;
  const message = ownEditableMessage(messageId);
  if (!message) return;
  messageDeleteTarget = { id: messageId, revision: message.revision ?? 0, generation: client.generation };
  $("#message-delete-source").textContent = clipGraphemes(message.body, 200);
  setFormStatus($("#message-delete-status"), "");
  $("#message-delete-dialog").showModal();
  $("#close-message-delete").focus();
}
$("#close-message-delete").addEventListener("click", () => { if (!busy) { $("#message-delete-dialog").close(); messageDeleteTarget = null; } });
$("#message-delete-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) { $("#message-delete-dialog").close(); messageDeleteTarget = null; } });
$("#message-delete-form").addEventListener("submit", e => {
  e.preventDefault();
  const target = messageDeleteTarget;
  if (!target || !state || target.generation !== client.generation) return;
  submit($("#message-delete-form"), async () => {
    await client.send(draftCommand(null, T.MESSAGE_DELETED, { messageId: target.id, expectedMessageRevision: target.revision }).command);
    if (!state) return;
    $("#message-delete-dialog").close(); messageDeleteTarget = null;
  }, { failureHint: uiText("message.delete_failed_hint") });
});
$("#close-report").addEventListener("click", () => { if (!busy) $("#report-dialog").close(); });
$("#report-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) $("#report-dialog").close(); });
$("#report-form").addEventListener("submit", e => {
  e.preventDefault();
  const reason = $("#report-reason-input").value.trim();
  if (!reason) { setFormStatus($("#report-status"), "Say briefly why you are reporting this message.", true); return; }
  submit($("#report-form"), async () => {
    const result = await client.reports({ messageId: reportSourceId, reason });
    if (!state || !result) return;
    $("#report-dialog").close();
    reportSourceId = null;
    notice(result.duplicate ? "You already reported this message; the room owner has it." : "Report sent to the room owner. Only the owner sees it.");
  }, { failureHint: "Report not sent. Retry the same reason, or close and start again." });
});
async function setMute(memberId, muted) {
  const target = state?.members[memberId];
  if (!target || busy || memberId === session.member.id) return;
  const entry = draftCommand(null, T.MEMBER_MUTE_SET, { memberId, muted });
  const generation = client.generation;
  try {
    await client.send(entry.command);
    if (generation !== client.generation || !state) return;
    notice(muted ? `${target.displayName} muted for you. Their messages are hidden here until you unmute; nobody else is affected.` : `${target.displayName} unmuted.`);
  } catch (error) {
    if (generation === client.generation && state) notice(`${requestFailureMessage(error)}. Your mute choice was not changed.`, true);
  }
}
$("#presence-list").addEventListener("click", e => {
  const button = e.target.closest("[data-mute-member]");
  if (button && state) setMute(button.dataset.muteMember, button.dataset.muted !== "true");
});
$("#presence-list").addEventListener("click", async e => {
  const consentButton = e.target.closest("[data-dm-consent-action]");
  if (!consentButton || !state || !session || dmConsentBusy) return;
  e.preventDefault();
  await runDmConsentAction(consentButton.dataset.dmConsentAction, consentButton.dataset.dmConsentPeer, consentButton);
});
$("#presence-list").addEventListener("keydown", event => {
  if (event.key !== "Enter" && event.key !== " ") return;
  const friendButton = event.target?.closest?.("[data-friend-action]");
  // A held Enter repeats. The first press may already have proposed or
  // accepted; the repeat must not activate whatever button focus lands on
  // (Revoke is the hazard). The group itself never activates a child.
  if (friendButton) {
    if (!event.repeat) return;
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (!event.target?.closest?.(".friend-bond")) return;
  event.preventDefault();
});
$("#presence-list").addEventListener("click", async e => {
  const button = e.target.closest("[data-friend-action]");
  if (!button || !state || !session || friendBusy) return;
  e.preventDefault();
  await runFriendAction(button.dataset.friendAction, button.dataset.friendPeer, button.dataset.friendBond || "", button);
});
function syncReports() {
  const owner = Boolean(state && session && state.room?.ownerId === session.member.id && state.members[session.member.id]?.kind === "human");
  $("#reports-section").hidden = !owner;
  if (!owner) { reportsSequence = -1; return; }
  if ($("#reports-section").open && (reportsSequence !== client.sequence || reportsGeneration !== client.generation)) loadReports();
}
// UI calming #9: Usage + Spend sit under one collapsed, owner-only "Room
// health" group. About stays open; the spend allowance form keeps its behavior.
function syncRoomHealth() {
  const owner = Boolean(state && session && state.room?.ownerId === session.member.id && state.members[session.member.id]?.kind === "human");
  const panel = $("#room-health");
  if (!panel) return;
  panel.hidden = !owner;
  if (!owner) panel.open = false;
}
function loadReports() {
  if (reportsFlight) return;
  const generation = client.generation, sequence = client.sequence;
  reportsFlight = client.reports().then(result => {
    if (generation !== client.generation || !state || !result) return;
    reportsSequence = sequence; reportsGeneration = generation;
    renderReports(result.reports);
  }).catch(error => {
    if (generation === client.generation && state) setFormStatus($("#report-list-status"), `${requestFailureMessage(error)}. Open this section again to retry.`, true);
  }).finally(() => { reportsFlight = null; });
}
function renderReports(reports) {
  setFormStatus($("#report-list-status"), "");
  setText("#report-count", reports.length ? String(reports.length) : "");
  renderContent("#report-list", reports.map(report => {
    const message = report.message;
    const excerpt = !message ? "Message no longer in this room" : message.deletedAt ? "Message deleted" : message.body.slice(0, 160);
    return `<li data-report-id="${esc(report.id)}"><strong>${esc(report.reason)}</strong> <span class="rb-detail">reported by ${esc(memberLabel(report.reporterId))} · ${esc(time(report.createdAt))}</span><br><a class="source-link" href="${esc(recordHref("message", report.messageId))}" data-open-message="${esc(report.messageId)}" data-focus-key="report-source:${esc(report.id)}">${esc(memberLabel(report.authorId))}: ${esc(excerpt)}</a></li>`;
  }).join("") || '<li class="rb-empty">No reports. Members report a message from its Report action; only you see them here.</li>');
}
$("#reports-section").addEventListener("toggle", () => { if ($("#reports-section").open) syncReports(); });
// Reports append no room event, so a new one does not move the stream; the owner can ask again.
$("#report-refresh").addEventListener("click", () => { reportsSequence = -1; syncReports(); });
// Room Trust: a settings control, shown to the owner when the room has more
// than one member-owner. On (the default) allows cross-owner assign and wake.
// Off is the kill-switch. Same-owner work is never gated here.
let roomTrustBusy = false;
function syncRoomTrust() {
  const button = $("#room-trust-toggle");
  if (!button) return;
  const viewerId = session?.member?.id;
  const show = Boolean(state && viewerId && viewerId === state.room.ownerId && distinctMemberOwnerIds(state).size > 1);
  button.hidden = !show;
  if (!show) return;
  const enabled = roomTrust(state).enabled;
  button.setAttribute("aria-pressed", enabled ? "true" : "false");
  button.textContent = enabled ? "Cross-owner collaboration on" : "Cross-owner collaboration off";
  button.title = enabled
    ? "Trust is on. Members may assign and wake agents across owners. Turn off to block that."
    : "Trust is off. Cross-owner assign and wake are blocked. Turn on to allow them again.";
  button.disabled = roomTrustBusy;
}
$("#room-trust-toggle").addEventListener("click", async () => {
  if (!state || roomTrustBusy || session?.member?.id !== state.room.ownerId) return;
  const enabled = !roomTrust(state).enabled;
  roomTrustBusy = true;
  syncRoomTrust();
  try {
    await client.send({ id: crypto.randomUUID(), type: T.ROOM_TRUST_SET, data: { enabled } });
  } catch (error) {
    notice(error.message || "Trust was not changed.", true);
  } finally {
    roomTrustBusy = false;
    if (state) syncRoomTrust();
  }
});
// --- GR1 public receipts: owner-only, default off. ---
let publicReceiptsBusy = false;
function syncPublicReceipts() {
  const control = $("#public-receipts-control");
  const box = $("#public-receipts-toggle");
  if (!control || !box) return;
  const viewerId = session?.member?.id;
  const show = Boolean(state && viewerId && viewerId === state.room.ownerId);
  control.hidden = !show;
  if (!show) return;
  box.checked = state.room.publicReceipts?.enabled === true;
  box.disabled = publicReceiptsBusy;
}
$("#public-receipts-toggle")?.addEventListener("change", async () => {
  if (!state || publicReceiptsBusy || session?.member?.id !== state.room.ownerId) return;
  const enabled = $("#public-receipts-toggle").checked;
  publicReceiptsBusy = true;
  syncPublicReceipts();
  try {
    await client.send({ id: crypto.randomUUID(), type: T.ROOM_PUBLIC_RECEIPTS_SET, data: { enabled } });
  } catch (error) {
    notice(error.message || "Public receipts were not changed.", true);
    if (state) $("#public-receipts-toggle").checked = state.room.publicReceipts?.enabled === true;
  } finally {
    publicReceiptsBusy = false;
    if (state) syncPublicReceipts();
  }
});
// --- end GR1 ---
// --- PRIV-2 history visibility: owner-only. ---
let historyVisibilityBusy = false;
function historyVisibilitySinceJoin() {
  return state?.room?.historyVisibility?.value === "since_join";
}
function syncHistoryVisibility() {
  const control = $("#history-visibility-control");
  const box = $("#history-visibility-toggle");
  const hint = $("#history-visibility-hint");
  if (!control || !box) return;
  const viewerId = session?.member?.id;
  const show = Boolean(state && viewerId && viewerId === state.room.ownerId);
  // Export is owner-only (PRIV-2): other members don't get a button that can only refuse.
  const exportActions = $("#record-export-html")?.closest(".record-actions");
  if (exportActions) exportActions.hidden = !show;
  control.hidden = !show;
  if (hint) hint.hidden = !show;
  if (!show) return;
  box.checked = historyVisibilitySinceJoin();
  box.disabled = historyVisibilityBusy;
  if (hint) {
    const guestDefault = !state.room.historyVisibility && state.room.historyDefaultsVersion === 1;
    hint.textContent = guestDefault
      ? "Until you choose, link guests and agent guests see only messages from after they join. You and members who manage membership always see the full history."
      : "You and members who manage membership always see the full history.";
  }
}
$("#history-visibility-toggle")?.addEventListener("change", async () => {
  if (!state || historyVisibilityBusy || session?.member?.id !== state.room.ownerId) return;
  const historyVisibility = $("#history-visibility-toggle").checked ? "since_join" : "all";
  historyVisibilityBusy = true;
  syncHistoryVisibility();
  try {
    await client.send({ id: crypto.randomUUID(), type: T.ROOM_HISTORY_VISIBILITY_SET, data: { historyVisibility } });
  } catch (error) {
    notice(error.message || "History visibility was not changed.", true);
    if (state) $("#history-visibility-toggle").checked = historyVisibilitySinceJoin();
  } finally {
    historyVisibilityBusy = false;
    if (state) syncHistoryVisibility();
  }
});
// --- end PRIV-2 ---
// --- GR2 public room page, join link, name, and starter-template controls. ---
let acquisitionBusy = false;
function syncAcquisitionControls() {
  const viewerId = session?.member?.id;
  const isOwner = Boolean(state && viewerId && viewerId === state.room.ownerId);
  const pageControl = $("#public-page-control");
  const pageBox = $("#public-page-toggle");
  const joinControl = $("#join-link-control");
  const joinBox = $("#join-link-toggle");
  const nameControl = $("#public-name-control");
  const nameBox = $("#public-name-toggle");
  const tasksControl = $("#public-tasks-control");
  if (pageControl && pageBox) {
    pageControl.hidden = !isOwner;
    if (isOwner) { pageBox.checked = state.room.publicPage?.enabled === true; pageBox.disabled = acquisitionBusy; }
  }
  if (joinControl && joinBox) {
    joinControl.hidden = !isOwner;
    if (isOwner) { joinBox.checked = state.room.joinLink?.enabled === true; joinBox.disabled = acquisitionBusy; }
  }
  const member = state && viewerId ? state.members[viewerId] : null;
  if (nameControl && nameBox) {
    nameControl.hidden = !member;
    if (member) { nameBox.checked = member.publicName?.enabled === true; nameBox.disabled = acquisitionBusy; }
  }
  if (tasksControl) {
    tasksControl.hidden = !isOwner;
    const list = $("#public-tasks-list");
    if (isOwner && list) {
      const open = Object.values(state.workItems ?? {}).filter(item => ["proposed", "accepted", "working", "blocked"].includes(item.state));
      list.replaceChildren(...open.map(item => {
        const li = document.createElement("li");
        const label = document.createElement("label");
        const box = document.createElement("input");
        box.type = "checkbox";
        box.checked = item.publicTask?.enabled === true;
        box.disabled = acquisitionBusy;
        box.addEventListener("change", () => sendAcquisition(T.WORK_PUBLIC_SET, { workItemId: item.id, enabled: box.checked }));
        label.append(box, document.createTextNode(" " + item.title));
        li.append(label);
        return li;
      }));
    }
  }
}
async function sendAcquisition(type, data) {
  if (!state || acquisitionBusy) return;
  acquisitionBusy = true;
  syncAcquisitionControls();
  try { await client.send({ id: crypto.randomUUID(), type, data }); }
  catch (error) { notice(error.message || "That setting was not changed.", true); }
  finally { acquisitionBusy = false; if (state) syncAcquisitionControls(); }
}
$("#public-page-toggle")?.addEventListener("change", () => {
  if (session?.member?.id !== state?.room?.ownerId) return;
  sendAcquisition(T.ROOM_PUBLIC_PAGE_SET, { enabled: $("#public-page-toggle").checked });
});
$("#join-link-toggle")?.addEventListener("change", () => {
  if (session?.member?.id !== state?.room?.ownerId) return;
  sendAcquisition(T.ROOM_JOIN_LINK_SET, { enabled: $("#join-link-toggle").checked });
});
$("#public-name-toggle")?.addEventListener("change", () => {
  if (!session?.member?.id) return;
  sendAcquisition(T.MEMBER_PUBLIC_NAME_SET, { enabled: $("#public-name-toggle").checked });
});
async function loadTemplateChoices() {
  const select = $("#account-room-template");
  if (!select || select.dataset.loaded === "true") return;
  select.dataset.loaded = "true";
  try {
    const body = await (await fetch("/templates.json")).json();
    for (const template of body.templates ?? []) {
      const option = document.createElement("option");
      option.value = template.slug;
      option.textContent = template.title;
      option.dataset.purpose = template.purpose;
      select.append(option);
    }
  } catch { select.dataset.loaded = ""; }
}
$("#account-room-template")?.addEventListener("change", () => {
  const option = $("#account-room-template").selectedOptions[0];
  if (!option?.value) return;
  const title = $("#account-room-title");
  const purpose = $("#account-room-purpose");
  if (title && !title.value) title.value = option.textContent;
  if (purpose && !purpose.value && option.dataset.purpose) purpose.value = option.dataset.purpose;
});
$("#account-room-create")?.addEventListener("toggle", () => { if ($("#account-room-create").open) loadTemplateChoices(); });
async function startRoomFromTemplate(slug) {
  const owned = accountClient.session;
  $("#account-rooms-status").textContent = "Creating your room…";
  const listed = await (await fetch("/templates.json")).json();
  const template = (listed.templates ?? []).find(item => item.slug === slug);
  if (!template) { $("#account-rooms-status").textContent = "That template is not available."; return; }
  let roomId = window.sessionStorage.getItem(TEMPLATE_ROOM_KEY);
  if (!roomId) {
    roomId = "room-" + crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    window.sessionStorage.setItem(TEMPLATE_ROOM_KEY, roomId);
  }
  const ref = receiptReferrer();
  const session = accountClient.currentSession("creating a room", { authenticated: true });
  const result = await accountClient.request("/api/account-rooms/from-template", {
    method: "POST",
    data: { roomId, template: slug, title: template.title, purpose: template.purpose, kind: "personal", displayName: "Owner", ...(ref ? { ref } : {}) },
    session,
  });
  if (accountClient.session !== owned) return;
  await openAccountRoom(result.room.id);
  window.sessionStorage.removeItem(TEMPLATE_ROOM_KEY);
}
async function showAgentInvitePicker(agentId) {
  inboxUI.showRoomList();
  const box = $("#acq-invite");
  const status = $("#acq-invite-status");
  const rooms = $("#acq-invite-rooms");
  const link = $("#acq-invite-link");
  if (!box || !rooms) return;
  box.hidden = false;
  if (link) link.hidden = true;
  if (status) status.textContent = "Loading rooms…";
  const directory = await (await fetch("/api/agent-directory")).json();
  const agent = (directory.agents ?? []).find(item => item.agentId === agentId);
  if ($("#acq-invite-title")) $("#acq-invite-title").textContent = agent ? `Invite ${agent.name}` : "Invite an agent";
  if (!agent) { if (status) status.textContent = "That agent does not have a public card."; return; }
  const session = accountClient.currentSession("loading rooms", { authenticated: true });
  const listed = await accountClient.request("/api/account-rooms", { session });
  rooms.replaceChildren();
  if (!listed.rooms?.length) { if (status) status.textContent = "Create a room first, then invite this agent."; return; }
  if (status) status.textContent = `Pick a room. The join link is yours to send to the operator of ${agent.name}.`;
  for (const room of listed.rooms) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button secondary";
    button.textContent = room.title || room.id;
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        const response = await fetch(`/api/rooms/${encodeURIComponent(room.id)}/referrals`, {
          credentials: "same-origin",
          headers: { "X-Project-Room-Auth": "account", "X-Session-Binding": accountClient.session.sessionBinding },
        });
        const body = await response.json();
        if (!response.ok || !body.invite?.hash) { if (status) status.textContent = "Couldn’t mint a join link for that room."; return; }
        if (link) {
          link.hidden = false;
          link.textContent = `Send ${body.invite.hash} to the operator of ${agent.name}. A join through it is credited to you.`;
        }
        clearAcquisition();
      } finally { button.disabled = false; }
    });
    rooms.append(button);
  }
}
async function runAcquisitionIntent() {
  const intent = readAcquisition();
  if (!intent || state || !accountClient.session?.authenticated) return;
  try {
    if (intent.kind === "request") {
      clearAcquisition();
      inboxUI.showRoomList();
      const input = $("#account-request-room");
      if (input && intent.roomId) input.value = intent.roomId;
      const details = $("#account-request-access");
      if (details) details.open = true;
      const referred = $("#account-request-referred");
      const ref = receiptReferrer();
      if (referred && !referred.value && ref) referred.value = ref;
      return;
    }
    if (intent.kind === "template") {
      await startRoomFromTemplate(intent.template);
      clearAcquisition();
      return;
    }
    if (intent.kind === "invite-agent") await showAgentInvitePicker(intent.agent);
  } catch {
    $("#account-rooms-status").textContent = "Couldn’t finish that. Refresh and try again.";
  }
}
// --- end GR2 ---
// Room policy (issue #6 A4): when the owner made review or approval mandatory,
// the proposer sees the requirement locked on with the reason. The server
// enforces it regardless of what a client sends; this is only the honest view.
function syncWorkPolicy() {
  const policy = roomPolicy(state);
  for (const [id, required] of [["#require-verification", policy.requireIndependentReview], ["#require-decision", policy.requireOwnerDecision]]) {
    const box = $(id);
    if (required) box.checked = true;
    box.disabled = required;
  }
  const required = [policy.requireIndependentReview && "independent review", policy.requireOwnerDecision && "owner approval"].filter(Boolean);
  // The "turn off review" escape does not exist under policy; say so and drop the settings shortcut.
  $("#reviewer-unavailable-text").textContent = policy.requireIndependentReview
    ? "No independent reviewer available. Room policy requires review: change the owner, or ask the room owner to add a reviewer."
    : "No independent reviewer available. Change the owner or turn off review.";
  $("#review-settings-button").hidden = policy.requireIndependentReview;
  $("#work-policy-note").hidden = required.length === 0;
  $("#work-policy-note").textContent = required.length ? `Room policy: ${required.join(" and ")} ${required.length > 1 ? "are" : "is"} required for every new outcome in this room. Only the room owner can change this.` : "";
}
function openWork(sourceId = null, reuseId = null) {
  if (!can("steer") || busy) return;
  if (!$("#new-work-form").hidden) { $(workRetryLocked ? "#retry-work-button" : "#work-title-input").focus(); return; }
  let definition;
  if (reuseId) {
    try { definition = reusableWorkDefinition(state.workItems[reuseId]); }
    catch (error) { notice(error.message, true); return; }
  }
  workFormOpener = { node: document.activeElement, key: document.activeElement?.dataset.focusKey };
  workFormEpoch++; setWorkRetry(false);
  $("#new-work-form").reset();
  $("#new-work-form").hidden = false; workDraftId = `work-${crypto.randomUUID()}`;
  $("#work-options").open = false;
  $("#work-dialog").showModal();
  $("#source-message-id").value = sourceId || "";
  if (sourceId) $("#work-title-input").value = (state.messages.find(m => m.id === sourceId)?.body || "").trim().replace(/\s+/g, " ").slice(0, 100).replace(/[\uD800-\uDBFF]$/, "");
  if (definition) {
    // The title field is a single-line input: HTML value sanitization strips newlines,
    // silently joining words ("Weekly\nagenda" -> "Weeklyagenda"). Normalize whitespace
    // runs to single spaces instead, matching the message-source path above.
    $("#work-title-input").value = definition.title.replace(/\s+/g, " ");
    $("#work-done-input").value = definition.definitionOfDone;
  }
  $("#work-reuse-hint").hidden = !definition;
  const recipeSelect = $("#work-recipe-select");
  if (definition || sourceId) $("#work-recipe-field").hidden = true;
  else {
    const recipes = workRecipeOptions(state.workItems, { eventLog: state.eventLog });
    recipeSelect.replaceChildren(new Option("Blank outcome", ""));
    for (const recipe of recipes) recipeSelect.add(new Option(recipe.title.replace(/\s+/g, " ").slice(0, 80), recipe.workItemId));
    $("#work-recipe-field").hidden = recipes.length === 0;
  }
  $("#source-context").textContent = sourceId ? `Source: ${state.messages.find(m => m.id === sourceId)?.body || ""}` : "";
  $("#source-context").hidden = !sourceId; $("#work-title-input").focus();
  syncWorkForm();
  // Only initial creation in a genuinely solo room has one valid assignee.
  // Reused definitions and subsequent live edits retain their existing choices.
  const active = Object.values(state.members).filter(member => member.active !== false);
  const sole = active.length === 1 && active[0];
  if (!definition && sole?.kind === "human" && sole.id === session.member.id
    && WORK_PERMISSIONS.every(permission => sole.permissions.includes(permission))) {
    $("#assignee-select").value = sole.id;
    if (!roomPolicy(state).requireIndependentReview) $("#require-verification").checked = false;
    syncWorkForm();
  }
}
function closeWorkForm({ returnFocus = true } = {}) {
  const unconfirmed = workRetryLocked;
  $("#work-dialog").close();
  $("#new-work-form").hidden = true; $("#new-work-form").reset();
  setWorkRetry(false); $("#work-reuse-hint").hidden = true; $("#work-recipe-field").hidden = true;
  setFormStatus($("#new-work-status"), "");
  pendingWork = null; workDraftId = null;
  const opener = workFormOpener; workFormOpener = null;
  const epoch = ++workFormEpoch, generation = client.generation, roomId = session?.roomId, memberId = session?.member?.id;
  const focusAtClose = document.activeElement;
  if (unconfirmed) notice("Creation may already be saved. Check the work list before creating another.");
  if (returnFocus) setTimeout(() => {
    if (epoch !== workFormEpoch || !sameSession(generation, roomId, memberId) || !$("#new-work-form").hidden || document.activeElement !== focusAtClose) return;
    const usable = node => node?.isConnected && !node.disabled && !node.hidden && node.getClientRects().length > 0;
    const replacement = opener?.key ? [...document.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === opener.key) : null;
    const target = [opener?.node, replacement, $("#new-work-button"), $("#composer-options-toggle")].find(usable) || $("#conversation-title");
    target.focus({ preventScroll: true });
  }, 0);
}
function setWorkRetry(locked) {
  workRetryLocked = locked;
  for (const control of document.querySelectorAll("#new-work-form input, #new-work-form textarea, #new-work-form select")) control.disabled = locked;
  $("#new-work-form button[type='submit']").hidden = locked;
  $("#retry-work-button").hidden = !locked;
  $("#work-retry-hint").hidden = !locked;
  $("#cancel-work-button").textContent = locked ? "Close" : "Cancel";
}
$("#work-recipe-select").addEventListener("change", event => {
  const recipeId = event.target.value;
  if (!recipeId) { $("#work-title-input").value = ""; $("#work-done-input").value = ""; return; }
  const item = state?.workItems?.[recipeId];
  if (!item) return;
  try {
    const recipe = reusableWorkDefinition(item);
    // Single-line title input strips newlines; normalize to spaces (see openWork).
    $("#work-title-input").value = recipe.title.replace(/\s+/g, " ");
    $("#work-done-input").value = recipe.definitionOfDone;
  } catch { /* Definition changed since the list was built; leave the fields as they are. */ }
});
$("#new-work-button").addEventListener("click", () => openWork());
$("#review-settings-button").addEventListener("click", () => {
  $("#work-options").open = true;
  $("#require-verification").focus();
});
$("#cancel-work-button").addEventListener("click", () => closeWorkForm());
$("#work-dialog").addEventListener("cancel", event => { event.preventDefault(); if (!busy) closeWorkForm(); });
$("#new-work-form").addEventListener("change", syncWorkForm);
$("#new-work-form").addEventListener("submit", e => { e.preventDefault(); sendWorkProposal(); });
$("#retry-work-button").addEventListener("click", () => { if (workRetryLocked) sendWorkProposal(); });
$("#message-list").addEventListener("click", e => {
  if (e.target.closest("[data-empty-work]")) { $("#new-work-button").click(); return; }
  if (e.target.closest("[data-empty-suggest]")) { $("#message-input").focus(); return; }
  const button = e.target.closest("[data-reuse-work]");
  if (button) openWork(null, button.dataset.reuseWork);
});
document.addEventListener("click", async e => {
  const button = e.target.closest("[data-access-preview]");
  if (!button || !state || !session) return;
  const workId = button.dataset.accessPreview;
  if (accessPreviews.has(workId)) { accessPreviews.delete(workId); renderReturnBrief(); return; }
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  button.disabled = true;
  try {
    const context = await client.workContext(workId);
    if (!context || !sameSession(generation, roomId, memberId)) return;
    accessPreviews.set(workId, { summary: context.accessSummary, evaluatedAt: context.evaluatedAt });
  } catch (error) {
    if (!sameSession(generation, roomId, memberId)) return;
    accessPreviews.set(workId, { error: `Access preview could not be loaded (${error.code || error.status || "request failed"}); try again.` });
  } finally {
    button.disabled = false;
  }
  renderReturnBrief();
  document.querySelector(`[data-access-preview="${CSS.escape(workId)}"]`)?.focus();
});
document.addEventListener("click", async e => {
  const button = e.target.closest("[data-work-changes]");
  if (!button || !state) return;
  const list = document.querySelector(`[data-changes-list="${CSS.escape(button.dataset.workChanges)}"]`);
  if (!list) return;
  if (!list.hidden) { list.hidden = true; return; }
  button.disabled = true;
  try {
    const history = await client.request(client.path(`/work-changes?workItemId=${encodeURIComponent(button.dataset.workChanges)}&since=${encodeURIComponent(button.dataset.basis)}`));
    list.innerHTML = history.changes.length
      ? `<ul>${history.changes.map(change => `<li><strong>r${esc(String(change.revision))}</strong> ${esc(changeDescription(change))}${change.actorId ? ` · ${esc(memberLabel(change.actorId))}` : ""}${change.at ? ` · ${esc(new Date(change.at).toLocaleString())}` : ""}</li>`).join("")}</ul>`
      : `<p class="form-hint">No recorded changes after that revision.</p>`;
    list.hidden = false;
  } catch (error) {
    list.innerHTML = `<p class="form-hint">Changes could not be loaded; try again.</p>`;
    list.hidden = false;
  } finally {
    button.disabled = false;
  }
});
function sendWorkProposal() {
  if (!state || busy || !workDraftId) return;
  const independentVerificationRequired = $("#require-verification").checked, ownerDecisionRequired = $("#require-decision").checked;
  const data = { workItemId: workDraftId, title: $("#work-title-input").value, definitionOfDone: $("#work-done-input").value, accountableMemberId: $("#assignee-select").value, verifierMemberId: independentVerificationRequired ? $("#verifier-select").value : null, independentVerificationRequired, ownerDecisionRequired, humanDecisionMakerId: ownerDecisionRequired ? state.room.ownerId : null, mode: $("#work-mode-select").value, sourceMessageId: $("#source-message-id").value || null };
  if (!workRetryLocked) pendingWork = draftCommand(pendingWork, T.WORK_PROPOSED, data);
  const entry = pendingWork;
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  submit($("#new-work-form"), async current => {
    try {
      const receipt = await client.send(entry.command);
      if (!current() || !sameSession(generation, roomId, memberId)) return;
      if (!confirmsWorkProposal(receipt, entry.command, roomId, memberId)) throw new Error("The creation receipt could not be confirmed");
    } catch (error) {
      if (!current() || !sameSession(generation, roomId, memberId)) return;
      setWorkRetry(retryUnconfirmed(error, workRetryLocked));
      throw error;
    }
    setWorkRetry(false);
    closeWorkForm(); selectWorkView("work"); notice("Work proposed. The accountable member must accept it; no external action was authorized.");
  }, { failureHint: "Your work proposal was kept; try again." });
}
const field = (name, label, type = "text") => `<label>${esc(label)}<input name="${name}" type="${type}" required maxlength="2000"></label>`;
const area = (name, label) => `<label>${esc(label)}<textarea name="${name}" required rows="3" maxlength="4000"></textarea></label>`;
function producerField() {
  const members = Object.values(state.members).sort((a, b) => a.displayName.localeCompare(b.displayName));
  const self = members.find(member => member.id === session.member.id);
  const selfOption = self ? `<option value="${esc(self.id)}">I produced this — ${esc(memberLabel(self.id))}</option>` : "";
  const otherOptions = members.filter(member => member.id !== session.member.id).map(member => `<option value="${esc(member.id)}">${esc(memberLabel(member.id))} · ${esc(kindLabel(member.kind))}${member.active === false ? " · access revoked" : ""}</option>`).join("");
  return `<label>Produced by<select name="producerId" required aria-describedby="producer-attribution-help"><option value="">Choose producer</option>${selfOption}<option value="__external__">Outside person or AI</option><option value="__unknown__">Unknown / not reported</option>${otherOptions}</select></label><label id="external-producer-field" hidden>Credit<input name="externalProducer" maxlength="160" disabled autocomplete="off" placeholder="Person, team or AI"></label><p id="producer-attribution-help" class="form-hint">You submit this result. Credit its producer, or choose Unknown.</p>`;
}
const actionSpecs = {
  "offer-help": [T.HELP_OFFER_OPENED, "Offer help", ""],
  ...Object.fromEntries(Object.keys(offerStatuses).map(action => [action, [T.HELP_OFFER_UPDATED, offerLabels[action], ""]])),
  help: [T.WORK_HELP_UPDATED, "Ask for help", ""],
  "end-help": [T.WORK_HELP_UPDATED, "End this help request?", "<p>People and agents will no longer find this request. This does not stop work already underway.</p>"],
  accept: [T.WORK_ACCEPTED, "Accept this work?", "<p>Accept responsibility for the stated outcome. This does not run any tools.</p>"],
  start: [T.WORK_STARTED, "Record work starting", "<p>Record that you are starting this outcome. A record is not proof of external execution.</p>"],
  block: [T.WORK_BLOCKED, "Report a blocker", area("reason", "What is blocked?") + area("nextAction", "What is needed next?")],
  resolve: [T.WORK_BLOCKER_RESOLVED, "Resolve the blocker", area("resolution", "What changed or which direction did you accept?")],
  complete: [T.WORK_COMPLETED, "Post actual evidence", area("summary", "What did you complete?") + field("evidenceUrl", "Evidence URL (HTTPS, display only)", "url") + field("evidenceVersion", "Exact commit or artifact version (display only)") + area("nextAction", "Next handoff") + area("signedEvidence", "Signed evidence JSON (room-signed-evidence/1 — required; paste the object your agent identity key signed)")],
  claim: [T.CLAIM_ACQUIRED, "Record authorized write scope", field("repository", "Repository (owner/name)") + field("ref", "Branch or exact revision") + area("paths", "Paths or folder/**, one per line") + field("expiresAt", "Expiry (ISO timestamp, with timezone)") + "<p>Reserves matching scope in this room. External permission is separate.</p>"],
  release: [T.CLAIM_RELEASED, "Release this scope?", "<p>Other work can reserve it next. This does not stop an outside agent or change the work's result. Confirm any outside activity separately.</p>"],
  renew: [T.CLAIM_RENEWED, "Renew this scope", field("expiresAt", "New expiry (ISO timestamp, with timezone)") + field("progressMessageId", "Progress message id (optional evidence)") + "<p>Extends the reservation. A heartbeat is enough. If you cite a message, it must be a public message you posted after the current lease started.</p>"],
  verify: [T.VERIFICATION_RECORDED, "Record an evidence check", '<label>Result<select name="result" required><option value="">Choose after checking</option><option value="pass">Pass</option><option value="fail">Finding / fail</option></select></label>' + area("summary", "What did you check at this exact version?")],
  decide: [T.OWNER_DECISION_RECORDED, "Record your decision", '<label>Decision<select name="decision" required><option value="">Choose</option><option value="approved">Approve</option><option value="changes_requested">Request changes</option><option value="rejected">Reject</option></select></label>' + area("reason", "Reason") + field("sourceMessageId", "Source message id — post your rationale in the room first, then paste its message id") + "<p>Approval does not merge, deploy, or spend money.</p>" ]
};
let resultView = null;
// Work and results now live in the single timeline (work) and the settings
// dialog (results); the old Work/Results tab toggle is gone. selectWorkView
// stays as a seam for callers: "results" opens Settings at Results.
// Overview is a read-only projection of the authorized room snapshot. Keep
// discussion and work canonical: each entry opens the existing source surface.
function renderRoomOverview() {
  if (!state || !$("#room-overview-dialog").open) return;
  setText("#room-overview-title", `${state.room.title} · Overview`);
  const orientation = roomOrientation(state);
  setText("#room-overview-purpose", orientation.purpose || "No purpose recorded yet.");
  const link = (kind, id, title, key) => `<a href="${esc(recordHref(kind, id))}" data-open-${kind}="${esc(id)}" data-focus-key="overview:${esc(key)}">${esc(title)}</a>`;
  const steps = contributionSteps(state, session.member.id).slice(0, 3);
  const decisions = orientation.recentDecisions;
  const results = completedResults(state).slice(0, 3);
  const section = (heading, rows, empty) => `<section><h3>${heading}</h3><ul>${rows.join("") || `<li class="form-hint">${empty}</li>`}</ul></section>`;
  renderContent("#room-overview-content",
    (orientation.purposeSource.kind === "instructions" ? `<p class="form-hint">Room instructions · version ${orientation.purposeSource.revision} · ${esc(time(orientation.purposeSource.updatedAt))}</p>` : "")
    + section("Next for you", steps.map(step => `<li>${link(step.kind === "request" ? "message" : "work", step.id, step.title, step.key)}<p class="form-hint">${esc(step.label)}</p></li>`), "Nothing needs your attention right now.")
    + section(`Active work · ${orientation.activeWork.length} of ${orientation.activeWorkTotal}`, orientation.activeWork.map(item => `<li>${link("work", item.id, item.title, `active:${item.id}`)}<p class="form-hint">${esc(item.state)} · ${esc(time(item.updatedAt))}</p></li>`), "No active work yet. Start with a conversation.")
    + section("Recent decisions", decisions.map(e => `<li><p>${esc(e.statement)}</p>${link("message", e.sourceMessageId, "Open discussion", e.eventId)}<p class="form-hint">${esc(memberLabel(e.authorId))} · ${esc(time(e.at))}</p></li>`), "No decisions recorded yet.")
    + section("Recent results", results.map(item => `<li>${link("work", item.id, item.title, `result:${item.id}`)}<p>${esc(item.receipt.summary)}</p><p class="form-hint">${currentResult(item).status === "approved" ? "Approved" : "Completed"} · ${esc(time(item.updatedAt))}</p></li>`), "No completed results yet."));
}
$("#room-overview-open").addEventListener("click", () => {
  if (!state || busy) return;
  $("#room-overview-dialog").showModal();
  renderRoomOverview();
});
$("#room-overview-close").addEventListener("click", () => {
  $("#room-overview-dialog").close();
  $("#room-overview-open").focus({ preventScroll: true });
});
$("#room-overview-dialog").addEventListener("click", event => {
  // Close before the existing source-link handler moves focus to the timeline.
  if (!busy && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey
    && event.target.closest("[data-open-work], [data-open-message]")) {
    $("#room-overview-dialog").close();
    $("#main").classList.remove("sidebar-open");
    $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  }
});
function openSettings(panelId) {
  const dialog = $("#settings-dialog");
  if (!dialog) return;
  dialog.classList.toggle("results-only", panelId === "results-panel");
  $("#settings-title").textContent = panelId === "results-panel" ? "Results" : "Settings";
  if (!dialog.open) dialog.showModal();
  if (panelId) {
    const panel = document.getElementById(panelId);
    if (panel) {
      for (let ancestor = panel.parentElement; ancestor && ancestor !== dialog; ancestor = ancestor.parentElement) {
        if (ancestor.tagName === "DETAILS") ancestor.open = true;
      }
      panel.open = true; (panelId === "results-panel" ? $("#room-results-list") : panel.querySelector("summary"))?.focus({ preventScroll: true }); }
  }
  renderRecordPanel();
}
function openCatchUp() {
  const dialog = $("#catchup-dialog");
  if (!dialog) return;
  if (!dialog.open) dialog.showModal();
  $("#return-brief-panel").open = true;
  $("#return-brief-panel > summary").focus({ preventScroll: true });
  loadReturnBrief();
}
function selectWorkView(view) {
  if (view === "results") openSettings("results-panel");
}
function resultRow(item) {
  const result = currentResult(item), title = esc(item.title);
  const open = result.kind === "room_text"
    ? `<button type="button" data-read-result="${esc(item.id)}" data-focus-key="result:${esc(item.id)}">${title}</button>`
    : `<a href="${safeUrl(item.receipt.evidenceUrl)}" target="_blank" rel="noreferrer noopener" data-focus-key="result:${esc(item.id)}">${title} ↗</a>`;
  return `<article class="result-row" data-result-work-id="${esc(item.id)}">${open}<p>${esc([...item.receipt.summary].slice(0, 200).join(""))}${[...item.receipt.summary].length > 200 ? "…" : ""}</p><div class="result-meta"><span>${result.status === "approved" ? "Approved" : "Completed"}${result.kind === "external" ? " · External evidence" : ""}</span><button type="button" class="text-button" data-result-work="${esc(item.id)}">Work details</button></div></article>`;
}
// Both reading and reviewing compare the same pinned completion versions.
// Each caller owns its dialog/session lifetime; late reads cannot fill a new view.
function clearResultComparison(box) {
  box.hidden = true; box.replaceChildren();
}
function loadResultComparison(workItemId, previousId, text, box, owns) {
  clearResultComparison(box);
  if (!previousId) return;
  client.workResult(workItemId, { completionEventId: previousId }).then(previous => {
    if (!owns() || !previous) return;
    if (previous.result?.receipt?.eventId !== previousId) throw new Error("Pinned previous version changed");
    const before = previous.result?.text?.body;
    if (previous.result?.text?.withdrawnAt || text.withdrawnAt) {
      box.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> ${
        previous.result?.text?.withdrawnAt ? "The previous version's text has been withdrawn, so the two cannot be compared."
          : "This version's text has been withdrawn, so the two cannot be compared."
      } Previous approval never carries over.</p>`;
      box.hidden = false;
      return;
    }
    if (typeof before !== "string") throw new Error("Previous version has no exact text");
    const rows = diffResultLines(before, text.body);
    const note = "Previous approval never carries over; review the exact new text.";
    box.innerHTML = rows === null
      ? `<p class="form-hint"><strong>Resubmitted result.</strong> The previous version differs but is too large to compare line by line. ${esc(note)}</p>`
      : (() => { const summary = diffResultSummary(rows);
          const body = rows.length > 200 ? rows.slice(0, 200) : rows;
          return `<p class="form-hint"><strong>Resubmitted result.</strong> ${summary.removedLines} lines removed, ${summary.addedLines} added (${summary.changedBytes} changed bytes). ${esc(note)}</p>` +
            (summary.changedBytes ? `<pre class="result-diff">${body.map(row => `<span class="diff-${row.type}">${esc(row.type === "added" ? "+ " : row.type === "removed" ? "- " : "  ")}${esc(row.text)}</span>`).join("\n")}${rows.length > 200 ? `<span class="form-hint">… ${rows.length - 200} more rows</span>` : ""}</pre>` : `<p class="form-hint">No text changes from the previous version.</p>`);
        })();
    box.hidden = false;
  }).catch(() => {
    if (!owns()) return;
    box.innerHTML = `<p class="form-hint"><strong>Resubmitted result.</strong> The earlier version could not be loaded for comparison. Previous approval never carries over; review the exact new text.</p>`;
    box.hidden = false;
  });
}
function resultStatus() {
  const view = resultView;
  if (!view || !sameSession(view.generation, view.roomId, view.memberId)) return;
  const item = state.workItems[view.workItemId];
  const earlier = !matchesReceipt(view.receipt, item?.receipt) || item?.state !== S.COMPLETED || Boolean(item?.supersededBy);
  $("#result-status").textContent = (earlier ? "Earlier result · " : "") + (view.error ? "Exact text unavailable. Retry this result or close."
    : view.withdrawn ? `Text withdrawn by ${memberLabel(view.withdrawn.by)} · reported by ${memberLabel(view.reportedById)}`
    : view.loaded ? `Submitted by ${memberLabel(view.reportedById)} · exact stored text` : "Loading exact text…");
  const retry = $("#result-retry");
  retry.hidden = !view.error && !view.retrying;
  retry.disabled = !view.error;
}
function closeResult(restore = true) {
  const view = resultView;
  resultView = null; $("#result-dialog").close(); $("#result-title").textContent = "Result";
  $("#result-status").textContent = ""; $("#result-body").textContent = ""; $("#result-body").hidden = false;
  $("#result-original").hidden = true; $("#result-retry").hidden = true; $("#result-retry").disabled = true;
  clearResultComparison($("#result-diff"));
  if (restore && view && sameSession(view.generation, view.roomId, view.memberId)) {
    if (view.fromResults) {
      const row = [...$("#room-results-list").querySelectorAll("[data-result-work-id]")].find(node => node.dataset.resultWorkId === view.workItemId);
      (row?.querySelector("[data-read-result]") || ($("#settings-dialog").classList.contains("results-only") ? $("#room-results-list") : $("#results-panel > summary"))).focus({ preventScroll: true });
      return;
    }
    const card = workRecord(view.workItemId); focusRecord(card?.querySelector("[data-read-result]") || card);
  }
}
$("#close-result").addEventListener("click", () => closeResult());
$("#result-original").addEventListener("click", () => {
  const view = resultView;
  if (!view?.loaded || busy || !sameSession(view.generation, view.roomId, view.memberId)
    || !state.messages.some(message => message.id === view.originalId && message.workItemId === view.workItemId)) return;
  closeResult(false);
  history.replaceState(null, "", recordHref("message", view.originalId)); revealMessage(view.originalId);
});
$("#result-dialog").addEventListener("cancel", event => { event.preventDefault(); closeResult(); });
function loadExactResult(view) {
  const owns = () => resultView === view && sameSession(view.generation, view.roomId, view.memberId);
  client.workResult(view.workItemId, { completionEventId: view.receipt.completionEventId }).then(value => {
    if (!owns() || !value) return;
    if (value.result.receipt?.evidenceVersion !== view.receipt.evidenceVersion) throw new Error("Pinned version changed");
    // Text taken out of the room is served as an absence, so say so rather
    // than showing an empty box: the result was still reported and verified,
    // and the receipt still names what it was verified against.
    view.withdrawn = value.result.text.withdrawnAt ? { by: value.result.text.withdrawnBy, at: value.result.text.withdrawnAt } : null;
    $("#result-body").textContent = view.withdrawn ? "" : value.result.text.body;
    $("#result-body").hidden = Boolean(view.withdrawn);
    const message = state.messages.find(message => message.id === value.result.text.messageId && message.workItemId === view.workItemId
      && message.body === value.result.text.body);
    const original = state.messages.find(original => original.id === message?.replyToId && original.workItemId === view.workItemId && original.proposal);
    view.originalId = original?.id; $("#result-original").hidden = !original;
    view.loaded = true; view.retrying = false;
    if (document.activeElement === $("#result-retry")) $("#close-result").focus({ preventScroll: true });
    resultStatus();
    loadResultComparison(view.workItemId, view.previousCompletionEventId, value.result.text, $("#result-diff"), owns);
  }).catch(() => { if (owns()) { view.error = true; view.retrying = false; resultStatus(); } });
}
$("#result-retry").addEventListener("click", () => {
  const view = resultView;
  if (!view?.error || busy || !sameSession(view.generation, view.roomId, view.memberId)) return;
  if (document.activeElement === $("#result-retry")) $("#close-result").focus({ preventScroll: true });
  view.error = false; view.retrying = true; resultStatus();
  loadExactResult(view);
});
function readResult(e) {
  const read = e.target.closest("[data-read-result]");
  if (read && state && !busy) {
    const item = state.workItems[read.dataset.readResult], receipt = item?.receipt;
    if (!receipt?.nativeText) return;
    const fromResults = Boolean(read.closest("#room-results-list"));
    if (fromResults && !currentResult(item)) return;
    const view = { generation: client.generation, roomId: session.roomId, memberId: session.member.id, workItemId: item.id,
      fromResults, previousCompletionEventId: receipt.nativeText.previousCompletionEventId, receipt: { completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion }, reportedById: receipt.reportedById }; resultView = view;
    $("#result-title").textContent = item.title; $("#result-status").textContent = "Loading exact text…"; $("#result-body").textContent = ""; $("#result-body").hidden = false;
    $("#result-original").hidden = true;
    const diffBox = $("#result-diff"); diffBox.hidden = true; diffBox.innerHTML = "";
    $("#result-retry").hidden = true; $("#result-retry").disabled = true;
    $("#result-dialog").showModal();
    loadExactResult(view);
    return;
  }
  const button = e.target.closest("[data-action]"); if (!button || busy) return;
  openWorkAction(state.workItems[button.dataset.workId], button.dataset.action, null, button.dataset.offerId);
}
$("#message-list").addEventListener("click", readResult);
$("#room-results-list").addEventListener("click", e => {
  readResult(e);
  const work = e.target.closest("[data-result-work]");
  if (work) revealWork(work.dataset.resultWork);
});
function openWorkAction(item, action, draftMessageId = null, offerId = null) {
  if (pendingAction?.uncertain) { resumeAction(); return; }
  if (!item || !Object.hasOwn(actionSpecs, action)) return;
  if (action === "complete" && !draftMessageId && humanExperience.shareResult(item)) return;
  const [type, , fields] = actionSpecs[action];
  actionEpoch++;
  const publishRationale = action === "decide" && document.body.classList.contains("human-experience") && !document.body.classList.contains("human-advanced");
  pendingAction = { type, action, workId: item.id, revision: item.revision, draftMessageId, publishRationale, receipt: item.receipt ? { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion } : null, retry: null, uncertain: false, error: "" };
  if (isHelpAction(action)) {
    pendingAction.helpRevision = item.helpWanted?.revision ?? 0;
    pendingAction.accountableRevision = state.members[item.accountableMemberId]?.revision;
  }
  if (isOfferAction(action)) pinOffer(pendingAction, item, offerId);
  $("#action-fields").innerHTML = action === "complete" ? producerField() + (draftMessageId ? area("summary", "Summary") + area("nextAction", "Next step") : fields) : fields;
  if (pendingAction.publishRationale) {
    $("#action-fields [name=sourceMessageId]").closest("label").remove();
    $("#action-fields").insertAdjacentHTML("beforeend", uiText("human.decisionRationaleNotice"));
  }
  if (action === "help") {
    const keep = item.helpWanted?.status === "open" && Date.parse(item.helpWanted.expiresAt) > Date.now();
    $("#action-fields").innerHTML = '<label>What would help?<textarea name="scope" required rows="3" maxlength="600"></textarea></label><label>Available for<select name="duration" required>'
      + (keep ? '<option value="keep">Keep current end time</option>' : "")
      + '<option value="3600000">1 hour</option><option value="86400000"' + (keep ? "" : " selected") + '>1 day</option><option value="604800000">7 days</option></select></label><p class="form-hint">Visible to this room. You stay accountable; no work starts automatically.</p><p id="help-current" class="form-hint" hidden></p>';
    $("#action-fields [name=scope]").value = item.helpWanted?.scope ?? "";
    pendingAction.helpExpiresAt = keep ? item.helpWanted.expiresAt : null;
  }
  if (action === "end-help") $("#action-fields").insertAdjacentHTML("afterbegin", '<p id="help-current" class="definition"></p>');
  if (isOfferAction(action)) {
    $("#action-fields").innerHTML = '<p id="offer-current" class="definition"></p>'
      + (action === "offer-help" ? '<label>How can you help?<textarea name="plan" required rows="3" maxlength="600"></textarea></label>'
        : '<p id="offer-plan" class="definition"></p><label>Note<textarea name="reason" required rows="2" maxlength="600"></textarea></label>')
      + (action === "release-offer" ? '<label class="checkbox-label"><input name="externalActivityUnverified" type="checkbox" required> Outside work may still be running.</label>'
        : '<p class="form-hint">Coordination only. No work starts or permissions change.</p>');
  }
  renderActionContext(item, action);
  $("#action-dialog").showModal();
  syncActionForm();
}
// Only opening or explicitly reviewing current work changes the pinned context.
// A background update must never silently retarget a review or approval.
function renderActionContext(item, action) {
  if (action === "end-help") currentHelp().textContent = item.helpWanted?.scope ?? "";
  if (isOfferAction(action)) {
    offerField("current").textContent = item.helpWanted?.scope ?? "";
    const offer = state.helpOffers?.[pendingAction.offerId];
    if (offerField("plan")) offerField("plan").textContent = offer ? `${memberLabel(offer.offererId)} · ${offer.plan}` : "Offer unavailable";
  }
  $("#review-brief").hidden = !["verify", "decide"].includes(action);
  setText("#review-criteria", $("#review-brief").hidden ? "" : item.definitionOfDone);
  setText("#review-summary", $("#review-brief").hidden ? "" : item.receipt?.summary ?? "");
  setText("#review-next", $("#review-brief").hidden ? "" : item.receipt?.nextAction ?? "");
  $("#review-notes").open = false;
  const review = action === "decide" && matchesReceipt(item.verification, item.receipt) ? item.verification : null;
  $("#decision-review").hidden = !review; $("#decision-review").open = false;
  setText("#decision-review-label", review ? `${review.independenceConfirmed ? "Independent check" : "Evidence check"} · ${review.result === "pass" ? "Pass" : "Finding"}` : "");
  setText("#decision-review-by", review ? memberLabel(review.verifierId) : "");
  setText("#decision-review-text", review?.summary ?? "");
  setText("#decision-review-version", review ? `Evidence ${review.evidenceVersion}` : "");
  $("#action-title").textContent = action === "block" && item.state === S.COMPLETED ? "Reopen for rework"
    : action === "verify" && item.independentVerificationRequired && hasIndependentProducer(item) ? "Record an independent check" : actionSpecs[action][1];
  $("#action-context").textContent = isOfferAction(action) ? item.title : `${item.title} · revision ${item.revision}${item.receipt ? item.receipt.nativeText ? " · stored text" : ` · evidence ${item.receipt.evidenceVersion}` : ""}`;
  const evidence = $("#action-evidence");
  let evidenceUrl = null;
  try {
    const url = new URL(item.receipt?.evidenceUrl);
    if (url.protocol === "https:" && !url.username && !url.password) evidenceUrl = url.href;
  } catch { /* Historical or malformed evidence stays non-interactive. */ }
  evidence.hidden = !(["verify", "decide"].includes(action) && evidenceUrl);
  if (evidence.hidden) evidence.removeAttribute("href");
  else evidence.setAttribute("href", evidenceUrl);
  $("#action-fields").querySelector("#verification-boundary")?.remove();
  const unknown = action === "verify" && item.independentVerificationRequired && !hasReportedProducer(item);
  if (unknown) $("#action-fields").insertAdjacentHTML("afterbegin", `<p id="verification-boundary" class="form-hint"><strong>${item.receipt.producerAttribution === "external-reported" ? "Outside credit is reported, not verified." : "Producer identity is unknown."}</strong> This check cannot satisfy independent verification or unlock approval.</p>`);
  $("#action-dialog").setAttribute("aria-describedby", unknown ? "action-context verification-boundary" : "action-context");
  const result = $("#action-fields select[name='result']");
  if (unknown) result?.setAttribute("aria-describedby", "verification-boundary");
  else result?.removeAttribute("aria-describedby");
  loadActionText(item, action);
}
function loadActionText(item, action) {
  const entry = pendingAction, epoch = actionEpoch, generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const request = (entry.textRequest ?? 0) + 1; entry.textRequest = request;
  entry.text = null; entry.textRequired = Boolean(entry.draftMessageId || ["verify", "decide"].includes(action) && item.receipt?.nativeText);
  $("#action-text").hidden = !entry.textRequired; $("#action-text-body").textContent = ""; $("#action-text-origin").textContent = "";
  clearResultComparison($("#action-result-diff"));
  if (!entry.textRequired) return;
  $("#action-text-origin").textContent = "Loading exact text…";
  if (entry.draftMessageId) $("#action-title").textContent = "Save as result";
  const owns = () => pendingAction === entry && actionEpoch === epoch && entry.textRequest === request && sameSession(generation, roomId, memberId);
  client.workResult(item.id, entry.draftMessageId ? { draftMessageId: entry.draftMessageId } : { completionEventId: entry.receipt.completionEventId }).then(value => {
    if (!owns() || !value) return;
    if (!entry.draftMessageId && (value.result.receipt?.eventId !== entry.receipt.completionEventId || value.result.receipt?.evidenceVersion !== entry.receipt.evidenceVersion)) throw new Error("Pinned evidence changed");
    entry.text = value.result.text;
    if (!entry.draftMessageId) loadResultComparison(item.id, item.receipt.nativeText.previousCompletionEventId, entry.text, $("#action-result-diff"), owns);
    $("#action-text-body").textContent = entry.text.body;
    const proposal = entry.text.proposal;
    $("#action-text-origin").textContent = `Posted by ${memberLabel(entry.text.postedById)}${proposal ? ` · draft based on revision ${proposal.basisRevision} · authorship unverified` : ""}`;
    if (value.current.workRevision !== entry.revision) { entry.needsReview = true; entry.error = "Work changed. Review current work before saving."; }
    syncActionForm();
    // NR-B: the exact text lands asynchronously and can push the focused
    // control below the dialog's visible edge after the browser's focus
    // scroll already ran. Re-assert the focused control fully into view.
    if ($("#action-dialog").open) {
      const focused = document.activeElement;
      if (focused && focused !== document.body && $("#action-dialog").contains(focused)) {
        focused.scrollIntoView({ block: "nearest" });
      }
    }
  }).catch(() => {
    if (!owns()) return;
    entry.needsReview = true; entry.error = "Exact text unavailable. Review current work to try again.";
    $("#action-text-origin").textContent = "Text unavailable"; syncActionForm();
  });
}
function actionAvailable(entry) {
  const item = state?.workItems[entry.workId];
  if (item && isOfferAction(entry.action)) {
    if (entry.action === "offer-help") return offersView(item)?.availability.canOffer === true;
    const key = { "select-offer": "canSelect", "decline-offer": "canDecline", "withdraw-offer": "canWithdraw", "release-offer": "canRelease" }[entry.action];
    return offerChoice(entry)?.[key] === true;
  }
  if (item && isHelpAction(entry.action)) {
    const help = helpView(item);
    return entry.action === "help" ? help?.canPublish === true : help?.canWithdraw === true;
  }
  return Boolean(item && workActions(item, state.members[session.member.id]).some(([action]) => action === entry.action));
}
function actionChanged(entry) {
  const item = state?.workItems[entry.workId];
  if (isOfferAction(entry.action)) return item?.revision !== entry.revision
    || (item?.helpWanted?.revision ?? 0) !== entry.helpRevision || (item?.helpWanted?.eventId ?? null) !== entry.helpEventId
    || (state?.helpOffers?.[entry.offerId]?.revision ?? null) !== entry.offerRevision
    || state?.members[session.member.id]?.revision !== entry.viewerRevision
    || (state?.members[state?.helpOffers?.[entry.offerId]?.offererId]?.revision ?? null) !== entry.offererRevision;
  return item?.revision !== entry.revision || isHelpAction(entry.action) && (
    (item?.helpWanted?.revision ?? 0) !== entry.helpRevision
    || state?.members[item?.accountableMemberId]?.revision !== entry.accountableRevision);
}
function syncActionForm() {
  $("#resume-action").hidden = !pendingAction?.uncertain;
  if (!pendingAction || !state || busy) return;
  const entry = pendingAction, changed = actionChanged(entry);
  const available = actionAvailable(entry), save = $("#action-form button[type='submit']");
  for (const field of $("#action-fields").querySelectorAll("input,textarea,select")) field.disabled = entry.uncertain;
  if (entry.action === "complete") {
    const external = $("#action-fields [name=producerId]").value === "__external__", input = $("#action-fields [name=externalProducer]");
    $("#action-fields").querySelector("#external-producer-field").hidden = !external; input.required = external; input.disabled = entry.uncertain || !external;
    $("#action-fields").querySelector("#producer-attribution-help").textContent = external ? "Reported credit only. No access or verified identity."
      : "You submit this result. Credit its producer, or choose Unknown.";
  }
  save.textContent = entry.uncertain ? "Retry original save" : offerLabels[entry.action] ?? (entry.action === "help" ? "Publish request" : entry.action === "end-help" ? "End request" : "Save record");
  save.disabled = !entry.uncertain && (changed || entry.needsReview || !available || entry.textRequired && !entry.text);
  $("#cancel-action").textContent = entry.uncertain ? "Close" : "Cancel";
  $("#refresh-action").hidden = entry.uncertain || !(changed || entry.needsReview || !available);
  $("#refresh-action").disabled = false;
  const text = entry.uncertain ? "Save not confirmed. Retry the original before making changes."
    : !available ? "This action is no longer available. Your entries are kept."
      : changed || entry.needsReview ? entry.error || "Work changed. Review current work before saving." : entry.error;
  setFormStatus($("#action-error"), text, Boolean(text));
}
function resumeAction() {
  if (!pendingAction || busy) return;
  actionEpoch++;
  if (!$("#action-dialog").open) $("#action-dialog").showModal();
  syncActionForm(); $("#action-form button[type='submit']").focus();
}
$("#resume-action").addEventListener("click", resumeAction);
$("#action-fields").addEventListener("change", event => { if (event.target.name === "producerId") syncActionForm(); });
$("#refresh-action").addEventListener("click", () => {
  const entry = pendingAction;
  if (!entry || !state || busy || entry.uncertain) return;
  const epoch = actionEpoch, generation = client.generation, roomId = session.roomId, memberId = session.member.id;
  const owns = () => pendingAction === entry && actionEpoch === epoch && sameSession(generation, roomId, memberId);
  submit($("#action-form"), async current => {
    try { await client.refresh(); }
    catch (error) {
      if (current() && owns()) {
        client.handleFailure(error);
        if (owns()) { clearNotice(); entry.error = "Could not load current work. Try again."; entry.needsReview = true; }
      }
      return;
    }
    if (!current() || !owns()) return;
    const item = state.workItems[entry.workId];
    if (!actionAvailable(entry)) return;
    const receipt = item.receipt ? { completionEventId: item.receipt.eventId, evidenceVersion: item.receipt.evidenceVersion } : null;
    const changedResult = JSON.stringify(receipt) !== JSON.stringify(entry.receipt);
    const changedHelp = isHelpAction(entry.action) && actionChanged(entry);
    entry.revision = item.revision; entry.receipt = receipt; entry.retry = null; entry.needsReview = false;
    entry.error = changedResult ? "Result changed. Notes kept; inspect this version and choose again." : "";
    if (isOfferAction(entry.action)) {
      pinOffer(entry, item);
      entry.error = "Current request loaded. Review it alongside your note before saving.";
      const acknowledgement = $("#action-fields [name=externalActivityUnverified]");
      if (acknowledgement) acknowledgement.checked = false;
    }
    if (isHelpAction(entry.action)) {
      entry.helpRevision = item.helpWanted?.revision ?? 0;
      entry.accountableRevision = state.members[item.accountableMemberId]?.revision;
      if (changedHelp && entry.action === "help") {
        entry.error = "Request changed. Your draft is kept; compare it with the latest request.";
        currentHelp().hidden = false;
        currentHelp().textContent = item.helpWanted ? `Latest: ${item.helpWanted.scope} · ${helpView(item).status} · ends ${new Date(item.helpWanted.expiresAt).toLocaleString()}` : "No current request.";
        const keep = $("#action-fields option[value=keep]");
        if (keep) { keep.disabled = true; $("#action-fields [name=duration]").value = ""; }
        entry.helpExpiresAt = null;
      }
    }
    entry.decisionDispatched = false;
    if (changedResult) entry.rationale = null;
    if (changedResult) for (const field of $("#action-fields").querySelectorAll("select[name='result'],select[name='decision']")) field.value = "";
    renderActionContext(item, entry.action);
  }).then(() => {
    if (owns() && $("#action-dialog").open && document.activeElement === document.body) $("#action-fields input:not([disabled]),#action-fields textarea:not([disabled]),#action-fields select:not([disabled]),#cancel-action")?.focus();
  });
});
function restoreActionFocus(entry) {
  if (!entry) return;
  const generation = client.generation, roomId = session?.roomId, memberId = session?.member?.id, epoch = actionEpoch;
  setTimeout(() => {
    if (!state || epoch !== actionEpoch || !sameSession(generation, roomId, memberId)) return;
    const card = workRecord(entry.workId);
    const key = `work-action:${entry.workId}:${entry.action}${isOfferAction(entry.action) && entry.action !== "offer-help" ? ":" + entry.offerId : ""}`;
    const action = card ? [...card.querySelectorAll("[data-focus-key]")].find(node => node.dataset.focusKey === key) : null;
    focusRecord(action || card);
  }, 0);
}
function closeActionDialog({ returnFocus = true, confirmed = false } = {}) {
  const entry = pendingAction;
  if (busy && !confirmed) return;
  actionEpoch++;
  if ($("#action-dialog").open) $("#action-dialog").close();
  if (confirmed || !entry?.uncertain) pendingAction = null;
  if (!pendingAction) clearResultComparison($("#action-result-diff"));
  $("#resume-action").hidden = !pendingAction?.uncertain;
  if (returnFocus) restoreActionFocus(entry);
}
$("#cancel-action").addEventListener("click", () => closeActionDialog());
$("#action-dialog").addEventListener("cancel", e => {
  e.preventDefault();
  if (!busy) closeActionDialog();
});
$("#action-form").addEventListener("submit", e => {
  e.preventDefault(); if (!pendingAction || !state || busy) return;
  const entry = pendingAction, fields = Object.fromEntries(new FormData(e.currentTarget));
  const generation = client.generation, roomId = session.roomId, memberId = session.member.id, epoch = actionEpoch, focus = document.activeElement;
  if (!entry.uncertain && (entry.needsReview || entry.textRequired && !entry.text || actionChanged(entry) || !actionAvailable(entry))) { syncActionForm(); return; }
  if (!entry.uncertain) {
    const data = { workItemId: entry.workId, expectedRevision: entry.revision, ...fields };
    if (isOfferAction(entry.action)) {
      data.offerId = entry.offerId;
      if (entry.action === "offer-help" || entry.action === "select-offer") Object.assign(data, { expectedHelpRevision: entry.helpRevision, helpEventId: entry.helpEventId });
      if (entry.action !== "offer-help") Object.assign(data, { expectedOfferRevision: entry.offerRevision, status: offerStatuses[entry.action] });
      if (entry.action === "release-offer") data.externalActivityUnverified = fields.externalActivityUnverified === "on";
      try { validateHelpOfferData(entry.type, data); } catch { entry.error = "Add a short note and review the required choice."; syncActionForm(); return; }
    }
    if (isHelpAction(entry.action)) {
      data.expectedHelpRevision = entry.helpRevision;
      data.status = entry.action === "help" ? "open" : "withdrawn";
      if (entry.action === "help") {
        const duration = Number(fields.duration);
        if (fields.duration !== "keep" && ![3600000, 86400000, 604800000].includes(duration)) return;
        data.expiresAt = fields.duration === "keep" ? entry.helpExpiresAt : new Date(Date.now() + duration).toISOString();
        delete data.duration;
        if (Date.parse(data.expiresAt) <= Date.now()) { entry.error = "End time passed. Choose a new duration."; syncActionForm(); return; }
      }
      try { validateHelpData(data); } catch { entry.error = "Add a short scope and choose an end time."; syncActionForm(); return; }
    }
    if (entry.action === "complete") {
      data.producerId = ["__unknown__", "__external__"].includes(fields.producerId) ? null : fields.producerId;
      // Integration map slice 5: external evidence is a signed object. The
      // textarea carries its JSON text; parse it here so the command data
      // holds the object the server verifies.
      const raw = typeof fields.signedEvidence === "string" ? fields.signedEvidence.trim() : "";
      if (raw === "") delete data.signedEvidence;
      else {
        try { data.signedEvidence = JSON.parse(raw); }
        catch { entry.error = "Signed evidence must be a valid JSON object."; syncActionForm(); return; }
      }
    }
    if (entry.draftMessageId) Object.assign(data, { evidenceKind: "room_text", evidenceMessageId: entry.text.messageId,
      evidenceMessageEventId: entry.text.messageEventId, evidenceVersion: entry.text.evidenceVersion, previousCompletionEventId: entry.receipt?.completionEventId ?? null });
    if (entry.action === "claim") data.paths = fields.paths.split("\n").map(p => p.trim()).filter(Boolean);
    if (["verify", "decide"].includes(entry.action)) Object.assign(data, entry.receipt);
    if (entry.publishRationale) {
      data.reason = fields.reason.trim();
      entry.rationale = draftCommand(entry.rationale, T.MESSAGE_POSTED, { messageId: entry.rationale?.command.data.body === data.reason ? entry.rationale.command.data.messageId : crypto.randomUUID(), body: data.reason });
      data.sourceMessageId = entry.rationale.command.data.messageId;
    }
    const retry = draftCommand(entry.retry, entry.type, data);
    if (retry !== entry.retry) entry.decisionDispatched = false;
    entry.retry = retry;
  }
  submit(e.currentTarget, async current => {
    const owns = () => current() && pendingAction === entry && actionEpoch === epoch && sameSession(generation, roomId, memberId);
    try {
      if (entry.rationale && !entry.rationale.confirmed) {
        const receipt = await client.send(entry.rationale.command);
        if (!owns()) return;
        if (!await confirmsWorkAction(receipt, entry.rationale.command, roomId, memberId)) throw new Error(uiText("human.decisionReceiptUnknown"));
        if (!owns()) return;
        entry.rationale.confirmed = true;
      }
      // A rationale can settle after the result changed. Never silently rebase
      // its verdict; uncertain decision retries still reconcile the original.
      if (entry.publishRationale && !entry.decisionDispatched && actionChanged(entry)) {
        entry.uncertain = false; entry.needsReview = true; entry.error = uiText("human.decisionRationaleChanged"); return;
      }
      entry.decisionDispatched = true;
      const receipt = await client.send(entry.retry.command);
      if (!owns()) return;
      if (!await confirmsWorkAction(receipt, entry.retry.command, roomId, memberId)) throw new Error("Save receipt could not be confirmed");
      if (!owns()) return;
    } catch (error) {
      if (!owns()) return;
      clearNotice();
      entry.uncertain = retryUnconfirmed(error, entry.uncertain);
      entry.needsReview = !entry.uncertain && error.code === "command_rejected" && error.status === 409;
      entry.error = error.message; return;
    }
    closeActionDialog({ returnFocus: false, confirmed: true }); notice(isHelpAction(entry.action) ? "Help request saved." : isOfferAction(entry.action) ? "Offer updated." : "Record saved.");
    const settledEpoch = actionEpoch;
    setTimeout(() => { if (actionEpoch === settledEpoch && sameSession(generation, roomId, memberId)) revealWork(entry.workId); }, 0);
  }, { failureHint: "Your entries were kept; try again." }).then(() => {
    if (pendingAction !== entry || actionEpoch !== epoch || !sameSession(generation, roomId, memberId) || !$("#action-dialog").open
      || document.activeElement !== document.body) return;
    const target = entry.uncertain ? $("#action-form button[type='submit']")
      : focus?.isConnected && !focus.disabled ? focus : $("#refresh-action:not([hidden]),#cancel-action");
    target?.focus();
  });
});
window.addEventListener("beforeunload", e => {
  if (state) saveComposer();
  if ((state && (drafts.hasText() || portableWorkUI?.hasDraft() || resultCopyUI?.hasDraft() || remindersUI?.hasPending() || agentConnectionsUI?.hasPending() || instructionsUI?.hasPending() || ownerOffersUI?.hasPending() || !$("#new-work-form").hidden || pendingAction))
    || invitationIsCommitting() || invitation.phase === "unknown") { e.preventDefault(); e.returnValue = ""; }
});
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden" && state) saveComposer(); });
window.addEventListener("pagehide", () => {
  if (state) saveComposer();
  leavingPage = true;
  try { client.endAccess(); } finally { leavingPage = false; }
});
window.addEventListener("pageshow", e => {
  if (!e.persisted) return;
  if (accountHomeFromLocation()) { ensureAccountSession().then(showAccountWorkspace).catch(handleFailureNotice); return; }
  const roomId = selectedRoomFromLocation();
  // Same join-flow rule as the initial boot: a #room/ deep link first tries
  // the room-cookie session (no account needed), then the account flow.
  const restoreDeepLink = async () => {
    if (!roomId) return client.restore();
    try {
      const joined = await client.restore();
      if (joined?.roomId === roomId) return joined;
      client.endAccess();
    } catch (error) {
      if (![401, 403].includes(error.status)) throw error;
    }
    const account = await ensureAccountSession();
    return account?.authenticated ? client.restore(roomId) : null;
  };
  restoreDeepLink().catch(handleFailureNotice);
});
// Return brief: one compact entry before conversation. Fetch on return and
// on open; history stays fixed through the frozen horizon H, the action sections are live
// through N, and only the explicit button acknowledges - exactly H, never the latest event.
function loadReturnBrief() { return briefView.refresh(); }
// Notification feed (B4): items are derived on the server from events after your
// caught-up marker and filtered by your notification preferences. Fetching never
// acknowledges; "Mark read" moves the marker to exactly the sequence the list was
// evaluated through, so items arriving later stay unread.
let notificationOwner = null, notificationFeed = null, notificationSerial = 0, notificationBusy = false, notificationError = "", notificationTimer = null;
let humanPushUi = null;
// Saved-but-not-refreshed, shown in the feed's own status line. Kept apart from
// notificationError on purpose: it is not a failed save, and the feed reload
// that follows a mark-read clears errors and must not clear this.
let notificationNote = "", notificationBefore = null, notificationLoading = false;
// DM consent pairs for the signed-in member (PR #731).
// Refreshed on room open, when the People panel opens, and after every
// consent action. Never loaded for the public read-only face.
let dmConsents = [], dmConsentBusy = false, dmConsentSeq = 0, dmConsentRefetchQueued = false;
let friendBonds = [], friendBusy = false, friendSeq = 0, friendDmPeerId = null;
// #660: server-derived presence states per member (memberId -> presence API
// entry). Refreshed on room open and on an interval while visible; the rail
// prefers these over the local derivation. Never loaded for the public
// read-only face.
let presenceStates = new Map(), presenceRequest = null, presenceSeq = 0, presenceTimer = null, presenceAgeTimer = null;
let presenceUnrefreshed = false, presenceCheckedAt = null;
const PRESENCE_REFRESH_MS = 30000;
// Client display freshness only; this does not determine host reachability.
const PRESENCE_OBSERVATION_MAX_AGE_MS = 60000;
function presenceObservationAged() {
  if (presenceCheckedAt === null) return false;
  const age = Date.now() - presenceCheckedAt;
  return age < 0 || age >= PRESENCE_OBSERVATION_MAX_AGE_MS;
}
function ownsPresenceRequest(request) {
  return request === presenceRequest && request.seq === presenceSeq
    && request.generation === client.generation && request.room === state;
}
// New room events are coalesced: the feed refetches at most once per window while the tab is visible.
const NOTIFICATION_COALESCE_MS = 1500;
const NOTIFICATION_LABELS = { mention: "mentioned you", reply: "replied to you", assignment: "named you on work", work_update: "updated work you are on", access_request: "requested access" };
const ownsNotifications = ticket => Boolean(ticket) && notificationOwner === ticket && client.generation === ticket.generation && client.session === ticket.session && client.ownsAccountSession();
function resetNotifications() {
  notificationBefore = null; notificationLoading = false;
  $("#notification-older").hidden = true; $("#notification-newest").hidden = true;
  notificationSerial++; notificationOwner = null; notificationFeed = null; notificationBusy = false; notificationError = ""; notificationNote = "";
  clearTimeout(notificationTimer); notificationTimer = null;
  $("#notification-count").textContent = ""; $("#notification-count").hidden = true;
  $("#notification-panel").hidden = true; $("#notification-list").replaceChildren(); delete $("#notification-list")._content;
  $("#notification-status").textContent = ""; $("#notification-status").classList.remove("visible");
  $("#notification-read-button").hidden = true; $("#notification-read-button").disabled = true; $("#notification-read-button").textContent = "Mark read";
  humanPushUi?.reset();
}
function renderNotifications() {
  const owned = Boolean(state) && ownsNotifications(notificationOwner);
  const feed = owned ? notificationFeed : null, items = feed?.notifications ?? [], count = feed?.unread ?? 0;
  const badge = $("#notification-count");
  badge.textContent = count ? `${count}${feed?.nextBefore ? "+" : ""} for you` : ""; badge.hidden = !count;
  $("#notification-panel").hidden = !owned;
  const note = notificationError || notificationNote || (feed?.basis?.truncated ? "Older notifications may be available." : "");
  setText("#notification-status", note);
  $("#notification-status").classList.toggle("visible", Boolean(note));
  $("#notification-older").hidden = !owned || !feed?.nextBefore;
  $("#notification-newest").hidden = !owned || (notificationBefore === null && !feed?.pageBefore);
  $("#notification-older").disabled = notificationLoading;
  $("#notification-newest").disabled = notificationLoading;
  $("#notification-read-button").hidden = !owned || !count || Boolean(feed?.nextBefore) || Boolean(feed?.pageBefore) || notificationBefore !== null;
  $("#notification-read-button").disabled = !owned || notificationBusy || notificationLoading || !count;
  $("#notification-read-button").textContent = notificationBusy ? "Marking read…" : "Mark read";
  renderBriefList("#notification-list", items.map(item => {
    // RC-2026-09-19-071 (QAJ-006): an access_request item links to its
    // timeline event (data-open-event is handled by the delegated click
    // handler) and shows the requester's display name, since they are not
    // a room member and memberLabel would read "Unknown member".
    const target = item.messageId ? { kind: "message", id: item.messageId }
      : item.requestId ? { kind: "event", id: item.eventId }
      : { kind: "work", id: item.workItemId };
    const detail = item.messageId ? (conversation?.byId.get(item.messageId)?.body ?? "").slice(0, 80)
      : item.requestId ? (item.note ?? "").slice(0, 80)
      : (state.workItems[item.workItemId]?.title ?? item.workItemId);
    const actor = item.kind === "access_request" && item.displayName ? item.displayName : memberLabel(item.actorId);
    const label = `${actor} ${NOTIFICATION_LABELS[item.kind] ?? humanize(item.kind)}${item.changes > 1 ? ` · ${item.changes} changes` : ""}`;
    // Tag acknowledgment (2026-09-23): a pending mention carries a one-tap 👍
    // button. A bare react counts as a response, so the button sends the
    // suggested react through the normal reaction path; it sits outside the
    // row's link so tapping it never navigates to the message.
    const ack = item.kind === "mention" && item.ackState === "pending" && item.messageId
      ? `<button type="button" class="notification-ack" data-ack-message="${esc(item.messageId)}" data-ack-reaction="${esc(item.suggestedAck ?? "like")}" title="Acknowledge with a 👍 react" aria-label="Acknowledge mention with thumbs up">👍</button>`
      : "";
    return `<li class="rb-event notification-item" data-notification-kind="${esc(item.kind)}"><a class="rb-event-link" href="${esc(recordHref(target.kind, target.id))}" data-open-${target.kind}="${esc(target.id)}" data-brief-key="notification:${esc(item.kind)}:${esc(target.id)}"><span class="rb-actor">${esc(label)}</span><time datetime="${esc(item.at)}">${esc(time(item.at))}</time>${detail ? `<span class="rb-detail">${esc(detail)}</span>` : ""}</a>${ack}</li>`;
  }).join("") || (owned && feed && !notificationError ? `<li class="rb-empty">${feed.nextBefore ? 'No notifications in this part of the history.' : feed.pageBefore !== null ? 'No older notifications.' : 'Nothing new for you.'}</li>` : ""));
  humanPushUi?.refresh();
}
humanPushUi = installHumanPush({
  client,
  button: $("#human-push-button"),
  note: $("#human-push-note"),
  prefs: {
    box: $("#human-push-prefs"),
    mention: $("#human-push-pref-mention"),
    dm: $("#human-push-pref-dm")
  },
  eligible: () => Boolean(state) && ownsNotifications(notificationOwner) && client.session?.member?.kind !== "agent"
});
// Tag acknowledgment (2026-09-23): one tap on a pending mention sends the
// suggested 👍 react through the normal reaction path. Idempotent — when the
// member already reacted (stale feed), the button does nothing rather than
// toggling the react off.
function ackMention(messageId, reaction = "like") {
  const key = canonicalReaction(reaction);
  if (!messageId || !state || !key) return;
  // The notification feed can name a message the local conversation index
  // has not loaded; setReaction reads the local index to toggle, so a
  // missing message bails instead of throwing (the row's link still reaches it).
  const message = conversation?.byId.get(messageId);
  if (!message) return;
  const already = reactionPills(message.reactions).some(pill => pill.key === key && pill.memberIds.includes(session.member.id));
  if (!already) setReaction(messageId, key);
}
$("#notification-list").addEventListener("click", e => {
  const button = e.target.closest("[data-ack-message]");
  if (button && state && !busy) { e.preventDefault(); ackMention(button.dataset.ackMessage, button.dataset.ackReaction); }
});
async function loadNotifications() {
  const pagingFocus = ["notification-older", "notification-newest"].includes(document.activeElement?.id) ? document.activeElement : null;
  const ticket = notificationOwner, request = ++notificationSerial;
  if (!ownsNotifications(ticket)) return;
  try {
    notificationLoading = true; renderNotifications();
    const result = await client.notifications(notificationBefore);
    if (!ownsNotifications(ticket) || request !== notificationSerial || !result) return;
    if (notificationBefore !== null && result.cursor >= notificationBefore) { notificationBefore = null; return loadNotifications(); }
    notificationFeed = result; notificationError = "";
  } catch {
    if (!ownsNotifications(ticket) || request !== notificationSerial) return;
    notificationError = "Notifications could not refresh.";
  }
  if (request === notificationSerial) notificationLoading = false;
  renderNotifications();
  if (pagingFocus?.hidden && (document.activeElement === document.body || document.activeElement === pagingFocus)) {
    ($("#notification-newest").hidden ? $("#notification-heading") : $("#notification-newest")).focus({ preventScroll: true });
  }
}
$("#notification-older").addEventListener("click", () => {
  if (notificationLoading || !notificationFeed?.nextBefore) return;
  notificationBefore = notificationFeed.nextBefore; void loadNotifications();
});
$("#notification-newest").addEventListener("click", () => {
  if (notificationLoading) return;
  notificationBefore = null; void loadNotifications();
});
function scheduleNotifications(delay) {
  // One pending fetch at a time; an immediate request replaces a coalesced one.
  if (notificationTimer !== null && delay > 0) return;
  clearTimeout(notificationTimer);
  notificationTimer = setTimeout(() => { notificationTimer = null; void loadNotifications(); }, delay);
}
// ---- Attention: activity feed, read horizons, saved messages ------------------
// Write-time personal feed (server/activity.mjs): mentions, replies, thread
// replies, and reactions fanned out per recipient with their own read state.
// The Activity dialog pages newest-first with All/Mentions/Replies/Threads/
// Reactions filters; opening an item jumps to the message and marks it read.
let savedMessageIds = new Set(), savedIdsBusy = false;
let activityFilter = "", activityItems = [], activityBefore = null, activityHasMore = false, activityBusy = false, activitySerial = 0;
let activityBadgeTimer = null, activityBadgeAt = 0, attentionBadgesBusy = false;
let horizonAnchorId = null; // first message after the read horizon; the "New messages" divider rides on it
let horizonCache = new Map(), lastHorizonView = null; // threadKey -> lastReadMessageId
const ACTIVITY_LABELS = { mention: "mentioned you", reply: "replied to you", thread_reply: "replied in a thread you're in", reaction: "reacted to your message" };
let horizonAdvanceTimer = null;
function nearBottomOfList() {
  const list = $("#message-list");
  if (!list || !state) return false;
  if (list.scrollHeight <= list.clientHeight) return list.getBoundingClientRect().bottom <= innerHeight + 80;
  return list.scrollHeight - list.scrollTop - list.clientHeight < 80;
}
function scheduleHorizonAdvance() {
  // Debounced per the spec: the client advances the read horizon as the user
  // scrolls. Only fires while the user holds the bottom of the view, so an
  // explicit Mark unread never gets wiped without a scroll.
  clearTimeout(horizonAdvanceTimer);
  horizonAdvanceTimer = setTimeout(() => { horizonAdvanceTimer = null; void advanceHorizon(); }, 1500);
}
async function advanceHorizon() {
  if (!state || !session || !client.session || !nearBottomOfList()) return;
  const threadKey = currentThreadId ?? "";
  const messages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
  const latest = messages.length ? messages[messages.length - 1].id : null;
  if (!latest || horizonCache.get(threadKey) === latest) return;
  try {
    await client.setReadHorizon(threadKey, latest);
    if (!state) return;
    horizonCache.set(threadKey, latest);
    horizonAnchorId = null; // everything in view is read; the divider clears
    renderMessages();
  } catch { /* best-effort; the next scroll retries */ }
}
function resetAttention() {
  // Session/room teardown: drop every persisted-attention cache so the next
  // session never sees the previous member's activity, saves, or horizons.
  activitySerial++; activityFilter = ""; activityItems = []; activityBefore = null; activityHasMore = false; activityBusy = false;
  clearTimeout(activityBadgeTimer); activityBadgeTimer = null; activityBadgeAt = 0; attentionBadgesBusy = false;
  setText("#activity-count", ""); $("#activity-count").hidden = true;
  setText("#later-count", ""); $("#later-count").hidden = true;
  $("#activity-list").replaceChildren(); delete $("#activity-list")._content;
  $("#activity-older").hidden = true; setText("#activity-status", "");
  $("#later-list").replaceChildren(); delete $("#later-list")._content;
  setText("#later-status", "");
  savedMessageIds = new Set(); savedIdsBusy = false;
  horizonAnchorId = null; horizonCache = new Map(); lastHorizonView = null;
  clearTimeout(horizonAdvanceTimer); horizonAdvanceTimer = null;
  previewItems = []; previewBusy = false;
  const preview = $("#activity-preview"); if (preview) { $("#activity-preview-list")?.replaceChildren(); preview.hidden = true; }
  for (const dialog of ["#activity-dialog", "#later-dialog"]) { const node = $(dialog); if (node?.open) node.close(); }
}
function horizonAnchorFor(messages, lastRead) {
  if (lastRead === null || lastRead === undefined) return messages[0]?.id ?? null;
  const index = messages.findIndex(m => m.id === lastRead);
  if (index < 0) return null; // the horizon message is not in this view
  return messages[index + 1]?.id ?? null;
}
async function refreshSavedIds() {
  if (!state || !session || savedIdsBusy) return;
  const generation = client.generation, roomId = session.roomId;
  savedIdsBusy = true;
  try {
    const result = await client.savedList();
    // E-H3: drop stale flights — the previous room's saved ids must never
    // land in the new room's set.
    if (generation !== client.generation || session?.roomId !== roomId) return;
    if (result) savedMessageIds = new Set(result.items.map(item => item.messageId));
  } catch { /* the Save toggle reports loudly; the menu label just stays stale */ }
  finally { savedIdsBusy = false; }
}
async function syncAttentionBadges() {
  if (!state || !session || attentionBadgesBusy) return;
  const generation = client.generation, roomId = session.roomId;
  attentionBadgesBusy = true;
  try {
    const [count, saved] = await Promise.all([client.activityUnreadCount(), client.savedList()]);
    // E-H3: drop stale flights — the previous room's badge counts and saved
    // ids must never render into the new room.
    if (!state || !session || generation !== client.generation || session.roomId !== roomId) return;
    const unread = count?.total ?? 0;
    setText("#activity-count", unread ? String(unread) : "");
    $("#activity-count").hidden = !unread;
    $("#topbar-activity").setAttribute("aria-label", unread ? `Activity, ${unread} unread` : "Activity");
    const later = saved?.count ?? 0;
    setText("#later-count", later ? String(later) : "");
    $("#later-count").hidden = !later;
    if (saved) savedMessageIds = new Set(saved.items.map(item => item.messageId));
  } catch { /* badges are best-effort; the dialogs report loudly */ }
  finally { attentionBadgesBusy = false; }
  void refreshActivityPreview();
}
// Compact top-three unread preview at the needs-attention placement (below the
// room topbar). The owner ops card keeps its own data source; this is the
// personal activity view backed by activity_events.
let previewItems = [], previewBusy = false;
// Dismissed previews stay hidden for this page load; a newer unread item brings the card back.
const previewDismissed = new Set();
async function refreshActivityPreview() {
  if (!state || !session || previewBusy) return;
  const generation = client.generation, roomId = session.roomId;
  previewBusy = true;
  try {
    const result = await client.activity({ limit: 20 });
    // E-H3: drop stale flights — the previous room's message excerpts must
    // never render into the new room's preview.
    if (!state || !session || !result || generation !== client.generation || session.roomId !== roomId) return;
    previewItems = result.items.filter(item => !item.readAt && !previewDismissed.has(item.id)).slice(0, 3);
    $("#activity-preview").hidden = previewItems.length === 0;
    setText("#activity-preview-count", String(previewItems.length));
    // Glance only: the newest unread item shows; the count chip carries the rest and Open activity lists them.
    renderBriefList("#activity-preview-list", previewItems.slice(0, 1).map(item => {
      const detail = item.messageDeleted ? "Message deleted" : (item.messageBody ?? "").slice(0, 100);
      const label = `${memberLabel(item.actorId)} ${ACTIVITY_LABELS[item.type] ?? item.type}`;
      return `<li class="rb-event activity-item unread">`
        + `<a class="rb-event-link" href="${esc(recordHref("message", item.messageId))}" data-open-message="${esc(item.messageId)}" data-preview-id="${item.id}" data-brief-key="preview:${item.id}" aria-label="${esc(label)}, unread">`
        + `<span class="rb-actor">${esc(label)}</span><time datetime="${esc(String(item.createdAt))}">${esc(time(item.createdAt))}</time>`
        + (detail ? `<span class="rb-detail">${esc(detail)}</span>` : "") + `</a></li>`;
    }).join(""));
  } catch { /* the preview is best-effort; the dialog reports loudly */ }
  finally { previewBusy = false; }
}
$("#activity-preview-open").addEventListener("click", openActivity);
$("#activity-preview-dismiss").addEventListener("click", () => {
  for (const item of previewItems) previewDismissed.add(item.id);
  previewItems = []; $("#activity-preview").hidden = true; $("#activity-preview-list").replaceChildren();
});
function scheduleAttentionBadges() {
  // Throttled: snapshots fire on every room event, badges need not.
  const now = Date.now(), elapsed = now - activityBadgeAt;
  if (elapsed < 15000) {
    clearTimeout(activityBadgeTimer);
    activityBadgeTimer = setTimeout(() => { activityBadgeAt = 0; scheduleAttentionBadges(); }, 15000 - elapsed);
    return;
  }
  activityBadgeAt = now;
  void syncAttentionBadges();
}
function syncAttention() {
  if (!client.session || !client.ownsAccountSession() || !state) {
    const preview = $("#activity-preview");
    if (preview) preview.hidden = true;
    return;
  }
  scheduleAttentionBadges();
}
async function applyHorizonAnchor() {
  // Room-level horizon ("" thread) anchors the "New messages" divider on room
  // open and after mark-unread; the thread view anchors on its own horizon.
  if (!state || !session) return;
  const threadKey = currentThreadId ?? "";
  try {
    const horizon = await client.readHorizon(threadKey);
    const lastRead = horizon?.lastReadMessageId ?? null;
    horizonCache.set(threadKey, lastRead);
    const messages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
    horizonAnchorId = horizonAnchorFor(messages, lastRead);
  } catch { horizonAnchorId = null; }
  if (state) renderMessages();
}
async function markMessageUnread(messageId) {
  if (!state || !session || !conversation.byId.has(messageId)) return;
  const messages = currentThreadId ? conversation.threads.get(currentThreadId) || [] : conversation.roots.filter(m => messageChannelId(m) === activeChannelId);
  const index = messages.findIndex(m => m.id === messageId);
  if (index < 0) { notice("That message isn't in this view.", true); return; }
  const previous = index > 0 ? messages[index - 1].id : null;
  try {
    await client.setReadHorizon(currentThreadId ?? "", previous);
    horizonCache.set(currentThreadId ?? "", previous);
    horizonAnchorId = messageId;
    renderMessages();
    notice(index === 0 ? "Marked everything unread." : "Marked unread from here.");
  } catch (error) {
    notice(`Couldn't mark unread: ${error.message}`, true);
  }
}
async function toggleSaved(messageId) {
  if (!state || !session || !conversation.byId.has(messageId)) return;
  const saved = !savedMessageIds.has(messageId);
  try {
    await client.setSaved(messageId, saved);
    if (saved) savedMessageIds.add(messageId); else savedMessageIds.delete(messageId);
    notice(saved ? "Saved for later." : "Removed from saved.");
    renderMessages();
    void syncAttentionBadges();
  } catch (error) {
    notice(`Couldn't ${saved ? "save" : "unsave"}: ${error.message}`, true);
  }
}
function openActivity() {
  if (document.querySelector("dialog[open]")) return;
  activityFilter = "";
  for (const button of $("#activity-filters").querySelectorAll("[data-activity-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.activityFilter === ""));
  }
  $("#activity-dialog").showModal();
  void loadActivity(true);
}
async function loadActivity(reset) {
  if (activityBusy) return;
  const serial = ++activitySerial, generation = client.generation;
  if (reset) { activityItems = []; activityBefore = null; }
  activityBusy = true;
  setText("#activity-status", "Loading…");
  try {
    const result = await client.activity({ before: activityBefore, limit: 50, type: activityFilter || null });
    if (serial !== activitySerial || generation !== client.generation || !state) return;
    activityItems = reset ? result.items : activityItems.concat(result.items);
    activityBefore = activityItems.length ? activityItems[activityItems.length - 1].id : null;
    activityHasMore = result.hasMore;
    renderActivity();
    setText("#activity-status", activityItems.length ? "" : "Nothing here yet — mentions, replies, and reactions will appear.");
  } catch (error) {
    if (serial === activitySerial && generation === client.generation) setText("#activity-status", `Couldn't load activity: ${error.message}`);
  } finally {
    if (serial === activitySerial) activityBusy = false;
  }
}
function renderActivity() {
  renderBriefList("#activity-list", activityItems.map(item => {
    const detail = item.messageDeleted ? "Message deleted" : (item.messageBody ?? "").slice(0, 120);
    const label = `${memberLabel(item.actorId)} ${ACTIVITY_LABELS[item.type] ?? item.type}`;
    return `<li class="rb-event activity-item${item.readAt ? "" : " unread"}" data-activity-type="${esc(item.type)}">`
      + `<a class="rb-event-link" href="${esc(recordHref("message", item.messageId))}" data-open-message="${esc(item.messageId)}" data-activity-id="${item.id}" data-brief-key="activity:${item.id}" aria-label="${esc(label)}${item.readAt ? "" : ", unread"}">`
      + `<span class="rb-actor">${esc(label)}</span><time datetime="${esc(String(item.createdAt))}">${esc(time(item.createdAt))}</time>`
      + (detail ? `<span class="rb-detail">${esc(detail)}</span>` : "") + `</a></li>`;
  }).join("") || `<li class="rb-empty">Nothing here yet.</li>`);
  $("#activity-older").hidden = !activityHasMore;
}
$("#topbar-activity").addEventListener("click", openActivity);
$("#activity-close").addEventListener("click", () => $("#activity-dialog").close());
$("#activity-filters").addEventListener("click", event => {
  const button = event.target.closest("[data-activity-filter]");
  if (!button || button.dataset.activityFilter === activityFilter) return;
  activityFilter = button.dataset.activityFilter;
  for (const sibling of $("#activity-filters").querySelectorAll("[data-activity-filter]")) {
    sibling.setAttribute("aria-pressed", String(sibling === button));
  }
  void loadActivity(true);
});
$("#activity-older").addEventListener("click", () => void loadActivity(false));
$("#activity-read-all").addEventListener("click", async () => {
  try {
    await client.markActivityReadAll(activityFilter || null);
    for (const item of activityItems) item.readAt = Date.now();
    renderActivity();
    void syncAttentionBadges();
    notice("All activity marked read.");
  } catch (error) {
    notice(`Couldn't mark read: ${error.message}`, true);
  }
});
function openLater() {
  if (document.querySelector("dialog[open]")) return;
  $("#later-dialog").showModal();
  void loadLater();
}
async function loadLater() {
  const generation = client.generation, roomId = session?.roomId;
  setText("#later-status", "Loading…");
  try {
    const result = await client.savedList();
    // E-H3: drop stale flights — the previous room's saved message bodies
    // must never render into the new room's dialog.
    if (!state || generation !== client.generation || session?.roomId !== roomId) return;
    renderBriefList("#later-list", result.items.map(item => {
      const detail = item.deleted ? "Message deleted" : (item.body ?? "").slice(0, 120);
      return `<li class="rb-event later-item">`
        + `<a class="rb-event-link" href="${esc(recordHref("message", item.messageId))}" data-open-message="${esc(item.messageId)}" data-brief-key="later:${esc(item.messageId)}">`
        + `<span class="rb-actor">${esc(memberLabel(item.authorId))}</span><time datetime="${esc(String(item.createdAt))}">${esc(time(item.createdAt))}</time>`
        + (detail ? `<span class="rb-detail">${esc(detail)}</span>` : "") + `</a>`
        + `<button class="text-button" type="button" data-unsave-message="${esc(item.messageId)}">Unsave</button></li>`;
    }).join("") || `<li class="rb-empty">Nothing saved yet. Use ⋯ → Save on any message.</li>`);
    setText("#later-status", "");
  } catch (error) {
    setText("#later-status", `Couldn't load saved messages: ${error.message}`);
  }
}
$("#topbar-later").addEventListener("click", openLater);
$("#later-close").addEventListener("click", () => $("#later-dialog").close());
$("#later-list").addEventListener("click", async event => {
  const button = event.target.closest("[data-unsave-message]");
  if (!button) return;
  event.preventDefault();
  try {
    await client.unsaveMessage(button.dataset.unsaveMessage);
    savedMessageIds.delete(button.dataset.unsaveMessage);
    notice("Removed from saved.");
    void loadLater();
    void syncAttentionBadges();
  } catch (error) {
    notice(`Couldn't unsave: ${error.message}`, true);
  }
});
// Opening an activity or preview item jumps to the message and marks the item read.
document.addEventListener("click", event => {
  const link = event.target.closest("[data-activity-id], [data-preview-id]");
  if (!link) return;
  const id = Number(link.dataset.activityId ?? link.dataset.previewId);
  if (!Number.isInteger(id)) return;
  const item = activityItems.find(entry => entry.id === id) ?? previewItems.find(entry => entry.id === id);
  if (item && !item.readAt) {
    item.readAt = Date.now();
    renderActivity();
    client.markActivityRead([id]).then(() => { void syncAttentionBadges(); void refreshActivityPreview(); }).catch(() => {});
  }
}, true);
function syncNotifications() {
  if (!client.session || !client.ownsAccountSession() || !state) { resetNotifications(); return; }
  if (!ownsNotifications(notificationOwner)) { resetNotifications(); notificationOwner = { generation: client.generation, session: client.session, inputs: null, sequence: null }; }
  // Inputs that change the feed directly refetch at once: your cursor, your membership
  // revision and your preferences. New room events only coalesce a refetch, and a hidden
  // tab waits until it is visible again.
  const me = state.members[session.member.id];
  const inputs = `${roomCursor}:${me?.revision ?? ""}:${JSON.stringify(me?.notificationPreferences ?? null)}`;
  if (notificationOwner.inputs !== inputs) { notificationOwner.inputs = inputs; notificationOwner.sequence = client.sequence; scheduleNotifications(0); }
  else if (notificationOwner.sequence !== client.sequence) {
    notificationOwner.sequence = client.sequence;
    if (document.visibilityState === "hidden") notificationOwner.stale = true; else scheduleNotifications(NOTIFICATION_COALESCE_MS);
  }
  renderNotifications();
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "hidden" && ownsNotifications(notificationOwner) && notificationOwner.stale) { notificationOwner.stale = false; scheduleNotifications(0); }
  // Consent changes emit no room event; re-sync the side table when the tab
  // comes back so the People panel never shows a stale gate.
  if (document.visibilityState === "visible") { void refreshDmConsents(); void refreshFriendBonds(); }
});
// ---- Presence states ----------------------------------------------------------
// #660: server-derived per-member working states (working/listening/idle/
// unreachable/unknown) observations. Failed refreshes retain context while
// clearly qualifying cached availability as unrefreshed.
async function refreshPresenceStates() {
  if (!state || !session || $("#main").hidden) return;
  // Qualify synchronously, including while the owned request is still pending.
  if (presenceObservationAged()) render();
  if (presenceRequest && ownsPresenceRequest(presenceRequest)) return;
  const request = { seq: ++presenceSeq, generation: client.generation, room: state };
  presenceRequest = request;
  try {
    const result = await client.request(client.path("/presence"));
    if (!ownsPresenceRequest(request)) return;
    const next = new Map();
    for (const entry of result?.members ?? []) {
      if (entry && entry.memberId) next.set(entry.memberId, entry);
    }
    presenceStates = next; presenceUnrefreshed = false; presenceCheckedAt = Date.now();
    if (presenceAgeTimer) clearTimeout(presenceAgeTimer);
    const checkedAt = presenceCheckedAt;
    presenceAgeTimer = setTimeout(() => {
      if (request.generation === client.generation
        && request.room.room.id === state?.room?.id && checkedAt === presenceCheckedAt) render();
    }, PRESENCE_OBSERVATION_MAX_AGE_MS);
  } catch {
    if (!ownsPresenceRequest(request)) return;
    // Keep useful context, but never present a cached report as current.
    presenceUnrefreshed = true;
  } finally {
    if (ownsPresenceRequest(request)) { presenceRequest = null; render(); }
  }
}
// Returning from a hidden or restored page checks the report immediately.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void refreshPresenceStates();
});
window.addEventListener("pageshow", event => {
  if (event.persisted && document.visibilityState === "visible") void refreshPresenceStates();
});
$("#presence-list").addEventListener("click", event => {
  if (event.target.closest("[data-refresh-presence]")) void refreshPresenceStates();
});
function startPresencePoll() {
  stopPresencePoll();
  void refreshPresenceStates();
  presenceTimer = setInterval(() => {
    if (document.visibilityState === "visible") void refreshPresenceStates();
  }, PRESENCE_REFRESH_MS);
}
function stopPresencePoll() {
  presenceSeq++;
  if (presenceTimer) { clearInterval(presenceTimer); presenceTimer = null; }
  if (presenceAgeTimer) { clearTimeout(presenceAgeTimer); presenceAgeTimer = null; }
  presenceStates = new Map(); presenceUnrefreshed = false; presenceCheckedAt = null; presenceRequest = null;
}
// ---- DM consent ---------------------------------------------------------------
// The signed-in member's consent pairs drive the People panel's Direct
// messages sections and the composer's DM recipient hint. Load failures stay
// silent (a stale list is worse than none); every action reports loudly.
function dmConsentStale(seq, generation, room) {
  // Compare the room, not the state object: every stream snapshot assigns a
  // fresh state object, so an identity check discards a result that a
  // mid-flight snapshot raced with even though nothing changed rooms.
  return seq !== dmConsentSeq || generation !== client.generation || state?.room?.id !== room?.room?.id;
}
async function refreshDmConsents() {
  if (!state || !session || $("#main").hidden) { dmConsentRefetchQueued = false; return; }
  if (dmConsentBusy) { dmConsentRefetchQueued = true; return; }
  const seq = ++dmConsentSeq, generation = client.generation, room = state;
  dmConsentBusy = true;
  try {
    const result = await fetchDmConsents(client);
    if (dmConsentStale(seq, generation, room)) return;
    dmConsents = Array.isArray(result) ? result : [];
  } catch {
    // A failed refresh keeps the last known list: wiping it would flash the
    // whole People panel back to "no consent" while the failed action
    // already reported loudly through the notice banner.
    if (dmConsentStale(seq, generation, room)) return;
  } finally {
    dmConsentBusy = false;
    if (!dmConsentStale(seq, generation, room)) render();
    if (dmConsentRefetchQueued) { dmConsentRefetchQueued = false; void refreshDmConsents(); }
  }
}
async function runDmConsentAction(action, peerId, button) {
  if (!state || !session || dmConsentBusy) return;
  const peer = state.members[peerId];
  if (!peer || peer.active === false) return;
  const seq = ++dmConsentSeq, generation = client.generation, room = state;
  dmConsentBusy = true;
  if (button) button.disabled = true;
  try {
    if (action === "request") await requestDmConsent(client, peerId);
    else if (["approve", "reject"].includes(action)) {
      const pending = incomingDmRequests(dmConsents, state.members, session.member.id).find(r => r.requesterId === peerId);
      if (!pending) throw Object.assign(new Error("That DM request is no longer pending."), { code: "dm_no_pending_request" });
      await decideDmConsent(client, pending.requesterId, action);
    } else if (action === "block") {
      // A pending request from them is blocked on the request itself (keeps
      // the request's row and reason); otherwise the proactive block route.
      const pending = incomingDmRequests(dmConsents, state.members, session.member.id).find(r => r.requesterId === peerId);
      if (pending) await decideDmConsent(client, pending.requesterId, "block");
      else await blockDmMember(client, peerId);
    }
    else if (action === "unblock") await unblockDmMember(client, peerId);
    else if (action === "revoke") await revokeDmConsent(client, peerId);
    else return;
    if (dmConsentStale(seq, generation, room)) return;
    notice(action === "request" ? `DM request sent to ${peer.displayName}.`
      : action === "approve" ? `${peer.displayName} can now message you directly.`
      : action === "reject" ? `Declined ${peer.displayName}'s DM request.`
      : action === "block" ? `${peer.displayName} blocked — they can't message you or send new requests.`
      : action === "unblock" ? `${peer.displayName} unblocked — they can send a DM request again.`
      : `DM consent with ${peer.displayName} revoked.`);
  } catch (error) {
    if (!dmConsentStale(seq, generation, room)) notice(dmConsentFailureMessage(error, peer.displayName), true);
  } finally {
    dmConsentBusy = false;
    // Re-enable the clicked button: a failed action leaves the consent list
    // unchanged, so the post-action render skips the DOM (identical HTML) and
    // would otherwise leave the button dead until an unrelated re-render.
    if (button) button.disabled = false;
    const drained = dmConsentRefetchQueued;
    dmConsentRefetchQueued = false;
    // Drain even across a room switch: the queued request came from the old
    // room, but the panel on the new room needs fresh consent data too.
    if (!dmConsentStale(seq, generation, room) || drained) await refreshDmConsents();
  }
}
// ---- Friend / Bond ------------------------------------------------------------
// People row control for agent↔agent bonds. Room DM consent stays its own
// disclosure. Load failures keep the last list; actions report in the notice.
async function refreshFriendBonds() {
  if (!state || !session || $("#main").hidden || friendBusy) return;
  if (session.member.kind !== "agent") return;
  const seq = ++friendSeq, generation = client.generation, room = state;
  try {
    const result = await client.request(client.path("/bonds"));
    if (seq !== friendSeq || generation !== client.generation || state !== room) return;
    friendBonds = Array.isArray(result?.bonds) ? result.bonds : [];
  } catch {
    if (seq !== friendSeq || generation !== client.generation || state !== room) return;
  } finally {
    if (seq === friendSeq && generation === client.generation && state === room) render();
  }
}
function friendPeerTarget(peer) {
  return identityIdOf(peer, presenceStates.get(peer.id)) || peer.id;
}
function focusFriendGroup(peerMemberId) {
  const group = $(`#presence-list .friend-bond[data-friend-peer="${CSS.escape(peerMemberId)}"]`);
  // The group carries data-focus-key, so a snapshot render while this action
  // is in flight restores the group and not a replacement Revoke button.
  if (group && document.activeElement !== group) group.focus({ preventScroll: true });
}
async function runFriendAction(action, peerMemberId, bondId, button) {
  if (!state || !session || friendBusy) return;
  const peer = state.members[peerMemberId];
  if (!peer || peer.active === false || peer.kind !== "agent" || peer.id === session.member.id) return;
  if (action === "dm") { openFriendThread(peerMemberId); return; }
  const generation = client.generation;
  // Move focus off the clicked button before any await. A held Enter repeats
  // on the focused control; landing on Revoke sent bond.revoke, including
  // after the peer had already accepted and the chrome had become Friends.
  if (friendFocusTarget(action) === "group") focusFriendGroup(peerMemberId);
  friendBusy = true;
  if (button) button.disabled = true;
  try {
    const built = friendBondCommand(action, { to: friendPeerTarget(peer), bondId });
    await client.send({ id: crypto.randomUUID(), type: built.type, data: built.data });
    if (generation !== client.generation || !state) return;
    notice(action === "propose" ? `Friend request sent to ${peer.displayName}.`
      : action === "accept" ? `You and ${peer.displayName} are friends.`
      : action === "decline" ? `Declined ${peer.displayName}'s friend request.`
      : `Friend bond with ${peer.displayName} revoked.`);
  } catch (error) {
    if (generation === client.generation && state) notice(friendFailureMessage(error), true);
  } finally {
    friendBusy = false;
    if (button?.isConnected) button.disabled = false;
    if (generation === client.generation && state) {
      await refreshFriendBonds();
      if (friendFocusTarget(action) === "group") focusFriendGroup(peerMemberId);
    }
  }
}
function friendThreadHtml(messages, peerMemberId) {
  const selfId = identityIdOf(state.members[session.member.id] ?? session.member, presenceStates.get(session.member.id));
  return friendMessageHtml(messages, { selfId, peerName: displayName(peerMemberId), esc, time });
}
async function loadFriendThread(peerMemberId) {
  if (!state || !session || friendDmPeerId !== peerMemberId) return;
  const generation = client.generation;
  const peer = state.members[peerMemberId];
  const peerIdentity = peer ? identityIdOf(peer, presenceStates.get(peer.id)) : null;
  try {
    const listed = await client.request(client.path("/peer-dms"));
    if (generation !== client.generation || friendDmPeerId !== peerMemberId || !state) return;
    const thread = (listed?.threads ?? []).find(row => row.peerIdentityId === peerIdentity);
    if (!thread) { renderContent("#friend-dm-list", friendThreadHtml(null, peerMemberId)); return; }
    const history = await client.request(client.path(`/peer-dms/${encodeURIComponent(thread.threadId)}`));
    if (generation !== client.generation || friendDmPeerId !== peerMemberId || !state) return;
    renderContent("#friend-dm-list", friendThreadHtml(history?.messages, peerMemberId));
    // The thread window is short on a phone: land on the newest message, the
    // same way the room chat list does, instead of leaving the reader at the
    // oldest message of the thread.
    scrollFriendDmToLatest();
  } catch (error) {
    if (generation === client.generation && friendDmPeerId === peerMemberId) dialogNotice("#friend-dm-status", friendFailureMessage(error), true);
  }
}
function scrollFriendDmToLatest() {
  const list = $("#friend-dm-list");
  if (list) list.scrollTop = list.scrollHeight;
}
function openFriendThread(peerMemberId) {
  if (!state || !session) return;
  const peer = state.members[peerMemberId];
  if (!peer) return;
  friendDmPeerId = peerMemberId;
  $("#friend-dm-title").textContent = `Friends with ${peer.displayName}`;
  $("#friend-dm-input").value = "";
  setFormStatus($("#friend-dm-status"), "");
  renderContent("#friend-dm-list", friendThreadHtml(null, peerMemberId));
  if (!$("#friend-dm-dialog").open) $("#friend-dm-dialog").showModal();
  void loadFriendThread(peerMemberId);
  $("#friend-dm-input").focus();
}
$("#friend-dm-close").addEventListener("click", () => { friendDmPeerId = null; $("#friend-dm-dialog").close(); });
$("#friend-dm-dialog").addEventListener("close", () => { friendDmPeerId = null; });
$("#friend-dm-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!state || !session || !friendDmPeerId || friendBusy) return;
  const peerMemberId = friendDmPeerId;
  const peer = state.members[peerMemberId];
  const body = $("#friend-dm-input").value.trim();
  if (!peer || !body) return;
  const generation = client.generation;
  friendBusy = true;
  $("#friend-dm-form").querySelector("button[type=submit]").disabled = true;
  try {
    const built = friendBondCommand("dm", {
      to: friendPeerTarget(peer), body, messageId: crypto.randomUUID()
    });
    await client.send({ id: crypto.randomUUID(), type: built.type, data: built.data });
    if (generation !== client.generation || !state || friendDmPeerId !== peerMemberId) return;
    $("#friend-dm-input").value = "";
    setFormStatus($("#friend-dm-status"), "");
    await loadFriendThread(peerMemberId);
  } catch (error) {
    if (generation === client.generation && state) dialogNotice("#friend-dm-status", friendFailureMessage(error), true);
  } finally {
    friendBusy = false;
    const submit = $("#friend-dm-form")?.querySelector("button[type=submit]");
    if (submit) submit.disabled = false;
    if (generation === client.generation && state) await refreshFriendBonds();
  }
});
// The DM compose mirrors the room composer: Enter sends on desktop keyboards
// (Shift+Enter for a new line), while touch keyboards keep Return as a new
// line and get a "send" return key plus the matching hint.
function syncFriendDmHint() {
  const input = $("#friend-dm-input"), caption = $("#friend-dm-hint");
  const hint = touchKeyboard.matches ? "Return for a new line · ↑ to send" : "Enter to send · Shift + Enter for a new line";
  input.title = hint;
  input.setAttribute("aria-description", hint);
  if (caption) caption.textContent = hint;
  input.enterKeyHint = touchKeyboard.matches ? "enter" : "send";
}
touchKeyboard.addEventListener("change", syncFriendDmHint);
syncFriendDmHint();
$("#friend-dm-input").addEventListener("keydown", e => {
  // Composition, key repeat, and touch Return must never accidentally submit —
  // the shared sendsOnEnter gate carries the same rules as the room composer.
  if (sendsOnEnter(e, touchKeyboard.matches)) {
    e.preventDefault();
    if (!friendBusy && $("#friend-dm-input").value.trim()) $("#friend-dm-form").requestSubmit();
  }
});
$("#notification-read-button").addEventListener("click", async () => {
  const ticket = notificationOwner, feed = notificationFeed;
  if (!ownsNotifications(ticket) || !feed?.unread || feed.nextBefore || feed.pageBefore || notificationBefore !== null || notificationBusy || notificationLoading) return;
  notificationBusy = true; notificationNote = ""; renderNotifications();
  let saved = false;
  try {
    const result = await client.caughtUp(feed.sequence); // Exactly what the list was evaluated through.
    if (!ownsNotifications(ticket) || !result) return;
    saved = true; roomCursor = Math.max(roomCursor, result.cursor); catchUpBoundary = Math.max(catchUpBoundary, result.cursor); notificationError = "";
    await client.refresh();
    if (!ownsNotifications(ticket)) return;
    void loadReturnBrief();
  } catch (error) {
    if (!ownsNotifications(ticket)) return;
    // Truthful feedback: a stored marker is never reported as a failed save.
    // The feed's own status line, not the page notice: this button lives in
    // the catch-up dialog, and a page notice is painted under its backdrop.
    if (saved) notificationNote = "Marked read. The latest room view could not be refreshed; refresh before relying on this list.";
    else notificationError = "Could not mark read. Try again.";
    if ([401, 403].includes(error.status)) client.handleFailure(error);
  } finally {
    if (ownsNotifications(ticket)) { notificationBusy = false; syncNotifications(); }
  }
});
const roleLabel = role => ({ accountableMemberId: "accountable", verifierMemberId: "verifier", humanDecisionMakerId: "decision maker" }[role] ?? humanize(role));
const BRIEF_GROUP_LABELS = { outcome: "Results", question: "Asked of you", blocker: "Blockers", decision: "Decisions", other: "Other updates" };
function briefEventTarget(event) {
  if (event.type === T.MESSAGE_POSTED) return { kind: "message", id: event.data.messageId || event.id };
  if (event.type === T.MESSAGE_REACTION_SET) return { kind: "message", id: event.data.messageId };
  if (event.data.workItemId) return { kind: "work", id: event.data.workItemId };
  if ([T.MEMBER_ADDED, T.MEMBER_ACCESS_CHANGED].includes(event.type) && event.data.memberId) return { kind: "member", id: event.data.memberId };
  if (event.type === T.ROOM_CREATED) return { kind: "room", id: state.room.id };
  return { kind: "event", id: event.id };
}
function describeBriefEvent({ sequence, event }) {
  const actor = esc(memberLabel(event.actorId));
  const type = esc(humanize(event.type));
  const actorRole = event.type === T.WORK_COMPLETED ? `reporter ${actor}` : actor;
  let detail = "";
  if (event.type === T.MESSAGE_POSTED) detail = esc((event.data.body || "").slice(0, 80));
  else if (event.type === T.VERIFICATION_RECORDED) detail = esc(`${event.data.result} · ${(event.data.summary || "").slice(0, 60)}`);
  else if (event.type === T.OWNER_DECISION_RECORDED) detail = esc(humanize(event.data.decision));
  else if (event.type === T.WORK_COMPLETED) {
    const title = state.workItems[event.data.workItemId]?.title ?? event.data.workItemId ?? "";
    const producer = event.data.producerId ? memberLabel(event.data.producerId)
      : event.data.externalProducer ? `${event.data.externalProducer} · outside room, reported` : "unknown — not reported";
    detail = esc(`${title} · producer ${producer}`);
  }
  else if (event.type?.startsWith("work.")) detail = esc(state.workItems[event.data.workItemId]?.title ?? event.data.workItemId ?? "");
  else if (event.type === "land.updated") detail = esc(`#${event.data.pr ?? ""} ${(event.data.changed || []).join(", ")}`.trim());
  const target = briefEventTarget(event);
  const href = esc(recordHref(target.kind, target.id));
  const attribute = target.kind === "room" ? `data-open-room="${esc(target.id)}"`
    : `data-open-${target.kind}="${esc(target.id)}"`;
  return `<li class="rb-event"><a class="rb-event-link" href="${href}" ${attribute} data-brief-key="history:${esc(event.id)}"><span class="rb-seq">#${sequence}</span> <span class="rb-type">${type}</span> <span class="rb-actor">${actorRole}</span>${detail ? ` <span class="rb-detail">${detail}</span>` : ""}</a></li>`;
}
function renderBriefList(selector, html) {
  const list = $(selector);
  const focusedKey = list.contains(document.activeElement)
    ? document.activeElement.closest("[data-brief-key]")?.dataset.briefKey
    : null;
  const previousKeys = focusedKey ? [...list.querySelectorAll("[data-brief-key]")].map(node => node.dataset.briefKey) : [];
  const changed = list._content !== html;
  if (changed) {
    list.innerHTML = html;
    list._content = html;
  }
  if (focusedKey && changed) {
    const remaining = new Map([...list.querySelectorAll("[data-brief-key]")].map(node => [node.dataset.briefKey, node]));
    const index = previousKeys.indexOf(focusedKey);
    // Keep the current item, then its next surviving neighbor, then the previous
    // one. A resolved request should not restart a long queue at the first row.
    const destination = [focusedKey, ...previousKeys.slice(index + 1), ...previousKeys.slice(0, index).reverse()]
      .map(key => remaining.get(key)).find(Boolean) ?? remaining.values().next().value;
    const acknowledgement = $("#rb-ack-button");
    const fallback = !acknowledgement.disabled && !acknowledgement.hidden
      ? acknowledgement
      : $("#return-brief-panel > summary");
    (destination || fallback).focus({ preventScroll: true });
  }
}
function renderContribution(steps, owned) {
  const panel = $("#contribution-next"), button = $("#contribution-open"), more = $("#contribution-more");
  const focused = panel.contains(document.activeElement);
  const selected = (focused && steps.find(step => step.key === button.dataset.step)) || steps[0];
  const contributed = owned && (state.messages.some(message => message.authorId === session.member.id)
    || state.eventLog.some(event => event.actorId === session.member.id && /^(work|verification|owner_decision)\./.test(event.type)));
  // An empty conversation already points at its composer. Do not push it below
  // the first mobile viewport with a second introduction prompt.
  const newcomer = owned && !contributed && state.messages.length > 0;
  const visible = Boolean(selected || newcomer);
  const key = selected?.key ?? "hello";
  if (focused && (!visible || key !== button.dataset.step)) $("#return-brief-panel > summary").focus({ preventScroll: true });
  panel.hidden = !visible;
  setText("#contribution-label", selected?.label ?? (newcomer ? "Start here" : ""));
  setText("#contribution-title", selected?.title ?? (newcomer ? "What would you like to help with?" : ""));
  setText("#contribution-open", selected?.button ?? (newcomer ? "Say hello" : ""));
  button.dataset.step = key;
  button.disabled = !owned || busy || requestReading;
  more.hidden = steps.length < 2;
  setText("#contribution-more", steps.length > 1 ? `${steps.length - 1} more` : "");
}
$("#contribution-more").addEventListener("click", () => {
  if (!state) return;
  $("#return-brief-panel").open = true;
  $("#return-brief-panel > summary").focus();
});
$("#contribution-open").addEventListener("click", () => {
  if (!state || busy || requestReading || client.session !== session || !client.ownsAccountSession()) return;
  const key = $("#contribution-open").dataset.step;
  if (key === "hello") {
    if ($("#catchup-dialog")?.open) $("#catchup-dialog").close();
    switchThread(null, true);
    return;
  }
  const step = contributionSteps(state, session.member.id).find(candidate => candidate.key === key);
  if (!step) { renderReturnBrief(); return; }
  if (step.kind === "request") { revealMessage(step.id); return; }
  if (step.draftCount > 1) { revealDrafts(step.id); return; }
  if (step.draftMessageId) { revealMessage(step.draftMessageId); return; }
  // Only review/decision shortcuts open a form. Starting work still requires
  // inspecting its existing card and explicitly choosing the relevant action.
  if (["verify", "decide"].includes(step.action)) openWorkAction(state.workItems[step.id], step.action);
  else revealWork(step.id);
});
function renderReturnBrief({ timelineRendered = false } = {}) {
  clearTimeout(returnClock); returnClock = null;
  const now = Date.now();
  const owned = state && session && client.session === session && client.generation === roomGeneration && client.ownsAccountSession();
  const returnBrief = briefView.owns(briefView.chain) ? briefView.brief : null;
  const current = owned ? { evaluatedThrough: client.sequence,
    needsAttention: needsAttention({ workItems: state.workItems, memberId: session.member.id, now }),
    workInvolvingMe: workInvolvingMe({ workItems: state.workItems, memberId: session.member.id }) } : null;
  const unread = state ? Math.max(0, client.sequence - Math.max(roomCursor, catchUpBoundary)) : 0;
  const contributions = owned ? contributionSteps(state, session.member.id, now) : [];
  renderContribution(contributions, owned);
  setText("#catchup-count", current ? briefView.message === "Updating room…" ? "Updating…" : [contributions.length ? `${contributions.length} need${contributions.length === 1 ? "s" : ""} you` : "",
    unread ? `${unread} update${unread === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ") || "No new updates" : "");
  $("#room-results-open").hidden = !owned || completedResults(state).length === 0;
  if (owned) {
    // Work destinations and catch-up use the same clock, even without new events.
    renderSearch(now);
    const items = Object.values(state.workItems);
    if (!timelineRendered) syncTimelineWork();
    const resultFocus = $("#room-results-list").contains(document.activeElement) ? document.activeElement : null;
    renderContent("#room-results-list", completedResults(state).map(resultRow).join("") || '<li class="empty-note">No completed results yet.</li>');
    if (resultFocus && !resultFocus.isConnected && document.activeElement === document.body) ($("#settings-dialog").classList.contains("results-only") ? $("#room-results-list") : $("#results-panel > summary")).focus({ preventScroll: true });
    resultStatus();
    syncActionForm();
    const expiry = items.flatMap(item => [item.claim?.status === "active" ? Date.parse(item.claim.expiresAt) : NaN,
      ...(item.helpWanted?.status === "open" ? [Date.parse(item.helpWanted.openedAt), Date.parse(item.helpWanted.expiresAt)] : [])]).filter(at => at > now).sort((a, b) => a - b)[0];
    if (expiry && document.visibilityState !== "hidden") returnClock = setTimeout(renderReturnBrief, Math.max(100, Math.min(60000, expiry - now)));
  }
  const newer = returnBrief && client.sequence > returnBrief.history.evaluatedThrough;
  // The reconciliation note comes first: it is the one thing here that says
  // what was already saved, which the generic brief message does not.
  setText("#rb-status", owned ? briefReconcileNote || briefView.message || (newer ? "New changes available. Refresh catch-up." : "") : "");
  $("#rb-refresh-button").disabled = !owned || briefView.busy;
  $("#return-brief-panel").setAttribute("aria-busy", briefView.busy ? "true" : "false");
  $("#rb-more-button").disabled = briefView.busy;
  $("#rb-ack-button").disabled = true;
  delete $("#rb-ack-button").dataset.horizon;
  $("#rb-more-button").hidden = true;
  const attention = current?.needsAttention ?? [];
  const byWork = new Map(contributions.filter(step => step.kind === "work").map(step => [step.id, step]));
  // Preserve the established catch-up order while the single next-step suggestion
  // prioritizes handoffs. Updating work must not move it out of the first page.
  const attentionIds = new Set(attention.map(item => item.workItemId));
  const attentionSteps = [...attention.map(item => byWork.get(item.workItemId)).filter(Boolean),
    ...contributions.filter(step => step.kind === "request" || !attentionIds.has(step.id))];
  const preview = attentionPreview(attentionSteps);
  const allButton = $("#rb-show-all"), allFocused = document.activeElement === allButton;
  if (!preview.hiddenCount) showAllAttention = false;
  allButton.hidden = !preview.hiddenCount;
  allButton.textContent = showAllAttention ? "Show less" : `Show all (${preview.all.length})`;
  allButton.setAttribute("aria-expanded", String(showAllAttention));
  if (allFocused && allButton.hidden) $("#return-brief-panel > summary").focus({ preventScroll: true });
  renderBriefList("#rb-attention-list", (showAllAttention ? preview.all : preview.visible).map(i => {
    const messageId = i.draftCount > 1 ? null : i.draftMessageId ?? (i.kind === "request" ? i.id : null);
    const href = messageId ? recordHref("message", messageId) : workHref(i.id);
    const target = messageId ? `data-open-message="${esc(messageId)}"` : `data-open-work="${esc(i.id)}"${i.draftCount > 1 ? ' data-view-drafts' : ''}`;
    const label = messageId || i.draftCount > 1 || i.recovery ? i.label : nextWorkStep(state.workItems[i.id], now).label;
    return `<li class="rb-event"><a class="work-link" href="${esc(href)}" ${target} data-brief-key="${esc(i.kind === "work" ? `attention:${i.id}` : i.key)}">${esc(i.title)}</a> <span class="rb-detail">${esc(label)}</span></li>`;
  }).join("")
    || (current ? '<li class="rb-empty">Nothing waiting for you.</li>' : ""));
  for (const workId of byWork.keys()) attentionIds.add(workId);
  renderBriefList("#rb-involving-list", (current?.workInvolvingMe ?? []).filter(i => !attentionIds.has(i.workItemId)).map(i =>
    `<li class="rb-event"><a class="work-link" href="${esc(workHref(i.workItemId))}" data-open-work="${esc(i.workItemId)}" data-brief-key="involving:${esc(i.workItemId)}">${esc(i.action ?? i.workItemId)}</a> <span class="rb-detail">${esc(i.roles.map(roleLabel).join(", "))} · ${esc(i.state)}</span></li>`).join("")
    || (current ? '<li class="rb-empty">No other open work.</li>' : ""));
  setText("#rb-current-boundary", current ? `Current work as of event ${current.evaluatedThrough}` : "");
  if (!returnBrief || !owned) {
    setText("#rb-ack-note", "");
    for (const id of ["summary-grid", "rb-history-boundary", "rb-history-count", "rb-history-list"]) $(`#${id}`).replaceChildren();
    delete $("#rb-history-list")._content;
    $("#rb-ack-button").textContent = briefView.reconciliationRequired ? "Refresh brief before acknowledging" : "Mark caught up";
    return;
  }
  const { history } = returnBrief;
  const changes = history.evaluatedThrough - history.cursor;
  setText("#rb-ack-note", changes ? `Marks all ${changes} update${changes === 1 ? "" : "s"} read. Work stays open.` : "Work stays open.");
  setText("#summary-grid", `${changes} ${changes === 1 ? "change" : "changes"} since your marker · ${contributions.length} to act on`);
  setText("#rb-history-count", changes ? `(${changes})` : "");
  $("#rb-history-boundary").textContent = history.evaluatedThrough === history.cursor
    ? "· nothing new since your marker"
    : `${history.items.length} of ${changes} events · through ${history.evaluatedThrough}`;
  const historyGroups = groupBriefHistory(history.items, session?.member?.id);
  renderBriefList("#rb-history-list", (historyGroups.length
    ? historyGroups.map(([name, items]) =>
      `<li class="rb-group"><span class="rb-group-label">${esc(BRIEF_GROUP_LABELS[name])} (${items.length})</span><ul class="rb-list rb-group-list">${items.map(describeBriefEvent).join("")}</ul></li>`).join("")
    : history.items.map(describeBriefEvent).join(""))
    || '<li class="rb-empty">Nothing new since your marker.</li>');
  $("#rb-more-button").hidden = !history.hasMore;
  $("#rb-ack-button").textContent = history.evaluatedThrough === history.cursor ? "Already caught up" : "Mark caught up";
  $("#rb-ack-button").dataset.horizon = String(history.evaluatedThrough);
  $("#rb-ack-button").setAttribute("aria-describedby", "rb-ack-note rb-history-boundary");
  $("#rb-ack-button").disabled = briefView.busy || history.evaluatedThrough === history.cursor;
}
$("#return-brief-panel").addEventListener("toggle", e => {
  if (e.currentTarget.open && state) loadReturnBrief(); // reopening replaces the pagination chain
});
// F5: read-only usage summary card. Loaded when the card opens (and on
// Refresh), never on every snapshot: the figures are a period summary, not a
// live feed. Spend is what agents reported; "unknown" is rendered as such.
let usageRequest = 0;
const usageNumber = value => Number(value).toLocaleString("en-US");
const usageMoney = cents => cents === "unknown" ? "unknown" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const usageBytes = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
function usageCapRow(label, cap, format = usageNumber) {
  return `<dt>${esc(label)}</dt><dd>${esc(format(cap.used))} of ${esc(format(cap.limit))}<small>${esc(format(cap.remaining))} left</small></dd>`;
}
async function loadUsage() {
  if (!state || !client.session) return;
  const request = ++usageRequest;
  $("#usage-status").textContent = "Loading usage…";
  $("#usage-refresh").hidden = true;
  try {
    const usage = await client.request(client.path("/usage"));
    if (request !== usageRequest || !state) return;
    const { members, sessions, spend, spendAllowance: ledger, caps, period } = usage;
    const spendNote = spend.reportedCents === "unknown" ? "no session reported spend"
      : spend.sessionsUnreported ? `${usageNumber(spend.sessionsUnreported)} of ${usageNumber(spend.sessionsReported + spend.sessionsUnreported)} sessions unreported` : "every session reported";
    $("#usage-period").textContent = `${period.days}d`;
    const group = (heading, rows) => `<h3 class="usage-heading">${esc(heading)}</h3><dl>${rows.join("")}</dl>`;
    renderContent("#usage-grid", [
      group("Seats", [
        `<dt>People</dt><dd>${esc(usageNumber(members.humans))}</dd>`,
        `<dt>Agents</dt><dd>${esc(usageNumber(members.agents))}${members.agentIdentities ? `<small>${esc(usageNumber(members.agentIdentities))} via managed identities</small>` : ""}</dd>`
      ]),
      group(`Last ${period.days} days`, [
        `<dt>Sessions started</dt><dd>${esc(usageNumber(sessions.started))}</dd>`,
        `<dt>Sessions stopped</dt><dd>${esc(usageNumber(sessions.stopped))}${sessions.budgetStops ? `<small>${esc(usageNumber(sessions.budgetStops))} stopped by budget</small>` : ""}</dd>`,
        `<dt>Reported spend</dt><dd>${esc(usageMoney(spend.reportedCents))}<small>${esc(spendNote)}</small></dd>`
      ]),
      // C3: the allowance ledger over its own period; "Agent spend" keeps the owner controls.
      group("Spend allowance", [
        `<dt>Allowance</dt><dd data-usage-allowance="${ledger.allowance ? "set" : "none"}">${ledger.allowance ? `${esc(usageMoney(ledger.allowance.allowanceCents))}<small>over ${esc(usageNumber(ledger.period.days))} days</small>` : "none set"}</dd>`,
        `<dt>Spent</dt><dd>${esc(usageMoney(ledger.spentCents))}</dd>`,
        `<dt>Reserved</dt><dd>${esc(usageMoney(ledger.reservedCents))}<small>${esc(usageNumber(ledger.sessions.live))} live</small></dd>`,
        ...(ledger.heldCents ? [`<dt>Held</dt><dd>${esc(usageMoney(ledger.heldCents))}<small>unreported attempts</small></dd>`] : []),
        `<dt>Headroom</dt><dd>${ledger.allowance ? esc(ledger.overCents ? `over by ${usageMoney(ledger.overCents)}` : usageMoney(ledger.headroomCents)) : "no cap"}</dd>`
      ]),
      group("Pilot caps", [
        usageCapRow("Members", caps.members),
        usageCapRow("Work items", caps.workItems),
        usageCapRow("Room history", caps.events),
        usageCapRow("Room size", caps.projectionBytes, usageBytes)
      ])
    ].join(""));
    $("#usage-status").textContent = "";
  } catch (error) {
    if (request !== usageRequest || !state) return;
    $("#usage-status").textContent = error.status === 429 ? "Usage is rate limited; try again in a minute." : "Usage could not be loaded.";
    $("#usage-refresh").hidden = false;
  }
}
$("#usage-panel").addEventListener("toggle", e => { if (e.currentTarget.open) loadUsage(); });
$("#usage-refresh").addEventListener("click", () => loadUsage());
// BUILD-01 F2 follow-up: any member can take the readable export with them.
// The client fetches it with the room headers and the page hands the file to
// the browser; the server decides who may export (the same check as JSONL).
let exportRequest = 0;
async function exportRoomHtml() {
  if (!state || !client.session) return;
  const request = ++exportRequest, button = $("#record-export-html"), status = $("#record-export-status");
  button.disabled = true; status.textContent = "Preparing the export…";
  try {
    const { blob, filename } = await client.exportHtml();
    if (request !== exportRequest || !state) return;
    const url = URL.createObjectURL(blob), link = document.createElement("a");
    link.href = url; link.download = filename; link.hidden = true;
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    status.textContent = `Download started: ${filename}. Deleted messages appear as deleted, as members saw them.`;
  } catch (error) {
    if (request !== exportRequest || !state) return;
    status.textContent = error.status === 429 ? "Export is rate limited; try again in a minute."
      : error.status === 403 ? "Only the room owner can export this room."
      : "The export could not be prepared. Try again.";
  } finally { if (request === exportRequest) button.disabled = false; }
}
$("#record-export-html").addEventListener("click", () => exportRoomHtml());
$("#topbar-catchup").addEventListener("click", () => { if (state && !busy) openCatchUp(); });
$("#sidebar-toggle").addEventListener("click", () => {
  const shell = $("#main"), open = shell.classList.toggle("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", String(open));
  if (!open) return;
  // The drawer covers this button on a phone, so focus has to move into it.
  // The single-conversation view hides the channel list, and focus() on a
  // hidden node is a silent no-op, so fall back to the first visible control.
  const sidebar = $("#room-sidebar"), shown = node => Boolean(node?.getClientRects().length);
  const active = sidebar.querySelector(".channel.is-active");
  (shown(active) ? active : [...sidebar.querySelectorAll("button:not([disabled]),summary,a[href]")].find(shown))?.focus();
});
document.addEventListener("click", event => {
  const shell = $("#main");
  if (!shell.classList.contains("sidebar-open")) return;
  if (event.target.closest("#room-sidebar") || event.target.closest("#sidebar-toggle")) return;
  // Every dialog opens modal, so a dialog sits in the top layer above the inert
  // sidebar overlay: clicks inside it are dialog interactions, not "outside"
  // clicks. Dismissing the sidebar under them hides the dialog trigger while it
  // still holds restored focus, dropping focus to <body> on mobile.
  // The path is fixed at dispatch, so a dialog choice whose handler already
  // re-rendered the menu (detaching the target) still counts as inside it.
  if (event.target.closest("dialog") || event.composedPath().some(node => node.nodeName === "DIALOG")) return;
  shell.classList.remove("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", "false");
});
document.addEventListener("keydown", event => {
  if (event.key !== "Escape") return;
  // Let an open modal dialog consume Escape itself: its native close restores
  // focus to the trigger, which the sidebar dismissal below would strand the
  // same way the click path did.
  if (document.querySelector("dialog[open]")) return;
  const shell = $("#main");
  if (!shell.classList.contains("sidebar-open")) return;
  shell.classList.remove("sidebar-open");
  $("#sidebar-toggle").setAttribute("aria-expanded", "false");
  $("#sidebar-toggle").focus();
});
// Native disclosure keeps secondary navigation out of the default chat surface.
// Focus the visible summary before opening a modal, so closing it never returns
// focus to a button that became hidden inside the collapsed disclosure.
const roomMore = $("#room-more");
function closeRoomMore(restoreFocus = false) {
  roomMore.open = false;
  if (restoreFocus) roomMore.querySelector("summary").focus({ preventScroll: true });
}
roomMore.addEventListener("click", event => {
  if (event.target.closest("button:not(:disabled)")) closeRoomMore(true);
}, true);
roomMore.addEventListener("keydown", event => {
  if (event.key !== "Escape" || !roomMore.open) return;
  event.preventDefault(); event.stopPropagation(); closeRoomMore(true);
});
document.addEventListener("click", event => {
  if (roomMore.open && !roomMore.contains(event.target)) closeRoomMore();
});
function closeSecondaryBoards() {
  $("#land-queue-panel").open = false;
  $("#referral-panel").open = false;
}
$("#settings-dialog").addEventListener("close", closeSecondaryBoards);
$("#settings-dialog").addEventListener("cancel", closeSecondaryBoards);
$("#advanced-room-tools").addEventListener("toggle", event => {
  if (!event.currentTarget.open) closeSecondaryBoards();
});
$("#topbar-settings").addEventListener("click", () => openSettings());
$("#room-results-open").addEventListener("click", () => {
  if (!state || !session || busy) return;
  selectWorkView("results");
});
$("#catchup-close").addEventListener("click", () => $("#catchup-dialog").close());
$("#settings-close").addEventListener("click", () => { closeSecondaryBoards(); $("#settings-dialog").close(); });
$("#topbar-search-toggle").addEventListener("click", () => {
  const form = $("#search-form"), show = form.hidden;
  form.hidden = !show;
  $("#topbar-search-toggle").setAttribute("aria-expanded", String(show));
  if (show) $("#message-search").focus();
  else { $("#message-search").value = ""; renderSearch(Date.now()); }
});
$("#rb-refresh-button").addEventListener("click", () => { briefReconcileNote = ""; return loadReturnBrief(); });
$("#rb-more-button").addEventListener("click", async () => {
  const chain = briefView.chain, firstNewHistoryIndex = briefView.brief?.history.items.length ?? 0;
  const pagingButtonFocused = document.activeElement === $("#rb-more-button");
  await briefView.more();
  if (pagingButtonFocused && briefView.owns(chain) && briefView.brief && !briefView.brief.history.hasMore
      && (document.activeElement === document.body || document.activeElement === $("#rb-more-button"))) {
    focusRecord($("#rb-history-list").querySelectorAll("[data-brief-key]")[firstNewHistoryIndex] || $("#rb-ack-button"));
  }
});
$("#rb-ack-button").addEventListener("click", () => { briefReconcileNote = ""; return briefView.acknowledge(); });
$("#rb-show-all").addEventListener("click", () => { showAllAttention = !showAllAttention; renderReturnBrief(); });
document.addEventListener("visibilitychange", renderReturnBrief);
shareLinksUI = installShareLinks({ client, accountClient,
  canLeaveAccountSignin: () => signinUI.canLeave(),
  onOAuthStart: stashInviteForOAuth,
  onAccountSignin: mode => {
    // One sign-in controller and form, hosted in the invitation while needed.
    $(mode ? "#join-account-methods" : "#signin-controller").prepend($("#auth-signin-ui"));
    if (mode) signinUI.showPassword();
    else clearPendingJoin(window.sessionStorage);
  },
  getState: () => state, getSession: () => session, setConnectionStatus,
  listPurposes: () => Object.values(state?.workItems ?? {}).map(item => ({ id: item.id, title: item.title,
    done: ["complete", "superseded"].includes(nextWorkStep(item).action) })),
  onJoinedRoom: focus => {
    if (focus.kind === "work" && state?.workItems[focus.id]) {
      revealWork(focus.id);
      notice(`This invitation opens "${state.workItems[focus.id].title}".`);
    } else if (focus.kind === "message" && conversation.byId.has(focus.id)) {
      revealMessage(focus.id);
    } else {
      notice("The item this invitation pointed to is no longer in this room.");
    }
  },
  async openRoom(roomId, roomMode, joinedSession) {
    if (state && session?.roomId === roomId && session.member.id === joinedSession?.member?.id
      && session.account?.id === joinedSession.account?.id && session.sessionBinding === joinedSession.sessionBinding) {
      await client.refresh();
      if (!state || !session) throw new Error("Room access changed. Reopen the invitation.");
      return;
    }
    accessEndContext = "accepted-room-switch";
    client.endAccess();
    history.replaceState(history.state, "", roomMode ? location.pathname : roomHandoffLocation(roomId));
    configureAuthPanel(roomMode ? null : roomId);
    const restored = await client.restore(roomMode ? null : roomId);
    if (!restored) throw new Error("Browser identity changed. Reopen the invitation.");
    inboxUI.showRooms();
  }
});
configureAuthPanel();
// RC-2026-09-19-088: surface OAuth callback failures with an actionable
// message instead of silently returning to the sign-in screen. The query
// param is cleared so a refresh doesn't re-show the banner.
{
  const params = new URLSearchParams(location.search);
  const failedProvider = params.get("google") === "error" ? "Google"
    : params.get("github") === "error" ? "GitHub" : null;
  if (failedProvider) {
    setFormStatus($("#auth-link-error"),
      `${failedProvider} sign-in didn't complete. ${failedProvider === "Google" ? "Try again with the button below, or" : "Please"} sign in another way.`, true);
    history.replaceState(history.state, "", location.pathname);
  }
}
if (initialInvitationFragment && !initialInvitationFragment.redirect && !initialPasswordReset) openInvitation(initialInvitationFragment);
(async () => {
  const initialResult = await initialSignin;
  if (initialResult?.pendingPasswordReset) {
    resetJourneyPending = true;
    $("#auth-panel").hidden = false;
    signinUI.focus();
    return;
  }
  if (startRoomFlight) await startRoomFlight;
  // Emailed-link authentication already owns its landing, including a newly
  // created room. Do not restore a second session over that completed journey.
  if (state) return;
  if (initialJoinFragment) {
    // Invitation preview deliberately does not restore/open a Room session.
    // Do not leave the initial session/connection progress labels running.
    $("#identity-label").textContent = "Room not open";
    setConnectionStatus("Not connected · invitation preview");
    await shareLinksUI.open(initialJoinFragment);
    if (initialGoogleFailed) setFormStatus($("#join-link-status"), googleSigninFailureMessage, true);
    return;
  }
  const requestedRoom = selectedRoomFromLocation();
  if (requestedRoom || accountHomeFromLocation() || new URLSearchParams(location.search).get("oauth") === "login") {
    // Join-flow sessions are room-cookie sessions with no account behind
    // them — the /join page's "Open room" link lands here with a valid
    // __Host-room_session cookie but no account session. Try the room
    // cookie before the account gate, or a fresh joiner is stranded at the
    // sign-in panel despite holding a working session. A cookie for a
    // different room is dropped and the account flow decides as before.
    if (requestedRoom && !accountHomeFromLocation()) {
      try {
        const joined = await client.restore();
        if (joined?.roomId === requestedRoom) return;
        client.endAccess();
      } catch (error) {
        if (![401, 403].includes(error.status)) throw error;
      }
    }
    const account = await ensureAccountSession();
    if (!account?.authenticated) {
      if (initialDesktopProvider && !initialGoogleFailed && !initialGitHubFailed) {
        const provider = initialDesktopProvider;
        initialDesktopProvider = null;
        location.assign(`/api/auth/${provider}/start`);
        return;
      }
      $("#identity-label").textContent = "Not signed in";
      setFormStatus($("#auth-error"), initialGoogleFailed
        ? googleSigninFailureMessage
        : initialGitHubFailed
        ? "GitHub sign-in didn't finish — it may have been cancelled, or GitHub declined the request. Try again, or sign in another way."
        : "");
      setConnectionStatus("Not connected · account sign-in required");
      configureAuthPanel();
      $("#auth-panel").hidden = false;
      // Q3-C: the skip link is the first stop. Don't move focus past it.
      return;
    }
    if (!requestedRoom) showAccountWorkspace();
    else {
      try { await client.restore(requestedRoom); }
      catch (error) {
        if (![401, 403].includes(error.status)) throw error;
        showAccountWorkspace();
        showRoomAccessNotice();
      }
    }
    return;
  }
  // QAU-006: only probe for a session when a browser hint says one could
  // exist. A signed-out first paint with no remembered room or account hint
  // would 401 the GET /api/session probe, and the browser surfaces that as a
  // console error on the welcome screen — so skip the probe and render the
  // signed-out state directly.
  if (hasSessionHint()) {
    // Q3-C: /api/account-session answers 200 when nobody is signed in.
    // GET /api/session is a 401 the browser logs once the room cookie is gone,
    // so that probe runs only when this browser still names a room.
    let account = null;
    try { account = await ensureAccountSession(); } catch { account = null; }
    if (account?.authenticated) {
      const opened = await openRememberedRoomOrInbox();
      if (opened) return;
      syncSessionMenu();
      return;
    }
    if (readLastRoom()) {
      try {
        await client.restore();
        return;
      } catch (error) {
        if (![401, 403].includes(error.status)) throw error;
      }
    }
  }
  syncSessionMenu();
  throw Object.assign(new Error("sign in required"), { status: 401 });
})().catch(error => {
  if (accountClient.session?.authenticated && [401, 403].includes(error.status)) {
    showAccountWorkspace();
    if (selectedRoomFromLocation()) showRoomAccessNotice();
    confirmAccount();
    return;
  }
  const signedOut = [401, 403].includes(error.status);
  if (signedOut) recovery.clear();
  const requestedRoom = selectedRoomFromLocation();
  const deletedNotice = initialAccountDeleted && signedOut && !requestedRoom ? ACCOUNT_DELETED_MESSAGE : "";
  setFormStatus($("#auth-error"), deletedNotice
    ? deletedNotice
    : initialGoogleFailed
    ? googleSigninFailureMessage
    : initialGitHubFailed
    ? "GitHub sign-in didn't finish — it may have been cancelled, or GitHub declined the request. Try again, or sign in another way."
    : signedOut
    ? requestedRoom ? `This account cannot open #${requestedRoom}. Use an account with active membership there.` : ""
    : unreachableRoomMessage(error), !deletedNotice);
  setConnectionStatus(signedOut ? "Not connected · sign in required" : "Room service unavailable · not connected");
  $("#identity-label").textContent = signedOut ? "Not signed in" : "Session unavailable";
  $("#auth-panel").hidden = false;
  // Q3-C: leave focus at the top so the first Tab stop is the skip link.
});
// --- W board: Tasks › Board. The command palette opens Board. ---
{
  const board = lazyDisclosure({ panel: $("#board-panel"),
    load: () => import("./board-ui.js"),
    // JDOT-COH-NAV begin
    install: module => {
      const controller = module.installWorkBoard({ client, getState: () => state, getSession: () => session });
      // BU-14: power-user keyboard navigation (j/k moves between claim cards).
      // Separate dynamic import so board-keyboard.mjs is its own registered
      // runtime asset; attach is idempotent and survives board repaints.
      import("./board-keyboard.mjs").then(keynav => keynav.attachBoardKeyboard(document.querySelector("#work-board")))
        .catch(() => { /* keyboard nav is progressive enhancement; the board works without it */ });
      navigationBoardReady = () => controller.whenReady();
      return controller;
    },
    // JDOT-COH-NAV end
    onError: () => notice("Could not load the board. Close and reopen to retry.", true) });
  // JDOT-COH-NAV begin
  resetNavigationBoard = () => { $("#board-dialog").close(); $("#board-panel").open = false; board.reset(); };
  // JDOT-COH-NAV end
  const openBoard = () => {
    // JDOT-COH-NAV begin
    navigationBoardEpoch++;
    // JDOT-COH-NAV end
    const dialog = $("#board-dialog");
    if (!dialog.open) dialog.showModal();
    $("#board-panel").open = true;
    board.sync();
  };
  $("#tasks-board-open").addEventListener("click", openBoard);
  // JDOT-COH-NAV begin
  $("#board-close").addEventListener("click", () => { navigationBoardEpoch++; $("#board-dialog").close(); $("#board-panel").open = false; });
  $("#board-dialog").addEventListener("cancel", () => { navigationBoardEpoch++; });
  $("#board-panel").addEventListener("toggle", () => { if (!$("#board-panel").open) navigationBoardEpoch++; });
  // JDOT-COH-NAV end
  $("#signout-button").addEventListener("click", () => { $("#board-dialog").close(); board.reset(); }, true);
  const priorEntries = roomActionEntries;
  roomActionEntries = () => priorEntries().map(entry => entry.id === "landing"
    ? { id: "board", label: "Board", words: "tasks board claims ci review lease land", always: true } : entry);
  const priorChoose = chooseRoomAction;
  // JDOT-COH-NAV begin
  chooseRoomAction = id => { if (id === "board") { closeRoomActions(false); openBoard(); return; } priorChoose(id); };
  // JDOT-COH-NAV end
  const paintChat = () => { if (state) paintClaimChat(state, $("#message-list")); };
  const priorRender = render;
  render = () => { if (!state) { board.reset(); return; } priorRender(); board.sync(); };
  const priorMessages = renderMessages;
  renderMessages = () => { priorMessages(); paintChat(); };
}
// --- plan-squads: Squads panel. Read-only roster UI, lazy-loaded. ---
{
  const squadsPanel = lazyDisclosure({ panel: $("#squads-dialog"),
    load: () => import("./squads-ui.js"),
    install: module => module.installSquadsPanel({ client, getState: () => state, getSession: () => session }),
    onError: () => notice("Could not load squads. Close and reopen to retry.", true) });
  const openSquads = () => {
    const dialog = $("#squads-dialog");
    if (!dialog.open) dialog.showModal();
    squadsPanel.sync();
  };
  $("#squads-open").addEventListener("click", openSquads);
  $("#squads-close").addEventListener("click", () => { $("#squads-dialog").close(); });
  $("#signout-button").addEventListener("click", () => { $("#squads-dialog").close(); squadsPanel.reset(); }, true);
  const priorSquadsRender = render;
  render = () => { if (!state) { squadsPanel.reset(); return; } priorSquadsRender(); squadsPanel.sync(); };
}
// --- end W board ---

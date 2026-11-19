import type { CollabPeer, EditRequestState } from "../collab/CollabSession";

/** Shared Allow / Deny pair used by the request bar and the participant list. */
export function EditRequestButtons({
  peer,
  onAllow,
  onDeny,
}: {
  peer: CollabPeer;
  onAllow: (clientId: string) => void;
  onDeny: (clientId: string) => void;
}) {
  const name = peer.username ?? "participant";
  return (
    <span className="role-actions">
      <button
        type="button"
        className="icon-btn icon-btn--primary"
        onClick={() => onAllow(peer.clientId)}
        aria-label={`Let ${name} edit`}
        data-testid="edit-allow"
      >
        Allow
      </button>
      <button
        type="button"
        className="icon-btn"
        onClick={() => onDeny(peer.clientId)}
        aria-label={`Decline ${name}'s request`}
        data-testid="edit-deny"
      >
        Deny
      </button>
    </span>
  );
}

/** Host: pending "asked to edit" requests, shown above the canvas. */
export function EditRequestBar({
  peers,
  onAllow,
  onDeny,
}: {
  peers: CollabPeer[];
  onAllow: (clientId: string) => void;
  onDeny: (clientId: string) => void;
}) {
  const pending = peers.filter((p) => p.requestedEdit);
  if (pending.length === 0) return null;
  return (
    <div className="role-bars">
      {pending.map((p) => (
        <div key={p.clientId} className="role-bar" role="status" data-testid="edit-request">
          <span className="role-bar__text">
            <strong>{p.username ?? "A participant"}</strong> wants to edit this drawing.
          </span>
          <EditRequestButtons peer={p} onAllow={onAllow} onDeny={onDeny} />
        </div>
      ))}
    </div>
  );
}

const VIEWER_TEXT: Record<EditRequestState, string> = {
  none: "You're viewing this drawing.",
  pending: "Asked the host for edit access…",
  denied: "The host declined your request to edit.",
};

/** Viewer: read-only notice with "Ask to edit". */
export function ViewerBar({
  state,
  onRequest,
}: {
  state: EditRequestState;
  onRequest: () => void;
}) {
  return (
    <div className="role-bar" role="status" data-testid="viewer-bar">
      <span className="role-bar__text">{VIEWER_TEXT[state]}</span>
      {state === "pending" ? null : (
        <span className="role-actions">
          <button
            type="button"
            className="icon-btn icon-btn--primary"
            onClick={onRequest}
            data-testid="ask-to-edit"
          >
            {state === "denied" ? "Ask again" : "Ask to edit"}
          </button>
        </span>
      )}
    </div>
  );
}

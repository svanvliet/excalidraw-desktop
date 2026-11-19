import type { CollabPeer } from "../collab/CollabSession";
import type { Role } from "../collab/protocol";
import { EditRequestButtons } from "./RoleBar";

export interface ParticipantListProps {
  selfName: string;
  selfRole: Role;
  peers: CollabPeer[];
  /** Host only: shows a Remove button per peer. */
  onRemove?: (clientId: string) => void;
  /** Host only: shows Make editor / Make viewer per peer. */
  onSetRole?: (clientId: string, role: "editor" | "viewer") => void;
  /** Host only: declines a pending edit request (Allow uses `onSetRole`). */
  onDeny?: (clientId: string) => void;
  /** Peers with a remove / role change in flight. */
  busy?: ReadonlySet<string>;
}

const STATE_LABEL: Record<CollabPeer["userState"], string | null> = {
  active: null,
  idle: "idle",
  away: "away",
};

export function ParticipantList({
  selfName,
  selfRole,
  peers,
  onRemove,
  onSetRole,
  onDeny,
  busy,
}: ParticipantListProps) {
  return (
    <ul className="people" data-testid="participants">
      <li className="people__row">
        <span className="people__name">{selfName}</span>
        <span className="people__tag" data-testid="self-role">
          you · {selfRole}
        </span>
      </li>
      {peers.map((p) => {
        const state = STATE_LABEL[p.userState];
        const pending = busy?.has(p.clientId) ?? false;
        const name = p.username ?? "participant";
        const manage = !p.isHost && (onRemove || onSetRole);
        return (
          <li key={p.clientId} className="people__row" data-testid="participant">
            <span className="people__name">{p.username ?? "Joining…"}</span>
            <span className="people__tag" data-testid="participant-role">
              {p.role}
            </span>
            {state ? <span className="people__tag">{state}</span> : null}
            {p.requestedEdit ? (
              <span className="people__tag people__tag--accent">wants to edit</span>
            ) : null}
            {manage ? (
              <span className="people__actions">
                {p.requestedEdit && onSetRole && onDeny ? (
                  <EditRequestButtons
                    peer={p}
                    onAllow={(id) => onSetRole(id, "editor")}
                    onDeny={onDeny}
                  />
                ) : onSetRole ? (
                  <button
                    type="button"
                    className="icon-btn"
                    disabled={pending}
                    onClick={() => onSetRole(p.clientId, p.role === "editor" ? "viewer" : "editor")}
                    aria-label={p.role === "editor" ? `Make ${name} a viewer` : `Let ${name} edit`}
                    data-testid="toggle-role"
                  >
                    {p.role === "editor" ? "Make viewer" : "Make editor"}
                  </button>
                ) : null}
                {onRemove ? (
                  <button
                    type="button"
                    className="icon-btn icon-btn--danger"
                    disabled={pending}
                    onClick={() => onRemove(p.clientId)}
                    aria-label={`Remove ${name}`}
                  >
                    Remove
                  </button>
                ) : null}
              </span>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

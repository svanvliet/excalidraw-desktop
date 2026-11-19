import type { CollabPeer } from "../collab/CollabSession";

export interface ParticipantListProps {
  selfName: string;
  selfIsHost: boolean;
  peers: CollabPeer[];
  /** Host only: shows a Remove button per peer. */
  onRemove?: (clientId: string) => void;
  /** Peers whose removal is in flight. */
  removing?: ReadonlySet<string>;
}

const STATE_LABEL: Record<CollabPeer["userState"], string | null> = {
  active: null,
  idle: "idle",
  away: "away",
};

export function ParticipantList({
  selfName,
  selfIsHost,
  peers,
  onRemove,
  removing,
}: ParticipantListProps) {
  return (
    <ul className="people" data-testid="participants">
      <li className="people__row">
        <span className="people__name">{selfName}</span>
        <span className="people__tag">{selfIsHost ? "you · host" : "you"}</span>
      </li>
      {peers.map((p) => {
        const state = STATE_LABEL[p.userState];
        const busy = removing?.has(p.clientId) ?? false;
        return (
          <li key={p.clientId} className="people__row" data-testid="participant">
            <span className="people__name">{p.username ?? "Joining…"}</span>
            {p.isHost ? <span className="people__tag">host</span> : null}
            {state ? <span className="people__tag">{state}</span> : null}
            {onRemove && !p.isHost ? (
              <button
                type="button"
                className="icon-btn icon-btn--danger people__remove"
                disabled={busy}
                onClick={() => onRemove(p.clientId)}
                aria-label={`Remove ${p.username ?? "participant"}`}
              >
                {busy ? "Removing…" : "Remove"}
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

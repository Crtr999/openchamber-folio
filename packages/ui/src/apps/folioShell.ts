import React from 'react';

/**
 * Present only when the OpenChamber mobile UI runs inside the standalone Folio iPhone app.
 * It lets the chat screens hand the user back to their notes, fall back to the offline phone
 * chat when the Mac can't be reached, and receive pairing links opened from the Camera app.
 */
export interface FolioShell {
  onOpenNotes: () => void;
  onOfflineChat: () => void;
  pendingConnectLink?: string;
  consumeConnectLink: () => void;
  /** Asks the Mac (over the notes pairing) for a one-time link that connects the chats; it arrives as pendingConnectLink. */
  requestConnectLink?: () => void;
}

export const FolioShellContext = React.createContext<FolioShell | null>(null);
export const useFolioShell = (): FolioShell | null => React.useContext(FolioShellContext);

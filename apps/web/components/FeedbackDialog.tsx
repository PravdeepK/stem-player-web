import type { FeedbackType } from "@stem-player-web/core";

export interface FeedbackDialogProps {
  // The form to show, or null while the dialog is closed.
  type: FeedbackType | null;
  onClose: () => void;
}

export default function FeedbackDialog(_props: FeedbackDialogProps) {
  return null;
}

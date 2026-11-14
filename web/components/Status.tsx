// A status word with its icon. Color never carries meaning alone.
import { CheckCircle, Clock, Lock, Pause, Question, Spinner, XCircle } from "@phosphor-icons/react/ssr";
import { STATUS_TEXT, type Status } from "@/lib/tiers";

const ICON = { open: CheckCircle, cooling: Clock, releasing: Spinner, drained: Lock, paused: Pause, not_launched: XCircle, unknown: Question } as const;

export function StatusLabel({ status, extra, testId }: { status: Status; extra?: React.ReactNode; testId?: string }) {
  const I = ICON[status];
  return (
    <span className={`status ${status}`} data-testid={testId}>
      <I size={18} weight="bold" aria-hidden="true" />
      <span>{STATUS_TEXT[status]}</span>
      {extra}
    </span>
  );
}

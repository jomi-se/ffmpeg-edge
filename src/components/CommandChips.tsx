import { useCallback, useEffect, useRef, useState } from "react";
import {
  AudioLines,
  Clock,
  Film,
  FileOutput,
  Flag,
  Gauge,
  Hash,
  Lock,
  Music,
  Palette,
  Ruler,
  Timer,
  Type,
  Wand2,
  Zap,
  type LucideIcon,
} from "lucide-react";
import {
  chipControlFor,
  flagLabel,
  parseCommandLine,
  splitChipToken,
  validateCommandArgs,
  type CommandChip,
} from "../lib/command";

interface CommandChipsProps {
  chips: CommandChip[];
  args: string[];
  fileName: string;
  disabled?: boolean;
  onChange: (nextArgs: string[]) => void;
}

function chipIcon(chip: CommandChip): LucideIcon {
  if (chip.kind === "input") return Lock;
  if (chip.kind === "output") return FileOutput;

  const { flag } = splitChipToken(chip.token);
  switch (flag) {
    case "-c:v":
    case "-codec:v":
    case "-r":
      return Film;
    case "-c:a":
    case "-codec:a":
    case "-ar":
    case "-ac":
      return Music;
    case "-vf":
    case "-filter:v":
      return Wand2;
    case "-af":
    case "-filter:a":
      return AudioLines;
    case "-crf":
    case "-q:v":
    case "-q:a":
    case "-b:v":
    case "-b:a":
      return Gauge;
    case "-preset":
      return Zap;
    case "-ss":
      return Clock;
    case "-t":
    case "-to":
      return Timer;
    case "-f":
      return Type;
    case "-s":
      return Ruler;
    case "-pix_fmt":
      return Palette;
    default:
      return chip.kind === "flag" ? Flag : Hash;
  }
}

/** What the chip face shows: a clean label and a value (value may be empty). */
function chipDisplay(chip: CommandChip): { label: string; value: string } {
  const { flag, value } = splitChipToken(chip.token);
  if (chip.kind === "input") return { label: "Source", value: chip.token };
  if (chip.kind === "output") return { label: "Output", value: chip.token };
  if (flag) return { label: flagLabel(flag), value };
  if (chip.token.startsWith("-")) {
    return { label: flagLabel(chip.token), value: "" };
  }
  return { label: "Value", value: chip.token };
}

export function CommandChips({
  chips,
  args,
  fileName,
  disabled,
  onChange,
}: CommandChipsProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);

  const popoverRef = useRef<HTMLDivElement>(null);
  const fieldRef = useRef<HTMLInputElement | HTMLSelectElement | null>(null);
  const triggers = useRef(new Map<string, HTMLButtonElement>());
  const flashTimer = useRef<number | undefined>(undefined);

  // Briefly confirm the chip whose value just changed.
  useEffect(() => () => window.clearTimeout(flashTimer.current), []);

  const activeChip = chips.find((chip) => chip.id === activeId) ?? null;
  const control = activeChip ? chipControlFor(activeChip) : null;

  const close = useCallback(() => {
    const popover = popoverRef.current;
    if (popover?.matches(":popover-open")) popover.hidePopover();
    setActiveId((current) => {
      if (current) triggers.current.get(current)?.focus();
      return null;
    });
    setError(null);
  }, []);

  function openChip(chip: CommandChip) {
    if (!chip.editable || disabled) return;
    const next = chipControlFor(chip);
    setDraft(next.wholeToken ? chip.token : next.value);
    setError(null);
    setActiveId(chip.id);
  }

  function apply() {
    if (!activeChip || !control) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Value can't be empty.");
      return;
    }
    const replacement = control.wholeToken
      ? trimmed
      : `${control.flag} ${trimmed}`;
    const index = Number(activeChip.id.split("-")[0]);
    const next = [...args];
    const replacesPair =
      activeChip.token.includes(" ") && next[index + 1] !== undefined;
    next.splice(index, replacesPair ? 2 : 1, ...parseCommandLine(replacement));

    const check = validateCommandArgs(next, fileName);
    if (!check.ok) {
      setError(check.errors[0]);
      return;
    }
    onChange(next);
    // The regenerated chip for this slot keeps its index; flash it on land.
    setFlashId(`${index}-${replacement}`);
    window.clearTimeout(flashTimer.current);
    flashTimer.current = window.setTimeout(() => setFlashId(null), 700);
    close();
  }

  // Open + position the popover under its trigger whenever the active chip changes.
  useEffect(() => {
    const popover = popoverRef.current;
    const trigger = activeId ? triggers.current.get(activeId) : null;
    if (!popover || !trigger) return;

    if (!popover.matches(":popover-open")) popover.showPopover();

    const rect = trigger.getBoundingClientRect();
    const box = popover.getBoundingClientRect();
    const gap = 6;
    let left = Math.min(rect.left, window.innerWidth - box.width - 8);
    left = Math.max(8, left);
    let top = rect.bottom + gap;
    if (top + box.height > window.innerHeight - 8) {
      top = Math.max(8, rect.top - box.height - gap);
    }
    popover.style.left = `${left}px`;
    popover.style.top = `${top}px`;

    const frame = requestAnimationFrame(() => fieldRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [activeId]);

  // Keep React state in sync when the popover light-dismisses (outside click / Esc).
  useEffect(() => {
    const popover = popoverRef.current;
    if (!popover) return;
    const onToggle = (event: Event) => {
      if ((event as ToggleEvent).newState === "closed") {
        setActiveId(null);
        setError(null);
      }
    };
    popover.addEventListener("toggle", onToggle);
    return () => popover.removeEventListener("toggle", onToggle);
  }, []);

  const preview =
    control &&
    (control.wholeToken ? draft.trim() : `${control.flag} ${draft.trim()}`);

  return (
    <>
      <div className="chip-grid">
        {chips.map((chip) => {
          const Icon = chipIcon(chip);
          const { label, value } = chipDisplay(chip);
          const locked = !chip.editable;
          return (
            <button
              key={chip.id}
              ref={(el) => {
                if (el) triggers.current.set(chip.id, el);
                else triggers.current.delete(chip.id);
              }}
              type="button"
              className="chip"
              data-locked={locked || undefined}
              data-active={activeId === chip.id || undefined}
              data-flash={chip.id === flashId || undefined}
              disabled={locked || disabled}
              aria-haspopup="dialog"
              aria-expanded={activeId === chip.id}
              title={locked ? "Set automatically" : `Edit ${label}`}
              onClick={() => openChip(chip)}
            >
              <Icon className="chip-icon" size={14} aria-hidden="true" />
              <span className="chip-label">{label}</span>
              {value && <span className="chip-value">{value}</span>}
            </button>
          );
        })}
      </div>

      <div
        ref={popoverRef}
        popover="auto"
        className="chip-pop"
        role="dialog"
        aria-label={
          activeChip ? `Edit ${chipDisplay(activeChip).label}` : undefined
        }
      >
        {activeChip && control && (
          <>
            <div className="chip-pop-head">
              <span className="chip-pop-title">
                {chipDisplay(activeChip).label}
              </span>
              {control.hint && (
                <span className="chip-pop-hint">{control.hint}</span>
              )}
            </div>

            {control.type === "slider" && (
              <div className="chip-pop-slider">
                <input
                  ref={(el) => {
                    fieldRef.current = el;
                  }}
                  type="range"
                  min={control.min}
                  max={control.max}
                  step={control.step}
                  value={draft}
                  aria-label={chipDisplay(activeChip).label}
                  onChange={(event) => setDraft(event.target.value)}
                />
                <output className="chip-pop-readout">{draft}</output>
              </div>
            )}

            {control.type === "select" && (
              <select
                ref={(el) => {
                  fieldRef.current = el;
                }}
                className="chip-pop-field"
                value={draft}
                aria-label={chipDisplay(activeChip).label}
                onChange={(event) => setDraft(event.target.value)}
              >
                {control.options?.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            )}

            {(control.type === "text" || control.type === "time") && (
              <input
                ref={(el) => {
                  fieldRef.current = el;
                }}
                type="text"
                className="chip-pop-field"
                inputMode={control.inputMode}
                placeholder={control.placeholder}
                value={draft}
                aria-label={chipDisplay(activeChip).label}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    apply();
                  }
                }}
              />
            )}

            <code className="chip-pop-preview">{preview}</code>

            {error && <p className="chip-pop-error">{error}</p>}

            <div className="chip-pop-actions">
              <button type="button" className="chip-pop-cancel" onClick={close}>
                Cancel
              </button>
              <button type="button" className="chip-pop-apply" onClick={apply}>
                Apply
              </button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

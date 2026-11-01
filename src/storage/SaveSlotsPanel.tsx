import React from "react";
import { ArrowCounterClockwise, FloppyDisk, Trash } from "@phosphor-icons/react";
import { type SaveSlot, createSaveSlot, deleteSaveSlot, listSaveSlots, restoreSaveSlot } from "./save-slots";
import { formatBytes } from "../storage-manager";
import { SettingsIconBtn } from "../settings/SettingsIconBtn";
import s from "./StorageManagerBody.module.css";
import hm from "../ui/Hint/Hint.module.css";
import bm from "../ui/Button/Button.module.css";

interface Props {
  containerDir: string;
  /** A game page is open, so a guest may hold this container's files. */
  locked: boolean;
  onChanged: () => void;
}

export default function SaveSlotsPanel({ containerDir, locked, onChanged }: Props): React.ReactElement {
  const [slots, setSlots] = React.useState<SaveSlot[] | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    try { setSlots(await listSaveSlots(containerDir)); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
  }, [containerDir]);

  React.useEffect(() => { void reload(); }, [reload]);

  const run = async (op: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try { await op(); }
    catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally {
      await reload();
      onChanged();
      setBusy(false);
    }
  };

  return (
    <div className={s["slots"]}>
      {locked && <p className={hm["hint"]}>Close the running game to create or load a slot: it holds these files open.</p>}
      <button
        className={bm["btn"]}
        disabled={busy || locked}
        onClick={() => {
          const name = prompt("Name for this save slot:", "");
          if (name === null) return;
          void run(async () => { await createSaveSlot(containerDir, name); });
        }}
      >
        <FloppyDisk size={14} aria-hidden /> Save current progress to a new slot
      </button>
      {slots !== null && slots.length === 0 && <p className={hm["hint"]}>No slots yet.</p>}
      {slots?.map((slot) => (
        <div className={s["slot"]} key={slot.id}>
          <div>
            <div className={s["glist__name"]}>{slot.name}</div>
            <div className={s["glist__sub"]}>
              {new Date(slot.createdAt).toLocaleString()} · {slot.fileCount} file{slot.fileCount === 1 ? "" : "s"}
            </div>
          </div>
          <span className={s["glist__sz"]}>{formatBytes(slot.bytes)}</span>
          <div className={s["glist__actions"]}>
            <SettingsIconBtn
              icon={ArrowCounterClockwise}
              title="Load this slot"
              disabled={busy || locked}
              onClick={() => {
                const note = slot.auto ? "" : " Your current progress is kept in the “Before last restore” slot.";
                if (!confirm(`Load “${slot.name}”? Current saves and settings are replaced.${note}`)) return;
                void run(() => restoreSaveSlot(containerDir, slot.id));
              }}
            />
            <SettingsIconBtn
              icon={Trash}
              title="Delete this slot"
              danger
              disabled={busy}
              onClick={() => {
                if (!confirm(`Delete slot “${slot.name}”?`)) return;
                void run(() => deleteSaveSlot(containerDir, slot.id));
              }}
            />
          </div>
        </div>
      ))}
      {error && <p role="alert" className={hm["hint"]}>{error}</p>}
    </div>
  );
}

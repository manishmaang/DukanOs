import { useState } from 'react';
/** Each instance edits exactly one portion/cart line. Typing updates that line immediately. */
export function InstructionEditor({
  value,
  onChange,
  label,
  disabled = false,
}: {
  value: string;
  onChange: (value: string) => void;
  label: string;
  disabled?: boolean;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <div
      className={
        'instruction-control' +
        (editing ? ' is-editing' : value.trim() ? ' has-note' : '')
      }
    >
      {editing ? (
        <>
          <label>
            Kitchen instruction
            <textarea
              autoFocus
              aria-label={`Instruction for ${label}`}
              maxLength={500}
              rows={2}
              value={value}
              disabled={disabled}
              onChange={(e) => onChange(e.target.value)}
            />
          </label>
          <button
            className="secondary-control"
            disabled={disabled}
            onClick={() => {
              onChange(value.trim());
              setEditing(false);
            }}
          >
            Done
          </button>
        </>
      ) : value.trim() ? (
        <>
          <span className="instruction-text">Note: {value}</span>
          <button
            className="secondary-control"
            aria-label={`Edit instruction for ${label}`}
            disabled={disabled}
            onClick={() => setEditing(true)}
          >
            Edit
          </button>
          <button
            className="secondary-control"
            aria-label={`Remove instruction for ${label}`}
            disabled={disabled}
            onClick={() => onChange('')}
          >
            Remove note
          </button>
        </>
      ) : (
        <button
          className="secondary-control"
          aria-label={`Add instruction for ${label}`}
          disabled={disabled}
          onClick={() => setEditing(true)}
        >
          + Add instruction
        </button>
      )}
    </div>
  );
}

import { normalizeVoicePreset, TTS_PRESET_GROUPS, type TtsPreset } from "../types";

interface VoicePresetSelectProps {
  className: string;
  value: TtsPreset;
  disabled: boolean;
  onChange: (preset: TtsPreset) => void;
}

export function VoicePresetSelect({ className, value, disabled, onChange }: VoicePresetSelectProps) {
  return (
    <select
      aria-label="DJ voice preset"
      title="DJ voice preset"
      className={className}
      value={value}
      disabled={disabled}
      onChange={(event) => onChange(normalizeVoicePreset(event.currentTarget.value))}
    >
      {Object.entries(TTS_PRESET_GROUPS).map(([language, presets]) => (
        <optgroup key={language} label={language}>
          {presets.map((preset) => <option key={preset} value={preset}>{preset}</option>)}
        </optgroup>
      ))}
    </select>
  );
}

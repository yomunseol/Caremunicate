import { Mic, Video } from 'lucide-react';
import type { DeviceOption } from '../hooks/useCall';

// ---------------------------------------------------------------------------
// Microphone / camera pickers, shared by the green room and the in-call
// settings popover.
//
// The option text is whatever the browser reports for the device (already
// localised by the OS/browser), so no new i18n keys are invented here.
// ---------------------------------------------------------------------------

type CallDevicePickerProps = {
  mics: DeviceOption[];
  cams: DeviceOption[];
  micId: string | null;
  camId: string | null;
  onSelectMic: (deviceId: string) => void;
  onSelectCamera: (deviceId: string) => void;
  compact?: boolean;
};

export default function CallDevicePicker({
  mics,
  cams,
  micId,
  camId,
  onSelectMic,
  onSelectCamera,
  compact = false,
}: CallDevicePickerProps) {
  return (
    <div className={compact ? 'call-devices is-compact' : 'call-devices'}>
      <label className="call-device">
        <Mic size={15} aria-hidden="true" />
        <select
          className="call-device-select"
          value={micId ?? ''}
          aria-label={mics.find((device) => device.deviceId === micId)?.label ?? 'Microphone'}
          onChange={(event) => onSelectMic(event.target.value)}
        >
          {mics.length === 0 ? <option value="">—</option> : null}
          {mics.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>

      <label className="call-device">
        <Video size={15} aria-hidden="true" />
        <select
          className="call-device-select"
          value={camId ?? ''}
          aria-label={cams.find((device) => device.deviceId === camId)?.label ?? 'Camera'}
          onChange={(event) => onSelectCamera(event.target.value)}
        >
          {cams.length === 0 ? <option value="">—</option> : null}
          {cams.map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

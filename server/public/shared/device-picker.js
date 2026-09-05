// Shared by both client and studio pages — same reasoning as
// webrtc-link.js: one code path for both ends. Populates a pair of
// <select> elements with the browser's audio input/output devices.
//
// Device labels are blank until the origin holds an active mic
// permission grant, so this briefly opens (and immediately closes) a
// stream just to unlock them before enumerating.
export async function populateDeviceSelects({ inputSelect, outputSelect }) {
  const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  tempStream.getTracks().forEach((track) => track.stop());

  const devices = await navigator.mediaDevices.enumerateDevices();

  fillSelect(inputSelect, devices.filter((d) => d.kind === 'audioinput'), 'Microphone');

  const canSelectOutput = supportsOutputSelection();
  if (canSelectOutput) {
    outputSelect.disabled = false;
    fillSelect(outputSelect, devices.filter((d) => d.kind === 'audiooutput'), 'Speaker');
  } else {
    outputSelect.disabled = true;
    outputSelect.innerHTML = '<option value="">(not supported in this browser)</option>';
  }
}

export function supportsOutputSelection() {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

function fillSelect(select, deviceInfos, fallbackLabel) {
  select.innerHTML = '<option value="">(system default)</option>';
  deviceInfos.forEach((d, i) => {
    const opt = document.createElement('option');
    opt.value = d.deviceId;
    opt.textContent = d.label || `${fallbackLabel} ${i + 1}`;
    select.appendChild(opt);
  });
}

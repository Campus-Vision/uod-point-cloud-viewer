// This CHCNAV survey uses 8-bit RGB values inside 16-bit LAS colour dimensions.
// Expand only in the display buffer, preserving the original survey file.
export function expandSurveyColour(buffer) {
  for (let i = 0; i < buffer.length; i++) buffer[i] = Math.min(255, buffer[i]) * 257;
  return buffer;
}
